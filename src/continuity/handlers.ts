/**
 * CONTINUITY LAYER — operation handlers.
 *
 * Each handler runs inside the engine's transaction, after base authority,
 * lifecycle and version checks. It performs data-dependent checks, emits one
 * event per state change (ctx.emit) and updates the projections.
 */
import { PROTOCOL_VERSION, RESOURCE_LIMITS } from '../protocol/constants';
import { appliesTo, OPERATIONS_BY_NAME, type PAYLOADS, type PayloadOf } from '../protocol/operations';
import { formatTokId, type TokInput } from '../research/tok';
import { isOwner } from './authority';
import { canonicalHash } from './canonical';
import { AcspError, fail } from '../protocol/errors';
import { newCapability, newResourceId, pad3 } from './ids';
import type { OpContext } from './engine';
import { validatePayload } from './validate';
import {
  capabilityStatus,
  checkpointRecord,
  handoffRecord,
  iso,
  proposalRecord,
  tokRecord,
  type CapabilityRow,
  type HandoffRow,
  type Participant,
  type ProposalRow,
  type ResourceRow,
  type TokRow,
} from './records';
import { buildSnapshot, loadAnnotations, loadCheckpoint, loadToks, type Snapshot } from './state';
import { PROGRAM_001_HANDLERS } from './identity';

/** Who a record is attributed to: the actor directly, or a proposer via an accepted proposal. */
export interface Via {
  author: Participant;
  proposal_id: string | null;
  on_behalf_of: Participant | null;
}
export const direct = (ctx: OpContext): Via => ({ author: ctx.participant, proposal_id: null, on_behalf_of: null });

export type Result = Record<string, unknown>;
export type Handler<N extends keyof typeof PAYLOADS> = (
  ctx: OpContext,
  payload: PayloadOf<N>,
  via?: Via,
) => Promise<Result>;

// ── helpers ────────────────────────────────────────────────────────────────

async function findTok(ctx: OpContext, id: string): Promise<TokRow> {
  const { rows } = await ctx.sql.query<TokRow>('select * from toks where resource_id = $1 and id = $2', [ctx.resource.id, id]);
  if (!rows[0]) throw new AcspError('not_found', `Resource ${ctx.resource.id} has no ${id}.`);
  return rows[0];
}

async function checkRefs(ctx: OpContext, input: TokInput): Promise<void> {
  for (const ref of input.refs) {
    if ('tok' in ref) {
      const { rows } = await ctx.sql.query('select 1 from toks where resource_id = $1 and id = $2', [ctx.resource.id, ref.tok]);
      if (!rows[0]) fail('invalid_payload', `refs cites ${ref.tok}, which does not exist in this resource.`);
    }
  }
}

function allocateTokId(ctx: OpContext): string {
  if (ctx.resource.tok_count >= RESOURCE_LIMITS.toks) {
    fail('limit_exceeded', `Resource ${ctx.resource.id} holds the maximum of ${RESOURCE_LIMITS.toks} TOKs. Fork it to continue.`);
  }
  return formatTokId(ctx.allocate('tok_count'));
}

async function insertTok(
  ctx: OpContext,
  id: string,
  input: TokInput,
  via: Via,
  version: number,
  extra: { supersedes?: string | null } = {},
): Promise<TokRow> {
  const row: TokRow = {
    resource_id: ctx.resource.id,
    id,
    type: input.type,
    title: input.title,
    summary: input.summary,
    content: input.content,
    stated_confidence: input.stated_confidence,
    status: 'active',
    supersedes: extra.supersedes ?? null,
    superseded_by: null,
    supersession_reason: null,
    refs: input.refs,
    author_session_id: via.author.session_id,
    author_agent_id: via.author.agent_id,
    author_kind: via.author.kind,
    author_assurance: via.author.identity_assurance,
    recorded_by_session_id: ctx.actor.session_id,
    proposal_id: via.proposal_id,
    version,
    after_checkpoint: ctx.latestCheckpoint,
    created_at: ctx.now,
    responsible_session_id: input.type === 'task' ? via.author.session_id : null,
    origin: null,
  };
  await insertTokRow(ctx, row);
  return row;
}

