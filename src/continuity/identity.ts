/**
 * CONTINUITY LAYER — Program 001 operation handlers: agent identity,
 * embodiment, computational substrate, Scrolls, aliases and executions.
 *
 * Same contract as handlers.ts: each handler runs inside the engine's
 * transaction after base authority, resource-kind, lifecycle and version
 * checks, emits one event per state change and updates projections.
 *
 * The rule that keeps the dimensions apart:
 *   - the OWNER (human principal) authorizes, delegates, revokes, releases;
 *     it cannot embody the identity;
 *   - a SESSION embodies the identity with its own session-bound capability,
 *     and only the embodied session acts AS the identity;
 *   - the MODEL/APPLICATION are self-declared labels on the embodiment;
 *   - the SUBSTRATE is where operations execute.
 * None of these is the identity, and changing any of them does not create one.
 */
import { RESOURCE_LIMITS } from '../protocol/constants';
import { AcspError, fail } from '../protocol/errors';
import {
  contentHash,
  dependencies,
  evaluate,
  refString,
  requiredSubstrates,
  validateScroll,
  type Issue,
  type ScrollContent,
  type ScrollContentInput,
  type ScrollLookup,
  type ScrollRef,
} from '../scrolls/scroll';
import { getSubstrate, manifestHash, substrateRef } from '../substrates/registry';
import type { Substrate, Value } from '../substrates/types';
import { isOwner } from './authority';
import { canonicalHash } from './canonical';
import type { OpContext } from './engine';
import { direct, propose, who, type Handler, type Via } from './handlers';
import { pad3 } from './ids';
import {
  aliasBindingRecord,
  embodimentRecord,
  eventId,
  executionRecord,
  scrollVersionRecord,
  type AliasBindingRow,
  type EmbodimentRow,
  type ExecutionRow,
  type ScrollRow,
} from './records';

// ── helpers ────────────────────────────────────────────────────────────────

async function activeEmbodiment(ctx: OpContext): Promise<EmbodimentRow | null> {
  const { rows } = await ctx.sql.query<EmbodimentRow>(`select * from embodiments where resource_id = $1 and status = 'active'`, [ctx.resource.id]);
  return rows[0] ?? null;
}

/**
 * The actor must be the session currently embodying the identity. The one
 * exception is the owner executing an accepted proposal: that is recorded
 * with the proposer as source and no embodiment.
 */
async function requireEmbodiment(ctx: OpContext, via: Via): Promise<EmbodimentRow | null> {
  if (via.proposal_id) return null;
  const e = await activeEmbodiment(ctx);
  if (!e) fail('not_embodied', `No session embodies agent identity ${ctx.resource.id}. A session with scope "embody" must "embody" it first.`);
  if (e!.session_id !== ctx.actor.session_id) {
    fail('not_embodied', `Agent identity ${ctx.resource.id} is embodied by session "${e!.session_id}" (${e!.id}), not "${ctx.actor.session_id}". Holding a capability is not embodiment.`, {
      active_embodiment: e!.id,
    });
  }
  return e;
}

async function scrollIndex(ctx: OpContext): Promise<Map<string, ScrollRow>> {
  const { rows } = await ctx.sql.query<ScrollRow>('select * from scrolls where resource_id = $1 order by scroll_id, version', [ctx.resource.id]);
  return new Map(rows.map((r) => [refString(r), r]));
}
const lookupIn = (idx: Map<string, ScrollRow>): ScrollLookup => (ref) => idx.get(refString(ref))?.content;

function rejectIssues(prefix: string, issues: Issue[], message: string): void {
  if (issues.length) {
    fail('invalid_payload', message, { issues: issues.map((i) => ({ path: i.path ? `${prefix}.${i.path}` : prefix, message: i.message })) });
  }
}

function checkScroll(input: ScrollContentInput, idx: Map<string, ScrollRow>, prefix: string): ScrollContent {
  const { content, issues } = validateScroll(input, lookupIn(idx));
  rejectIssues(prefix, issues, 'The Scroll is invalid.');
  return content;
}