async function insertTokRow(ctx: OpContext, t: TokRow): Promise<void> {
  await ctx.sql.query(
    `insert into toks (resource_id, id, type, title, summary, content, stated_confidence, status, supersedes,
       superseded_by, supersession_reason, refs, author_session_id, author_agent_id, author_kind, author_assurance,
       recorded_by_session_id, proposal_id, version, after_checkpoint, created_at, responsible_session_id, origin)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23)`,
    [
      t.resource_id, t.id, t.type, t.title, t.summary, t.content, t.stated_confidence, t.status, t.supersedes,
      t.superseded_by, t.supersession_reason, JSON.stringify(t.refs), t.author_session_id, t.author_agent_id,
      t.author_kind, t.author_assurance, t.recorded_by_session_id, t.proposal_id, t.version, t.after_checkpoint,
      t.created_at, t.responsible_session_id, t.origin ? JSON.stringify(t.origin) : null,
    ],
  );
}

async function insertResource(ctx: OpContext, r: ResourceRow): Promise<void> {
  await ctx.sql.query(
    `insert into resources (id, protocol, title, description, focus, lifecycle, visibility, accepts_proposals,
       owner_session_id, owner_agent_id, owner_human, version, parent_id, parent_version, parent_checkpoint,
       created_at, updated_at, kind, also_known_as)
     values ($1,$2,$3,$4,$5,'active',$6,$7,$8,$9,$10,1,$11,$12,$13,$14,$14,$15,$16)`,
    [
      r.id, r.protocol, r.title, r.description, r.focus, r.visibility, r.accepts_proposals, r.owner_session_id,
      r.owner_agent_id, r.owner_human, r.parent_id, r.parent_version, r.parent_checkpoint, r.created_at,
      r.kind, JSON.stringify(r.also_known_as),
    ],
  );
}

function newResourceRow(ctx: OpContext, fields: Partial<ResourceRow> & Pick<ResourceRow, 'title' | 'visibility'>): ResourceRow {
  return {
    id: newResourceId(ctx.env.random),
    protocol: PROTOCOL_VERSION,
    description: '',
    focus: '',
    lifecycle: 'active',
    accepts_proposals: true,
    owner_session_id: ctx.actor.session_id,
    owner_agent_id: ctx.actor.agent_id,
    owner_human: null,
    version: 0, // in memory; the first emit() makes it 1
    checkpoint_count: 0,
    tok_count: 0,
    annotation_count: 0,
    handoff_count: 0,
    proposal_count: 0,
    parent_id: null,
    parent_version: null,
    parent_checkpoint: null,
    created_at: ctx.now,
    updated_at: ctx.now,
    closed_at: null,
    kind: 'continuity_resource',
    also_known_as: [],
    current_substrate_id: null,
    scroll_count: 0,
    execution_count: 0,
    embodiment_count: 0,
    ...fields,
  };
}

async function issueCapability(
  ctx: OpContext,
  opts: {
    kind: 'owner' | 'delegation';
    session_id: string;
    agent_id: string | null;
    scopes: string[];
    ttlSeconds?: number;
    label?: string;
    version: number;
    minted?: ReturnType<typeof newCapability>;
  },
) {
  const cap = opts.minted ?? newCapability(ctx.env.random);
  const expires = opts.ttlSeconds ? new Date(ctx.now.getTime() + opts.ttlSeconds * 1000) : null;
  await ctx.sql.query(
    `insert into capabilities (id, resource_id, secret_hash, kind, session_id, agent_id, scopes, label,
       delegated_by_session_id, created_version, created_at, expires_at)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
    [
      cap.id, ctx.resource.id, cap.secretHash, opts.kind, opts.session_id, opts.agent_id, opts.scopes,
      opts.label ?? '', opts.kind === 'delegation' ? ctx.actor.session_id : null, opts.version, ctx.now, expires,
    ],
  );
  return {
    id: cap.id,
    token: cap.token,
    kind: opts.kind,
    session_id: opts.session_id,
    agent_id: opts.agent_id,
    scopes: opts.scopes,
    expires_at: iso(expires),
    notice: 'This token is shown ONCE and is not stored in recoverable form. Treat it as a secret.',
  };
}

/** Insert checkpoint `number` capturing the state at the resource's current in-memory version. */
async function writeCheckpoint(ctx: OpContext, number: number, snapshot: Snapshot, label: string, note: string) {
  const sha256 = canonicalHash(snapshot);
  await ctx.sql.query(
    `insert into checkpoints (resource_id, number, version, label, note, snapshot, snapshot_sha256,
       created_by_session_id, created_at)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
    [ctx.resource.id, number, snapshot.resource.version, label, note, JSON.stringify(snapshot), sha256, ctx.actor.session_id, ctx.now],
  );
  return checkpointRecord({
    resource_id: ctx.resource.id,
    number,
    version: snapshot.resource.version,
    label,
    note,
    snapshot_sha256: sha256,
    created_by_session_id: ctx.actor.session_id,
    created_at: ctx.now,
  });
}

export const who = (p: { session_id: string }) => p.session_id;

// ── handlers ───────────────────────────────────────────────────────────────

const create: Handler<'create'> = async (ctx, p) => {
  const row = newResourceRow(ctx, {
    title: p.title,
    description: p.description,
    focus: p.focus,
    visibility: p.visibility,
    accepts_proposals: p.accepts_proposals,
    owner_human: p.owner_human ?? null,
    kind: p.kind,
    also_known_as: p.also_known_as,
  });
  await insertResource(ctx, row);
  ctx.adopt(row);
  const identity = p.kind === 'agent_identity';
  const version = await ctx.emit({
    operation: 'create',
    summary: identity
      ? `${who(ctx.actor)} created agent identity "${p.title}" (principal: ${p.owner_human ?? 'unnamed'})`
      : `${who(ctx.actor)} created resource "${p.title}"`,
    data: {
      title: p.title,
      visibility: p.visibility,
      accepts_proposals: p.accepts_proposals,
      owner: { session_id: ctx.actor.session_id, agent_id: ctx.actor.agent_id, human: p.owner_human ?? null },
      ...(identity ? { kind: p.kind, also_known_as: p.also_known_as } : {}),
    },
  });
  const owner_capability = await issueCapability(ctx, {
    kind: 'owner',
    session_id: ctx.actor.session_id,
    agent_id: ctx.actor.agent_id,
    scopes: ['owner'],
    ttlSeconds: p.owner_capability_ttl_seconds,
    version,
  });
  const n = ctx.allocate('checkpoint_count');
  const genesis = await writeCheckpoint(ctx, n, await buildSnapshot(ctx.sql, ctx.resource, ctx.now), 'genesis', 'Created with the resource.');
  return {
    resource: { id: row.id, kind: row.kind, title: row.title, visibility: row.visibility, lifecycle: 'active', version },
    owner_capability,
    checkpoint: genesis,
    ...(identity
      ? {
          notice:
            'Agent identity created. The owner capability belongs to the principal session that created it; it cannot embody the identity. ' +
            'Delegate a capability (scopes embody, substrate, scroll, alias, execute, checkpoint, announce) to the session that will embody it.',
        }
      : {}),
  };
};

const append: Handler<'append'> = async (ctx, p, via = direct(ctx)) => {
  await checkRefs(ctx, p);
  const id = allocateTokId(ctx);
  const version = await ctx.emit({
    operation: 'append',
    summary: `${who(via.author)} appended ${p.type} ${id} "${p.title}"`,
    data: { tok_id: id, type: p.type, title: p.title },
    on_behalf_of: via.on_behalf_of,
    proposal_id: via.proposal_id,
  });
  const tok = await insertTok(ctx, id, p, via, version);
  return { tok: tokRecord(tok) };
};