function substrateOrFail(id: string): Substrate {
  const s = getSubstrate(id);
  if (!s) throw new AcspError('not_found', `No substrate "${id}". See GET /substrates.`);
  if (s.manifest.status !== 'available') {
    fail('substrate_unavailable', `Substrate "${id}" is ${s.manifest.status}.`, { substrate_id: id, status: s.manifest.status });
  }
  return s;
}

/** Resolve and check every substrate an evaluation needs, before anything is recorded. */
function prepareSubstrates(ctx: OpContext, content: ScrollContent, lookup: ScrollLookup, requested: string | undefined): Substrate | null {
  const need = requiredSubstrates(content, lookup);
  need.pinned.forEach((id) => substrateOrFail(id));
  const defaultId = requested ?? ctx.resource.current_substrate_id;
  if (requested !== undefined) substrateOrFail(requested);
  if (!need.needsDefault) return defaultId ? substrateOrFail(defaultId) : null;
  if (!defaultId) {
    fail('invalid_state', 'This Scroll has steps without a pinned substrate, and no substrate is selected. Use "set_substrate" or pass substrate_id.');
  }
  return substrateOrFail(defaultId!);
}

function checkInputs(declared: string[], given: Record<string, Value>, prefix: string): void {
  const issues: Issue[] = [];
  for (const n of declared) if (!(n in given)) issues.push({ path: n, message: 'missing input' });
  for (const n of Object.keys(given)) if (!declared.includes(n)) issues.push({ path: n, message: 'not an input of this Scroll' });
  rejectIssues(prefix, issues, `The inputs do not match the Scroll's declared inputs [${declared.join(', ')}].`);
}

function checkExecutionLimit(ctx: OpContext, n: number): void {
  if (ctx.resource.execution_count + n > RESOURCE_LIMITS.executions) {
    fail('limit_exceeded', `Agent identity ${ctx.resource.id} holds the maximum of ${RESOURCE_LIMITS.executions} execution records.`);
  }
}

async function insertExecution(ctx: OpContext, x: ExecutionRow): Promise<void> {
  await ctx.sql.query(
    `insert into executions (resource_id, id, number, kind, scroll_id, scroll_version, scroll_sha256, via_alias, inputs, steps,
       outputs, status, error, default_substrate, session_id, agent_label, identity_assurance, embodiment_id, model,
       application, proposal_id, on_behalf_of, parent_checkpoint, event_version, started_at, completed_at)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26)`,
    [
      x.resource_id, x.id, x.number, x.kind, x.scroll_id, x.scroll_version, x.scroll_sha256,
      x.via_alias ? JSON.stringify(x.via_alias) : null, JSON.stringify(x.inputs), JSON.stringify(x.steps),
      x.outputs ? JSON.stringify(x.outputs) : null, x.status, x.error ? JSON.stringify(x.error) : null,
      x.default_substrate ? JSON.stringify(x.default_substrate) : null, x.session_id, x.agent_label, x.identity_assurance,
      x.embodiment_id, x.model ? JSON.stringify(x.model) : null, x.application ? JSON.stringify(x.application) : null,
      x.proposal_id, x.on_behalf_of ? JSON.stringify(x.on_behalf_of) : null, x.parent_checkpoint, x.event_version,
      x.started_at, x.completed_at,
    ],
  );
}

// ── embodiment ─────────────────────────────────────────────────────────────