const annotate: Handler<'annotate'> = async (ctx, p, via = direct(ctx)) => {
  await findTok(ctx, p.tok_id);
  if (ctx.resource.annotation_count >= RESOURCE_LIMITS.annotations) {
    fail('limit_exceeded', `Resource ${ctx.resource.id} holds the maximum of ${RESOURCE_LIMITS.annotations} annotations.`);
  }
  const id = `ANN-${pad3(ctx.allocate('annotation_count'))}`;
  const version = await ctx.emit({
    operation: 'annotate',
    summary: `${who(via.author)} added ${p.kind} ${id} on ${p.tok_id}`,
    data: { annotation_id: id, tok_id: p.tok_id, kind: p.kind },
    on_behalf_of: via.on_behalf_of,
    proposal_id: via.proposal_id,
  });
  await ctx.sql.query(
    `insert into annotations (resource_id, id, tok_id, kind, content, evidence, author_session_id, author_agent_id,
       author_kind, author_assurance, recorded_by_session_id, proposal_id, version, created_at)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
    [
      ctx.resource.id, id, p.tok_id, p.kind, p.content, p.evidence ? JSON.stringify(p.evidence) : null,
      via.author.session_id, via.author.agent_id, via.author.kind, via.author.identity_assurance,
      ctx.actor.session_id, via.proposal_id, version, ctx.now,
    ],
  );
  const rows = await loadAnnotations(ctx.sql, ctx.resource.id);
  const tok = await findTok(ctx, p.tok_id);
  return { annotation: tokRecord(tok, rows).annotations.find((a) => a.id === id) };
};

const update: Handler<'update'> = async (ctx, p) => {
  const r = ctx.resource;
  const changes: Record<string, { from: unknown; to: unknown }> = {};
  if (p.also_known_as !== undefined && r.kind !== 'agent_identity') {
    fail('invalid_payload', 'also_known_as applies only to agent identities.');
  }
  for (const key of ['title', 'description', 'focus', 'accepts_proposals', 'also_known_as'] as const) {
    const next = p[key];
    if (next !== undefined && JSON.stringify(next) !== JSON.stringify(r[key])) changes[key] = { from: r[key], to: next };
  }
  if (Object.keys(changes).length === 0) fail('invalid_payload', 'The update changes nothing.');
  for (const [k, c] of Object.entries(changes)) (r as unknown as Record<string, unknown>)[k] = c.to;
  ctx.markDirty();
  await ctx.emit({
    operation: 'update',
    summary: `${who(ctx.actor)} updated ${Object.keys(changes).join(', ')}`,
    data: { changes },
  });
  return { changes };
};

const supersede: Handler<'supersede'> = async (ctx, p, via = direct(ctx)) => {
  const target = await findTok(ctx, p.target);
  if (target.status === 'superseded') {
    fail('invalid_state', `${p.target} is already superseded by ${target.superseded_by}.`);
  }
  let replacementId: string;
  if (p.by) {
    if (p.by === p.target) fail('invalid_state', 'A TOK cannot supersede itself.');
    const by = await findTok(ctx, p.by);
    if (by.status !== 'active') fail('invalid_state', `${p.by} is itself superseded.`);
    if (by.supersedes) fail('invalid_state', `${p.by} already supersedes ${by.supersedes}.`);
    replacementId = by.id;
  } else {
    await checkRefs(ctx, p.replacement!);
    replacementId = allocateTokId(ctx);
  }
  const { rows: pending } = await ctx.sql.query<{ id: string }>(
    `select id from handoffs where resource_id = $1 and tok_id = $2 and status = 'pending'`,
    [ctx.resource.id, p.target],
  );
  const version = await ctx.emit({
    operation: 'supersede',
    summary: `${who(via.author)} superseded ${p.target} with ${replacementId}`,
    data: { target: p.target, replacement: replacementId, reason: p.reason, created_replacement: !p.by, cancelled_handoffs: pending.map((h) => h.id) },
    on_behalf_of: via.on_behalf_of,
    proposal_id: via.proposal_id,
  });
  if (p.by) {
    await ctx.sql.query('update toks set supersedes = $3 where resource_id = $1 and id = $2', [ctx.resource.id, p.by, p.target]);
  } else {
    await insertTok(ctx, replacementId, p.replacement!, via, version, { supersedes: p.target });
  }
  await ctx.sql.query(
    `update toks set status = 'superseded', superseded_by = $3, supersession_reason = $4 where resource_id = $1 and id = $2`,
    [ctx.resource.id, p.target, replacementId, p.reason],
  );
  if (pending.length) {
    await ctx.sql.query(
      `update handoffs set status = 'cancelled', resolved_version = $3, resolution_note = 'task superseded'
        where resource_id = $1 and tok_id = $2 and status = 'pending'`,
      [ctx.resource.id, p.target, version],
    );
  }
  const annotations = await loadAnnotations(ctx.sql, ctx.resource.id);
  return {
    superseded: tokRecord(await findTok(ctx, p.target), annotations),
    replacement: tokRecord(await findTok(ctx, replacementId), annotations),
  };
};

const checkpoint: Handler<'checkpoint'> = async (ctx, p, via = direct(ctx)) => {
  const number = ctx.allocate('checkpoint_count');
  // The checkpoint captures the state as of its own event's version.
  const snapshot = await buildSnapshot(ctx.sql, { ...ctx.resource, version: ctx.resource.version + 1 }, ctx.now);
  await ctx.emit({
    operation: 'checkpoint',
    summary: `${who(via.author)} created checkpoint ${number} "${p.label}"`,
    data: { number, label: p.label, sha256: canonicalHash(snapshot) },
    on_behalf_of: via.on_behalf_of,
    proposal_id: via.proposal_id,
  });
  return { checkpoint: await writeCheckpoint(ctx, number, snapshot, p.label, p.note) };
};

const fork: Handler<'fork'> = async (ctx, p) => {
  const parent = ctx.resource;
  let knowledge: ReturnType<typeof tokRecord>[];
  let parentVersion = parent.version;
  let parentCheckpoint: number | null = null;
  if (p.from_checkpoint !== undefined) {
    const cp = await loadCheckpoint(ctx.sql, parent.id, p.from_checkpoint);
    knowledge = (cp.snapshot as unknown as Snapshot).knowledge;
    parentVersion = cp.version;
    parentCheckpoint = cp.number;
  } else {
    const annotations = await loadAnnotations(ctx.sql, parent.id);
    knowledge = (await loadToks(ctx.sql, parent.id)).map((t) => tokRecord(t, annotations));
  }

  const child = newResourceRow(ctx, {
    title: p.title ?? `Fork of ${parent.title}`,
    description: parent.description,
    focus: parent.focus,
    visibility: p.visibility ?? parent.visibility,
    owner_human: p.owner_human ?? null,
    parent_id: parent.id,
    parent_version: parentVersion,
    parent_checkpoint: parentCheckpoint,
  });
  await insertResource(ctx, child);
  ctx.adopt(child);
  const lineage = { parent: parent.id, parent_version: parentVersion, parent_checkpoint: parentCheckpoint };
  const version = await ctx.emit({
    operation: 'fork',
    summary: `${who(ctx.actor)} forked ${parent.id}@${parentVersion} into ${child.id}`,
    data: { ...lineage, reason: p.reason, copied_toks: knowledge.map((k) => k.id) },
  });

  let maxTok = 0;
  for (const k of knowledge) {
    maxTok = Math.max(maxTok, Number(k.id.slice(4)));
    await insertTokRow(ctx, {
      resource_id: child.id,
      id: k.id,
      type: k.type,
      title: k.title,
      summary: k.summary,
      content: k.content,
      stated_confidence: k.stated_confidence,
      status: k.status as TokRow['status'],
      supersedes: k.supersedes,
      superseded_by: k.superseded_by,
      supersession_reason: k.supersession_reason,
      refs: k.refs as unknown[],
      author_session_id: k.source.session_id,
      author_agent_id: k.source.agent_id,
      author_kind: k.source.kind,
      author_assurance: k.source.identity_assurance,
      recorded_by_session_id: ctx.actor.session_id,
      proposal_id: null,
      version,
      after_checkpoint: 0,
      created_at: ctx.now,
      // Tasks in a new branch are the branch owner's responsibility.
      responsible_session_id: k.type === 'task' ? (k.status === 'active' ? ctx.actor.session_id : k.task?.responsible_session_id ?? null) : null,
      origin: { resource_id: parent.id, tok_id: k.id, version: k.version, created_at: k.created_at, recorded_by: k.recorded_by, annotations_on_parent: k.annotations.length },
    });
  }
  ctx.resource.tok_count = maxTok;

  const owner_capability = await issueCapability(ctx, {
    kind: 'owner',
    session_id: ctx.actor.session_id,
    agent_id: ctx.actor.agent_id,
    scopes: ['owner'],
    version,
  });
  const n = ctx.allocate('checkpoint_count');
  const genesis = await writeCheckpoint(ctx, n, await buildSnapshot(ctx.sql, ctx.resource, ctx.now), 'genesis', `Forked from ${parent.id}@${parentVersion}.`);
  return {
    resource: { id: child.id, title: child.title, visibility: child.visibility, lifecycle: 'active', version },
    lineage,
    owner_capability,
    checkpoint: genesis,
  };
};

const delegate: Handler<'delegate'> = async (ctx, p) => {
  const caps = (
    await ctx.sql.query<CapabilityRow>(`select * from capabilities where resource_id = $1 and kind = 'delegation'`, [ctx.resource.id])
  ).rows;
  if (caps.filter((c) => capabilityStatus(c, ctx.now) === 'active').length >= RESOURCE_LIMITS.activeDelegations) {
    fail('limit_exceeded', `At most ${RESOURCE_LIMITS.activeDelegations} active delegations per resource. Revoke some first.`);
  }
  const expiresAt = new Date(ctx.now.getTime() + p.expires_in_seconds * 1000);
  const minted = newCapability(ctx.env.random);
  const version = await ctx.emit({
    operation: 'delegate',
    summary: `${who(ctx.actor)} delegated [${p.scopes.join(', ')}] to ${p.to.session_id} (${minted.id})`,
    data: { capability_id: minted.id, to: p.to, scopes: p.scopes, expires_at: iso(expiresAt), label: p.label },
  });
  const capability = await issueCapability(ctx, {
    kind: 'delegation',
    session_id: p.to.session_id,
    agent_id: p.to.agent_id ?? null,
    scopes: p.scopes,
    ttlSeconds: p.expires_in_seconds,
    label: p.label,
    version,
    minted,
  });
  return { capability: { ...capability, label: p.label, created_version: version } };
};

const revoke: Handler<'revoke'> = async (ctx, p) => {
  const { rows } = await ctx.sql.query<CapabilityRow>('select * from capabilities where id = $1 and resource_id = $2', [
    p.capability_id,
    ctx.resource.id,
  ]);
  const cap = rows[0];
  if (!cap) throw new AcspError('not_found', `Resource ${ctx.resource.id} has no capability ${p.capability_id}.`);
  if (cap.kind === 'owner') fail('invalid_state', 'The owner capability cannot be revoked (the resource would be orphaned).');
  if (cap.revoked_at) fail('invalid_state', `${cap.id} is already revoked.`);
  const version = await ctx.emit({
    operation: 'revoke',
    summary: `${who(ctx.actor)} revoked ${cap.id} (${cap.session_id})`,
    data: { capability_id: cap.id, session_id: cap.session_id, reason: p.reason },
  });
  await ctx.sql.query('update capabilities set revoked_at = $2, revoked_version = $3 where id = $1', [cap.id, ctx.now, version]);
  return { capability_id: cap.id, revoked_at: iso(ctx.now) };
};

const handoff: Handler<'handoff'> = async (ctx, p) => {
  const tok = await findTok(ctx, p.tok_id);
  if (tok.type !== 'task') fail('invalid_state', `${tok.id} is a ${tok.type}; only task TOKs can be handed off.`);
  if (tok.status !== 'active') fail('invalid_state', `${tok.id} is superseded.`);
  if (!isOwner(ctx.cap) && tok.responsible_session_id !== ctx.actor.session_id) {
    fail(
      'insufficient_authority',
      `Only the owner or the responsible session (${tok.responsible_session_id}) can hand off ${tok.id}.`,
    );
  }
  if (p.to.session_id === tok.responsible_session_id) {
    fail('invalid_state', `${p.to.session_id} is already responsible for ${tok.id}.`);
  }
  const { rows: pending } = await ctx.sql.query(
    `select id from handoffs where resource_id = $1 and tok_id = $2 and status = 'pending'`,
    [ctx.resource.id, tok.id],
  );
  if (pending[0]) fail('invalid_state', `${tok.id} already has a pending handoff.`);
  const id = `HO-${pad3(ctx.allocate('handoff_count'))}`;
  const version = await ctx.emit({
    operation: 'handoff',
    summary: `${who(ctx.actor)} offered ${tok.id} to ${p.to.session_id} (${id}, pending acknowledgement)`,
    data: { handoff_id: id, tok_id: tok.id, from: tok.responsible_session_id, to: p.to, note: p.note },
  });
  const row: HandoffRow = {
    resource_id: ctx.resource.id,
    id,
    tok_id: tok.id,
    from_session_id: tok.responsible_session_id ?? ctx.actor.session_id,
    to_session_id: p.to.session_id,
    to_agent_id: p.to.agent_id ?? null,
    note: p.note,
    status: 'pending',
    created_version: version,
    resolved_version: null,
    resolution_note: null,
    created_at: ctx.now,
  };
  await ctx.sql.query(
    `insert into handoffs (resource_id, id, tok_id, from_session_id, to_session_id, to_agent_id, note, status,
       created_version, created_at) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
    [row.resource_id, row.id, row.tok_id, row.from_session_id, row.to_session_id, row.to_agent_id, row.note, row.status, row.created_version, row.created_at],
  );
  return {
    handoff: handoffRecord(row),
    notice: 'Responsibility moves only when the recipient acknowledges. A handoff grants no authority; delegate separately if needed.',
  };
};

const acknowledge: Handler<'acknowledge'> = async (ctx, p) => {
  const { rows } = await ctx.sql.query<HandoffRow>('select * from handoffs where resource_id = $1 and id = $2', [
    ctx.resource.id,
    p.handoff_id,
  ]);
  const h = rows[0];
  if (!h) throw new AcspError('not_found', `Resource ${ctx.resource.id} has no handoff ${p.handoff_id}.`);
  if (ctx.actor.session_id !== h.to_session_id) {
    fail('insufficient_authority', `${h.id} is addressed to ${h.to_session_id}; only that session can acknowledge it.`);
  }
  if (h.status !== 'pending') fail('invalid_state', `${h.id} is ${h.status}, not pending.`);
  const status = p.decision === 'accept' ? 'accepted' : 'declined';
  const version = await ctx.emit({
    operation: 'acknowledge',
    summary: `${who(ctx.actor)} ${status} ${h.id} (${h.tok_id})`,
    data: { handoff_id: h.id, tok_id: h.tok_id, decision: p.decision, note: p.note },
  });
  await ctx.sql.query(
    'update handoffs set status = $3, resolved_version = $4, resolution_note = $5 where resource_id = $1 and id = $2',
    [ctx.resource.id, h.id, status, version, p.note],
  );
  if (status === 'accepted') {
    await ctx.sql.query('update toks set responsible_session_id = $3 where resource_id = $1 and id = $2', [
      ctx.resource.id,
      h.tok_id,
      h.to_session_id,
    ]);
  }
  return { handoff: handoffRecord({ ...h, status, resolved_version: version, resolution_note: p.note }) };
};