const embody: Handler<'embody'> = async (ctx, p) => {
  if (isOwner(ctx.cap)) {
    fail(
      'insufficient_authority',
      'The owner capability belongs to the principal, which authorizes the identity but is not it. Delegate a capability with scope "embody" to the session that will embody it.',
    );
  }
  const active = await activeEmbodiment(ctx);
  if (active) {
    fail(
      'invalid_state',
      active.session_id === ctx.actor.session_id
        ? `Session "${active.session_id}" already embodies this identity (${active.id}).`
        : `Agent identity ${ctx.resource.id} is embodied by session "${active.session_id}" (${active.id}). That embodiment must be released first (by that session, or by the owner).`,
      { active_embodiment: active.id },
    );
  }
  if (ctx.resource.embodiment_count >= RESOURCE_LIMITS.embodiments) {
    fail('limit_exceeded', `Agent identity ${ctx.resource.id} has reached ${RESOURCE_LIMITS.embodiments} embodiments.`);
  }
  const { rows: prev } = await ctx.sql.query<EmbodimentRow>(
    'select * from embodiments where resource_id = $1 order by attached_version desc limit 1',
    [ctx.resource.id],
  );
  const previous = prev[0] ? { embodiment_id: prev[0].id, session_id: prev[0].session_id, model: prev[0].model, application: prev[0].application } : null;
  const id = `EMB-${pad3(ctx.allocate('embodiment_count'))}`;
  const model = p.model ?? null;
  const application = p.application ?? null;
  const version = await ctx.emit({
    operation: 'embody',
    summary: `${who(ctx.actor)} embodied agent identity ${ctx.resource.id} (${id}${model ? `, model ${model.provider}/${model.model_id}` : ''})`,
    data: { embodiment_id: id, session_id: ctx.actor.session_id, capability_id: ctx.cap?.id ?? null, model, application, previous },
  });
  const row: EmbodimentRow = {
    resource_id: ctx.resource.id,
    id,
    session_id: ctx.actor.session_id,
    agent_label: ctx.actor.agent_id,
    capability_id: ctx.cap?.id ?? null,
    model,
    application,
    note: p.note,
    status: 'active',
    attached_version: version,
    released_version: null,
    release_reason: null,
    released_by_session_id: null,
    created_at: ctx.now,
    released_at: null,
  };
  await ctx.sql.query(
    `insert into embodiments (resource_id, id, session_id, agent_label, capability_id, model, application, note, status,
       attached_version, created_at) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
    [row.resource_id, row.id, row.session_id, row.agent_label, row.capability_id, model ? JSON.stringify(model) : null,
      application ? JSON.stringify(application) : null, row.note, row.status, row.attached_version, row.created_at],
  );
  return {
    embodiment: embodimentRecord(row),
    notice:
      `Session "${row.session_id}" now embodies agent identity ${ctx.resource.id}. The session is not the identity: ` +
      'when it ends, the identity, its Scrolls, aliases and history remain, and another session can embody it.',
  };
};

const release: Handler<'release'> = async (ctx, p) => {
  const { rows } = await ctx.sql.query<EmbodimentRow>('select * from embodiments where resource_id = $1 and id = $2', [ctx.resource.id, p.embodiment_id]);
  const e = rows[0];
  if (!e) throw new AcspError('not_found', `Agent identity ${ctx.resource.id} has no embodiment ${p.embodiment_id}.`);
  if (e.status !== 'active') fail('invalid_state', `${e.id} is already ${e.status}.`);
  if (!isOwner(ctx.cap) && e.session_id !== ctx.actor.session_id) {
    fail('insufficient_authority', `${e.id} belongs to session "${e.session_id}". Only that session or the owner can release it.`);
  }
  const version = await ctx.emit({
    operation: 'release',
    summary: `${who(ctx.actor)} released ${e.id} (session ${e.session_id}): ${p.reason}`,
    data: { embodiment_id: e.id, session_id: e.session_id, reason: p.reason, released_by: ctx.actor.session_id, by_owner: e.session_id !== ctx.actor.session_id },
  });
  await ctx.sql.query(
    `update embodiments set status = 'released', released_version = $3, release_reason = $4, released_by_session_id = $5,
       released_at = $6 where resource_id = $1 and id = $2`,
    [ctx.resource.id, e.id, version, p.reason, ctx.actor.session_id, ctx.now],
  );
  return {
    embodiment: embodimentRecord({ ...e, status: 'released', released_version: version, release_reason: p.reason, released_by_session_id: ctx.actor.session_id, released_at: ctx.now }),
    notice: 'Released. Capabilities are unchanged by release; the owner revokes them separately.',
  };
};

// ── substrate ──────────────────────────────────────────────────────────────

const setSubstrate: Handler<'set_substrate'> = async (ctx, p) => {
  await requireEmbodiment(ctx, direct(ctx));
  const from = ctx.resource.current_substrate_id;
  const to = p.substrate_id;
  const target = to === null ? null : substrateOrFail(to);
  if (from === to) fail('invalid_state', to === null ? 'No substrate is attached.' : `"${to}" is already the current substrate.`);
  const change = from === null ? 'attached' : to === null ? 'detached' : 'changed';
  ctx.resource.current_substrate_id = to;
  ctx.markDirty();
  await ctx.emit({
    operation: 'set_substrate',
    summary: `${who(ctx.actor)} ${change} substrate ${from ?? '∅'} → ${to ?? '∅'}`,
    data: { from, to, change, substrate: target ? substrateRef(target) : null, manifest_sha256: target ? manifestHash(target.manifest) : null, reason: p.reason },
  });
  return { substrate: { from, to, change, current: target ? substrateRef(target) : null } };
};

// ── announce ───────────────────────────────────────────────────────────────

const announce: Handler<'announce'> = async (ctx, p) => {
  const emb = await requireEmbodiment(ctx, direct(ctx));
  const idx = await scrollIndex(ctx);
  const issues: Issue[] = [];
  p.refs.forEach((r, i) => {
    if ('scroll' in r && !idx.has(refString(r.scroll))) issues.push({ path: `refs.${i}.scroll`, message: `${refString(r.scroll)} does not exist` });
  });
  rejectIssues('payload', issues, 'The announcement cites unknown Scrolls.');
  const version = await ctx.emit({
    operation: 'announce',
    summary: `${who(ctx.actor)} announced (${p.kind}): ${p.statement.slice(0, 120)}`,
    data: { kind: p.kind, statement: p.statement, refs: p.refs, embodiment_id: emb?.id ?? null },
  });
  return {
    announcement: { id: eventId(ctx.resource.id, version), kind: p.kind, statement: p.statement, refs: p.refs, version },
    notice: 'Announced. An announcement grants no authority and commits nothing beyond its own record.',
  };
};

// ── Scrolls ────────────────────────────────────────────────────────────────

async function commitScroll(
  ctx: OpContext,
  via: Via,
  emb: EmbodimentRow | null,
  ref: ScrollRef,
  parent: number | null,
  content: ScrollContent,
  operation: 'create_scroll' | 'version_scroll',
  reason: string,
) {
  const hash = contentHash(content);
  const deps = dependencies(content);
  const version = await ctx.emit({
    operation,
    summary: `${who(via.author)} ${operation === 'create_scroll' ? 'created' : 'versioned'} Scroll ${refString(ref)} "${content.purpose.slice(0, 80)}"`,
    data: {
      scroll_id: ref.scroll_id,
      version: ref.version,
      parent_version: parent,
      ref: refString(ref),
      content_sha256: hash,
      operations: deps.operations,
      step_count: content.operations.length,
      composition: deps.composition,
      calls: deps.scrolls,
      reason,
    },
    on_behalf_of: via.on_behalf_of,
    proposal_id: via.proposal_id,
  });
  const row: ScrollRow = {
    resource_id: ctx.resource.id,
    scroll_id: ref.scroll_id,
    version: ref.version,
    parent_version: parent,
    content,
    content_sha256: hash,
    author_session_id: via.author.session_id,
    author_agent_id: via.author.agent_id,
    author_kind: via.author.kind,
    author_assurance: via.author.identity_assurance,
    recorded_by_session_id: ctx.actor.session_id,
    embodiment_id: emb?.id ?? null,
    proposal_id: via.proposal_id,
    event_version: version,
    after_checkpoint: ctx.latestCheckpoint,
    created_at: ctx.now,
  };
  await ctx.sql.query(
    `insert into scrolls (resource_id, scroll_id, version, parent_version, content, content_sha256, author_session_id,
       author_agent_id, author_kind, author_assurance, recorded_by_session_id, embodiment_id, proposal_id, event_version,
       after_checkpoint, created_at) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)`,
    [row.resource_id, row.scroll_id, row.version, row.parent_version, JSON.stringify(content), hash, row.author_session_id,
      row.author_agent_id, row.author_kind, row.author_assurance, row.recorded_by_session_id, row.embodiment_id,
      row.proposal_id, version, row.after_checkpoint, row.created_at],
  );
  return { scroll: scrollVersionRecord(row) };
}

const createScroll: Handler<'create_scroll'> = async (ctx, p, via = direct(ctx)) => {
  const emb = await requireEmbodiment(ctx, via);
  const idx = await scrollIndex(ctx);
  if (idx.size >= RESOURCE_LIMITS.scrollVersions) fail('limit_exceeded', `At most ${RESOURCE_LIMITS.scrollVersions} Scroll versions per identity.`);
  const content = checkScroll(p.scroll, idx, 'scroll');
  const scroll_id = `SCR-${pad3(ctx.allocate('scroll_count'))}`;
  return commitScroll(ctx, via, emb, { scroll_id, version: 1 }, null, content, 'create_scroll', '');
};

const versionScroll: Handler<'version_scroll'> = async (ctx, p, via = direct(ctx)) => {
  const emb = await requireEmbodiment(ctx, via);
  const idx = await scrollIndex(ctx);
  const versions = Array.from(idx.values()).filter((r) => r.scroll_id === p.scroll_id);
  if (!versions.length) throw new AcspError('not_found', `Agent identity ${ctx.resource.id} has no Scroll ${p.scroll_id}.`);
  const latest = versions[versions.length - 1];
  if (p.parent_version !== latest.version) {
    fail('stale_version', `${p.scroll_id} is at version ${latest.version}, not ${p.parent_version}. Read it and derive from the latest version.`, {
      scroll_id: p.scroll_id,
      expected: p.parent_version,
      current: latest.version,
    });
  }
  if (idx.size >= RESOURCE_LIMITS.scrollVersions) fail('limit_exceeded', `At most ${RESOURCE_LIMITS.scrollVersions} Scroll versions per identity.`);
  const content = checkScroll(p.scroll, idx, 'scroll');
  if (contentHash(content) === latest.content_sha256) {
    fail('invalid_state', `The new content is identical to ${refString(latest)} (${latest.content_sha256}).`);
  }
  return commitScroll(ctx, via, emb, { scroll_id: p.scroll_id, version: latest.version + 1 }, latest.version, content, 'version_scroll', p.reason);
};

// ── aliases ────────────────────────────────────────────────────────────────

async function aliasBindings(ctx: OpContext, name?: string): Promise<AliasBindingRow[]> {
  const { rows } = await ctx.sql.query<AliasBindingRow>(
    `select * from alias_bindings where resource_id = $1${name ? ' and name = $2' : ''} order by name, binding`,
    name ? [ctx.resource.id, name] : [ctx.resource.id],
  );
  return rows;
}

const setAlias: Handler<'set_alias'> = async (ctx, p, via = direct(ctx)) => {
  const emb = await requireEmbodiment(ctx, via);
  const idx = await scrollIndex(ctx);
  if (!idx.has(refString(p.target))) throw new AcspError('not_found', `Agent identity ${ctx.resource.id} has no ${refString(p.target)}.`);
  const all = await aliasBindings(ctx);
  const mine = all.filter((b) => b.name === p.name);
  const prev = mine[mine.length - 1] ?? null;
  if (prev && prev.scroll_id === p.target.scroll_id && prev.scroll_version === p.target.version) {
    fail('invalid_state', `"${p.name}" is already bound to ${refString(p.target)} (binding ${prev.binding}).`);
  }
  if (!prev && new Set(all.map((b) => b.name)).size >= RESOURCE_LIMITS.aliases) fail('limit_exceeded', `At most ${RESOURCE_LIMITS.aliases} aliases per identity.`);
  if (all.length >= RESOURCE_LIMITS.aliasBindings) fail('limit_exceeded', `At most ${RESOURCE_LIMITS.aliasBindings} alias bindings per identity.`);
  const binding = (prev?.binding ?? 0) + 1;
  const previous = prev ? refString({ scroll_id: prev.scroll_id, version: prev.scroll_version }) : null;
  const version = await ctx.emit({
    operation: 'set_alias',
    summary: `${who(via.author)} ${prev ? 'rebound' : 'bound'} alias "${p.name}" → ${refString(p.target)}${previous ? ` (was ${previous})` : ''}`,
    data: { name: p.name, binding, target: { ...p.target, ref: refString(p.target) }, previous, reason: p.reason },
    on_behalf_of: via.on_behalf_of,
    proposal_id: via.proposal_id,
  });
  const row: AliasBindingRow = {
    resource_id: ctx.resource.id,
    name: p.name,
    binding,
    scroll_id: p.target.scroll_id,
    scroll_version: p.target.version,
    reason: p.reason,
    author_session_id: via.author.session_id,
    author_assurance: via.author.identity_assurance,
    embodiment_id: emb?.id ?? null,
    proposal_id: via.proposal_id,
    event_version: version,
    created_at: ctx.now,
  };
  await ctx.sql.query(
    `insert into alias_bindings (resource_id, name, binding, scroll_id, scroll_version, reason, author_session_id,
       author_assurance, embodiment_id, proposal_id, event_version, created_at) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
    [row.resource_id, row.name, row.binding, row.scroll_id, row.scroll_version, row.reason, row.author_session_id,
      row.author_assurance, row.embodiment_id, row.proposal_id, version, row.created_at],
  );
  return { alias: { ...aliasBindingRecord(row), previous } };
};

// ── execution ──────────────────────────────────────────────────────────────

function executionRow(
  ctx: OpContext,
  via: Via,
  emb: EmbodimentRow | null,
  fields: Pick<ExecutionRow, 'kind' | 'scroll_id' | 'scroll_version' | 'scroll_sha256' | 'via_alias' | 'inputs' | 'steps' | 'outputs' | 'status' | 'error' | 'default_substrate' | 'started_at' | 'completed_at'>,
): ExecutionRow {
  const number = ctx.allocate('execution_count');
  return {
    resource_id: ctx.resource.id,
    id: `EXE-${pad3(number)}`,
    number,
    ...fields,
    session_id: ctx.actor.session_id,
    agent_label: ctx.actor.agent_id,
    identity_assurance: ctx.assurance,
    embodiment_id: emb?.id ?? null,
    model: emb?.model ?? null,
    application: emb?.application ?? null,
    proposal_id: via.proposal_id,
    on_behalf_of: via.on_behalf_of,
    parent_checkpoint: ctx.latestCheckpoint,
    event_version: 0, // set after emit
  };
}

const execute: Handler<'execute'> = async (ctx, p, via = direct(ctx)) => {
  const emb = await requireEmbodiment(ctx, via);
  let ref: ScrollRef;
  let viaAlias: { name: string; binding: number } | null = null;
  if ('alias' in p.target) {
    const bs = await aliasBindings(ctx, p.target.alias);
    const b = bs[bs.length - 1];
    if (!b) throw new AcspError('not_found', `Agent identity ${ctx.resource.id} has no alias "${p.target.alias}".`);
    ref = { scroll_id: b.scroll_id, version: b.scroll_version };
    viaAlias = { name: b.name, binding: b.binding };
  } else ref = p.target;
  const idx = await scrollIndex(ctx);
  const row = idx.get(refString(ref));
  if (!row) throw new AcspError('not_found', `Agent identity ${ctx.resource.id} has no ${refString(ref)}.`);
  checkInputs(row.content.inputs, p.inputs, 'inputs');
  const lookup = lookupIn(idx);
  const def = prepareSubstrates(ctx, row.content, lookup, p.substrate_id);
  checkExecutionLimit(ctx, 1);

  const started = ctx.env.clock.now();
  const ev = evaluate(row.content, p.inputs, lookup, def);
  const completed = ctx.env.clock.now();
  const x = executionRow(ctx, via, emb, {
    kind: 'scroll',
    scroll_id: ref.scroll_id,
    scroll_version: ref.version,
    scroll_sha256: row.content_sha256,
    via_alias: viaAlias,
    inputs: p.inputs,
    steps: ev.steps,
    outputs: ev.status === 'completed' ? ev.outputs : null,
    status: ev.status,
    error: ev.status === 'failed' ? ev.error : null,
    default_substrate: def ? substrateRef(def) : null,
    started_at: started,
    completed_at: completed,
  });
  x.event_version = await ctx.emit({
    operation: 'execute',
    summary: `${who(via.author)} executed ${refString(ref)}${viaAlias ? ` via "${viaAlias.name}"` : ''} → ${x.status}${ev.status === 'completed' ? ` ${JSON.stringify(ev.outputs)}` : ` (${ev.error.code})`} [${x.id}]`,
    data: {
      execution_id: x.id,
      scroll: { scroll_id: ref.scroll_id, version: ref.version, ref: refString(ref) },
      via_alias: viaAlias,
      status: x.status,
      inputs_sha256: canonicalHash(p.inputs),
      outputs: x.outputs,
      error: x.error?.code ?? null,
      default_substrate: x.default_substrate?.substrate_id ?? null,
      embodiment_id: x.embodiment_id,
    },
    on_behalf_of: via.on_behalf_of,
    proposal_id: via.proposal_id,
  });
  await insertExecution(ctx, x);
  return { execution: executionRecord(x) };
};