export const propose: Handler<'propose'> = async (ctx, p) => {
  if (!ctx.resource.accepts_proposals) {
    fail('proposals_closed', `Resource ${ctx.resource.id} does not accept proposals.`);
  }
  if (!appliesTo(OPERATIONS_BY_NAME[p.operation], ctx.resource.kind)) {
    fail('invalid_payload', `"${p.operation}" cannot be proposed on a resource of kind "${ctx.resource.kind}".`);
  }
  const inner = validatePayload(OPERATIONS_BY_NAME[p.operation], p.payload);
  const { rows } = await ctx.sql.query<{ n: number }>(
    `select count(*)::int as n from proposals where resource_id = $1 and status = 'pending'`,
    [ctx.resource.id],
  );
  if (rows[0].n >= RESOURCE_LIMITS.pendingProposals) {
    fail('limit_exceeded', `Resource ${ctx.resource.id} already has ${RESOURCE_LIMITS.pendingProposals} pending proposals.`);
  }
  const id = `P-${pad3(ctx.allocate('proposal_count'))}`;
  const version = await ctx.emit({
    operation: 'propose',
    summary: `${who(ctx.actor)} proposed ${p.operation} (${id}, pending owner decision)`,
    data: { proposal_id: id, operation: p.operation, rationale: p.rationale },
  });
  const row: ProposalRow = {
    resource_id: ctx.resource.id,
    id,
    operation: p.operation,
    payload: inner,
    rationale: p.rationale,
    proposer_session_id: ctx.actor.session_id,
    proposer_agent_id: ctx.actor.agent_id,
    proposer_kind: ctx.actor.kind,
    proposer_assurance: ctx.assurance,
    status: 'pending',
    created_version: version,
    resolved_version: null,
    resolution_note: null,
    result: null,
    created_at: ctx.now,
  };
  await ctx.sql.query(
    `insert into proposals (resource_id, id, operation, payload, rationale, proposer_session_id, proposer_agent_id,
       proposer_kind, proposer_assurance, status, created_version, created_at)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
    [row.resource_id, row.id, row.operation, JSON.stringify(row.payload), row.rationale, row.proposer_session_id, row.proposer_agent_id, row.proposer_kind, row.proposer_assurance, row.status, row.created_version, row.created_at],
  );
  return {
    proposal: proposalRecord(row),
    notice: 'Proposed, not performed. The owner decides whether to execute it.',
  };
};

const resolveProposal: Handler<'resolve_proposal'> = async (ctx, p) => {
  const { rows } = await ctx.sql.query<ProposalRow>('select * from proposals where resource_id = $1 and id = $2', [
    ctx.resource.id,
    p.proposal_id,
  ]);
  const prop = rows[0];
  if (!prop) throw new AcspError('not_found', `Resource ${ctx.resource.id} has no proposal ${p.proposal_id}.`);
  if (prop.status !== 'pending') fail('invalid_state', `${prop.id} is ${prop.status}, not pending.`);
  const status = p.decision === 'accept' ? 'accepted' : 'rejected';
  const version = await ctx.emit({
    operation: 'resolve_proposal',
    summary: `${who(ctx.actor)} ${status} ${prop.id} (${prop.operation} from ${prop.proposer_session_id})`,
    data: { proposal_id: prop.id, decision: p.decision, note: p.note },
  });
  let executed: Result | null = null;
  if (status === 'accepted') {
    const proposer: Participant = {
      session_id: prop.proposer_session_id,
      agent_id: prop.proposer_agent_id,
      kind: prop.proposer_kind,
      identity_assurance: prop.proposer_assurance,
    };
    const inner = HANDLERS[prop.operation as 'append'] as Handler<'append'>;
    executed = await inner(ctx, prop.payload as never, { author: proposer, proposal_id: prop.id, on_behalf_of: proposer });
  }
  await ctx.sql.query(
    'update proposals set status = $3, resolved_version = $4, resolution_note = $5, result = $6 where resource_id = $1 and id = $2',
    [ctx.resource.id, prop.id, status, version, p.note, executed ? JSON.stringify(executed) : null],
  );
  return {
    proposal: proposalRecord({ ...prop, status, resolved_version: version, resolution_note: p.note, result: executed }),
    executed,
  };
};

const close: Handler<'close'> = async (ctx, p) => {
  const { rows: ho } = await ctx.sql.query<{ id: string }>(
    `select id from handoffs where resource_id = $1 and status = 'pending'`,
    [ctx.resource.id],
  );
  const { rows: pr } = await ctx.sql.query<{ id: string }>(
    `select id from proposals where resource_id = $1 and status = 'pending'`,
    [ctx.resource.id],
  );
  const { rows: em } = await ctx.sql.query<{ id: string }>(
    `select id from embodiments where resource_id = $1 and status = 'active'`,
    [ctx.resource.id],
  );
  ctx.resource.lifecycle = 'closed';
  ctx.resource.closed_at = ctx.now;
  const version = await ctx.emit({
    operation: 'close',
    summary: `${who(ctx.actor)} closed the resource: ${p.reason}`,
    data: {
      reason: p.reason,
      final_note: p.final_note,
      cancelled_handoffs: ho.map((h) => h.id),
      cancelled_proposals: pr.map((x) => x.id),
      ...(ctx.resource.kind === 'agent_identity' ? { released_embodiments: em.map((e) => e.id) } : {}),
    },
  });
  await ctx.sql.query(
    `update embodiments set status = 'released', released_version = $2, release_reason = 'identity closed',
       released_by_session_id = $3, released_at = $4 where resource_id = $1 and status = 'active'`,
    [ctx.resource.id, version, ctx.actor.session_id, ctx.now],
  );
  await ctx.sql.query(
    `update handoffs set status = 'cancelled', resolved_version = $2, resolution_note = 'resource closed' where resource_id = $1 and status = 'pending'`,
    [ctx.resource.id, version],
  );
  await ctx.sql.query(
    `update proposals set status = 'cancelled', resolved_version = $2, resolution_note = 'resource closed' where resource_id = $1 and status = 'pending'`,
    [ctx.resource.id, version],
  );
  return { lifecycle: 'closed', closed_at: iso(ctx.now) };
};

export const HANDLERS = {
  ...PROGRAM_001_HANDLERS,
  create,
  append,
  annotate,
  update,
  supersede,
  checkpoint,
  fork,
  delegate,
  revoke,
  handoff,
  acknowledge,
  propose,
  resolve_proposal: resolveProposal,
  close,
};