const discoverNewOperation: Handler<'discover_new_operation'> = async (ctx, p) => {
  const via = direct(ctx);
  const emb = await requireEmbodiment(ctx, via);
  const idx = await scrollIndex(ctx);
  const content = checkScroll(p.candidate, idx, 'candidate');
  p.trials.forEach((t, i) => checkInputs(content.inputs, t.inputs, `trials.${i}.inputs`));
  const lookup = lookupIn(idx);
  const def = prepareSubstrates(ctx, content, lookup, p.substrate_id);
  checkExecutionLimit(ctx, p.trials.length);
  const hash = contentHash(content);
  const rows = p.trials.map((t) => {
    const started = ctx.env.clock.now();
    const ev = evaluate(content, t.inputs, lookup, def);
    return executionRow(ctx, via, emb, {
      kind: 'trial',
      scroll_id: null,
      scroll_version: null,
      scroll_sha256: hash,
      via_alias: null,
      inputs: t.inputs,
      steps: { candidate: content, steps: ev.steps },
      outputs: ev.status === 'completed' ? ev.outputs : null,
      status: ev.status,
      error: ev.status === 'failed' ? ev.error : null,
      default_substrate: def ? substrateRef(def) : null,
      started_at: started,
      completed_at: ctx.env.clock.now(),
    });
  });
  const deps = dependencies(content);
  const version = await ctx.emit({
    operation: 'discover_new_operation',
    summary: `${who(ctx.actor)} tested candidate ${hash.slice(0, 19)}… on ${rows.length} trial(s): ${rows.filter((r) => r.status === 'completed').length} completed`,
    data: {
      candidate_sha256: hash,
      operations: deps.operations,
      step_count: content.operations.length,
      composition: deps.composition,
      calls: deps.scrolls,
      trials: rows.map((r) => ({ execution_id: r.id, status: r.status, outputs: r.outputs, error: r.error?.code ?? null })),
      propose: p.propose,
    },
  });
  for (const r of rows) {
    r.event_version = version;
    await insertExecution(ctx, r);
  }
  const proposal = p.propose ? await propose(ctx, { operation: 'create_scroll', payload: { scroll: p.candidate }, rationale: p.rationale }) : null;
  return {
    candidate_sha256: hash,
    candidate: content,
    trials: rows.map(executionRecord),
    proposal: proposal ? proposal.proposal : null,
    notice: p.propose
      ? 'Observation recorded and a create_scroll proposal filed. No Scroll exists until the owner accepts it.'
      : 'Observation recorded. No Scroll was created; use create_scroll (or propose) to persist the candidate.',
  };
};

export const PROGRAM_001_HANDLERS = {
  embody,
  release,
  set_substrate: setSubstrate,
  announce,
  create_scroll: createScroll,
  version_scroll: versionScroll,
  set_alias: setAlias,
  execute,
  discover_new_operation: discoverNewOperation,
};
