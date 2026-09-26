/**
 * The canonical resource document and the other read representations.
 *
 * Each document is plain JSON. The transport layer serialises it or renders
 * it to HTML (embedding it verbatim), so the formats cannot drift apart.
 */
import type { Sql } from '../db/types';
import { bootstrapDocument, NOTICE } from '../protocol/bootstrap';
import { identityBootstrapDocument, INTENT_STATES } from '../protocol/program001';
import {
  INVARIANTS,
  PROTOCOL_NAME,
  PROTOCOL_TITLE,
  EXTENSIONS,
  PROTOCOL_VERSION,
  RESOURCE_LIMITS,
  SCOPE_MEANINGS,
  VISIBILITY_MEANINGS,
} from '../protocol/constants';
import { appliesTo, OPERATIONS, type OperationSpec } from '../protocol/operations';
import { deriveObservations, OBSERVATION_VOCABULARY } from '../research/phenotype';
import { KNOWLEDGE_SEMANTICS } from '../research/tok';
import { refString } from '../scrolls/scroll';
import { getSubstrate, manifestHash, SUBSTRATES, substrateRef } from '../substrates/registry';
import { canonicalHash } from './canonical';
import { authorize, describeRequirement, effectiveScopes, isOwner, type VerifiedCapability } from './authority';
import { AcspError } from '../protocol/errors';
import {
  capabilityRecord,
  checkpointRecord,
  commitState,
  embodimentRecord,
  eventRecord,
  executionRecord,
  handoffRecord,
  iso,
  proposalRecord,
  scrollVersionRecord,
  tokRecord,
  type EmbodimentRow,
  type EventRow,
  type ExecutionRow,
  type ResourceRow,
  type ScrollRow,
} from './records';
import {
  loadAnnotations,
  loadCapabilities,
  groupAliases,
  loadAliasBindings,
  loadCheckpoint,
  loadCheckpoints,
  loadEmbodiments,
  loadEvent,
  loadEvents,
  loadExecutions,
  loadScrolls,
  loadForks,
  loadHandoffs,
  loadProposals,
  loadRecentEvents,
  loadResource,
  loadToks,
} from './state';

export interface Viewer {
  cap: VerifiedCapability | null;
  /** Set when a presented credential failed verification (the page is still shown for unlisted resources). */
  credentialError?: { code: string; message: string };
  /** The raw ?cap= value, propagated into links so GET-only agents keep their view. */
  capParam?: string;
}

/** Builds absolute links, carrying ?cap= when the viewer arrived with one. */
export class Links {
  constructor(
    readonly base: string,
    private readonly capParam?: string,
  ) {}
  url(path: string, query: Record<string, string | number | undefined> = {}): string {
    const u = new URL(path, this.base);
    for (const [k, v] of Object.entries(query)) if (v !== undefined) u.searchParams.set(k, String(v));
    if (this.capParam) u.searchParams.set('cap', this.capParam);
    return u.toString();
  }
  resource(id: string, suffix = '', query: Record<string, string | number | undefined> = {}) {
    return this.url(`/r/${id}${suffix}`, query);
  }
  /** Links that must never carry a capability (documentation). */
  plain(path: string): string {
    return new URL(path, this.base).toString();
  }
}

export function resourceLinks(id: string, l: Links) {
  return {
    self: l.resource(id),
    html: l.resource(id),
    json: l.resource(id, '.json'),
    status: l.resource(id, '', { action: 'status' }),
    operations: l.resource(id, '/operations'),
    events: l.resource(id, '/events'),
    checkpoints: l.resource(id, '/checkpoints'),
    diff: l.resource(id, '/diff', { from: 1 }),
    explorer: l.resource(id, '/explorer'),
    execute: l.plain(`/r/${id}/operations`),
    protocol: l.plain('/protocol'),
    protocol_json: l.plain('/protocol.json'),
  };
}

/** Program 001 links, present on agent identities only. */
export function identityLinks(id: string, l: Links) {
  return {
    identity: l.resource(id, '/identity'),
    substrates: l.resource(id, '/substrates'),
    substrate_registry: l.plain('/substrates'),
    scrolls: l.resource(id, '/scrolls'),
    aliases: l.resource(id, '/aliases'),
    executions: l.resource(id, '/executions'),
    transitions: l.resource(id, '/transitions'),
  };
}

export const protocolHeader = (l: Links) => ({
  name: PROTOCOL_NAME,
  version: PROTOCOL_VERSION,
  title: PROTOCOL_TITLE,
  spec: l.plain('/protocol'),
  spec_json: l.plain('/protocol.json'),
  invariants: [...INVARIANTS],
  extensions: [...EXTENSIONS],
});

export async function readableResource(sql: Sql, id: string, viewer: Viewer): Promise<ResourceRow> {
  const r = await loadResource(sql, id);
  assertCanRead(r, viewer);
  return r;
}

export function assertCanRead(r: ResourceRow, viewer: Viewer): void {
  if (viewer.cap && viewer.cap.resource_id !== r.id) {
    throw new AcspError('capability_resource_mismatch', `Capability ${viewer.cap.id} belongs to another resource.`);
  }
  if (r.visibility === 'restricted' && !viewer.cap) {
    if (viewer.credentialError) throw new AcspError(viewer.credentialError.code as 'invalid_capability', viewer.credentialError.message);
    throw new AcspError('authentication_required', `Resource ${r.id} is restricted: reading requires a capability (?cap= or Authorization: Bearer).`);
  }
}

function viewerSection(r: ResourceRow, viewer: Viewer) {
  const cap = viewer.cap;
  return {
    authenticated: cap !== null,
    capability_id: cap?.id ?? null,
    session_id: cap?.session_id ?? null,
    is_owner: isOwner(cap),
    scopes: effectiveScopes(cap),
    expires_at: iso(cap?.expires_at ?? null),
    credential_error: viewer.credentialError ?? null,
    identity_assurance: cap ? 'capability' : 'none',
    summary: cap
      ? isOwner(cap)
        ? `You hold the OWNER capability (${cap.id}) for session "${cap.session_id}".`
        : `You hold delegated capability ${cap.id} for session "${cap.session_id}" with scopes [${cap.scopes.join(', ')}].`
      : r.visibility === 'unlisted'
        ? 'No capability presented. You can read this resource, propose operations (identity asserted) and fork it. You cannot change it.'
        : 'No capability presented.',
  };
}

interface PermissionContext {
  resource: ResourceRow;
  cap: VerifiedCapability | null;
  pendingHandoffsToViewer: number;
  tasksViewerHolds: number;
  /** Agent identities: the active embodiment, if any. */
  embodiment: EmbodimentRow | null;
}

function permission(spec: OperationSpec, c: PermissionContext): { permitted: boolean; reason: string } {
  const r = c.resource;
  if (spec.mutation && r.lifecycle === 'closed' && !spec.allowed_when_closed) {
    return { permitted: false, reason: 'The resource is closed.' };
  }
  const d = authorize(spec, r, c.cap);
  if (!d.ok) return { permitted: false, reason: d.error.message };
  if (spec.name === 'propose' && !r.accepts_proposals) {
    return { permitted: false, reason: 'The owner has closed this resource to proposals.' };
  }
  if (spec.name === 'handoff' && !isOwner(c.cap) && c.tasksViewerHolds === 0) {
    return { permitted: false, reason: 'You hold the handoff scope but are not responsible for any active task.' };
  }
  if (spec.name === 'acknowledge' && c.pendingHandoffsToViewer === 0) {
    return { permitted: false, reason: 'No pending handoff is addressed to your session.' };
  }
  const e = c.embodiment;
  if (spec.name === 'embody') {
    if (isOwner(c.cap)) return { permitted: false, reason: 'The owner (principal) authorizes the identity but cannot embody it. Delegate "embody" to a session.' };
    if (e) return { permitted: false, reason: `Embodied by session "${e.session_id}" (${e.id}); it must be released first.` };
  }
  if (spec.name === 'release') {
    if (!e) return { permitted: false, reason: 'No embodiment is active.' };
    if (!isOwner(c.cap) && e.session_id !== c.cap?.session_id) return { permitted: false, reason: `${e.id} belongs to session "${e.session_id}".` };
  }
  if (spec.requires_embodiment && (!e || e.session_id !== c.cap?.session_id)) {
    return {
      permitted: false,
      reason: e
        ? `Acts as the identity: only the embodied session "${e.session_id}" may perform it.${spec.proposable ? ' You may propose it.' : ''}`
        : `Acts as the identity: a session must "embody" it first.${spec.proposable ? ' You may propose it.' : ''}`,
    };
  }
  if (spec.name === 'propose' && !c.cap) {
    return { permitted: true, reason: 'Anyone who can read may propose; your identity will be recorded as asserted.' };
  }
  return { permitted: true, reason: spec.mutation ? `Your capability satisfies: ${spec.authority_text}` : 'Read access.' };
}

function operationEntries(id: string, l: Links, c: PermissionContext) {
  return OPERATIONS.filter((o) => o.name !== 'create' && appliesTo(o, c.resource.kind)).map((spec) => {
    const p = permission(spec, c);
    const readHref: Record<string, string> = {
      inspect: l.resource(id),
      status: l.resource(id, '', { action: 'status' }),
      retrieve: `${l.plain(`/r/${id}/knowledge/`)}{tokId}`,
      diff: l.resource(id, '/diff', { from: 1 }),
      identify: l.resource(id, '/identity'),
      discover_substrates: l.resource(id, '/substrates'),
      read_scrolls: l.resource(id, '/scrolls'),
      resolve_alias: `${l.plain(`/r/${id}/aliases/`)}{name}`,
      read_executions: l.resource(id, '/executions'),
      export_transitions: l.resource(id, '/transitions'),
    };
    return {
      name: spec.name,
      family: spec.family,
      mutation: spec.mutation,
      purpose: spec.purpose,
      method: spec.invocation.method,
      href: spec.mutation ? l.plain(`/r/${id}/operations`) : readHref[spec.name],
      prepare_href: spec.mutation ? l.resource(id, '', { action: `prepare_${spec.name}` }) : null,
      doc_href: l.plain(`/protocol#op-${spec.name}`),
      required_authority: describeRequirement(spec.authority),
      authority_text: spec.authority_text,
      requires_expected_version: spec.requires_expected_version,
      proposable: spec.proposable,
      ...(spec.requires_embodiment ? { requires_embodiment: true } : {}),
      permitted_for_viewer: p.permitted,
      reason: p.reason,
    };
  });
}

/** Load everything the resource document needs. */
export async function loadResourceView(sql: Sql, r: ResourceRow) {
  const toks = await loadToks(sql, r.id);
  const annotations = await loadAnnotations(sql, r.id);
  const handoffs = await loadHandoffs(sql, r.id);
  const proposals = await loadProposals(sql, r.id);
  const capabilities = await loadCapabilities(sql, r.id);
  const checkpoints = await loadCheckpoints(sql, r.id);
  const recent = await loadRecentEvents(sql, r.id, RESOURCE_LIMITS.recentEvents);
  const first = (await loadEvents(sql, r.id, { after: 0, limit: 1 }))[0];
  const forks = await loadForks(sql, r.id);
  const parent = r.parent_id
    ? (await sql.query<Pick<ResourceRow, 'id' | 'title' | 'owner_session_id'>>('select id, title, owner_session_id from resources where id = $1', [r.parent_id])).rows[0]
    : null;
  const identity = r.kind === 'agent_identity' ? await loadIdentityView(sql, r) : null;
  return { resource: r, toks, annotations, handoffs, proposals, capabilities, checkpoints, recent, first, forks, parent, identity };
}

/** Program 001 state of an agent identity. */
export async function loadIdentityView(sql: Sql, r: ResourceRow) {
  const embodiments = await loadEmbodiments(sql, r.id);
  const scrolls = await loadScrolls(sql, r.id);
  const aliases = groupAliases(await loadAliasBindings(sql, r.id));
  const executions = await loadExecutions(sql, r.id, { recent: RESOURCE_LIMITS.recentExecutions });
  const announcements = (
    await sql.query<EventRow>(`select * from events where resource_id = $1 and operation = 'announce' order by version desc limit 20`, [r.id])
  ).rows.reverse();
  const checkpoints = await loadCheckpoints(sql, r.id);
  return { embodiments, scrolls, aliases, executions, announcements, checkpoints, active: embodiments.find((e) => e.status === 'active') ?? null };
}
export type IdentityView = Awaited<ReturnType<typeof loadIdentityView>>;


function scrollSummaries(v: IdentityView, l: Links, rid: string) {
  const by = new Map<string, ScrollRow[]>();
  for (const s of v.scrolls) by.set(s.scroll_id, [...(by.get(s.scroll_id) ?? []), s]);
  return Array.from(by.entries()).map(([scroll_id, versions]) => {
    const latest = versions[versions.length - 1];
    const aliasesOf = (s: ScrollRow) => v.aliases.filter((a) => a.target.ref === refString(s)).map((a) => a.name);
    return {
      scroll_id,
      latest_version: latest.version,
      purpose: latest.content.purpose,
      href: l.resource(rid, `/scrolls/${scroll_id}`),
      latest: scrollVersionRecord(latest, { aliases: aliasesOf(latest), checkpoints: v.checkpoints }),
      lineage: versions.map((s) => ({
        version: s.version,
        ref: refString(s),
        parent_version: s.parent_version,
        content_sha256: s.content_sha256,
        event_version: s.event_version,
        aliases: aliasesOf(s),
        ...commitState(s.event_version, v.checkpoints),
      })),
    };
  });
}

const substrateSummary = (l: Links) =>
  SUBSTRATES.map((s) => ({
    substrate_id: s.manifest.substrate_id,
    kind: s.manifest.kind,
    version: s.manifest.version,
    status: s.manifest.status,
    execution_mode: s.manifest.execution_mode,
    capabilities: s.manifest.capabilities,
    manifest_sha256: manifestHash(s.manifest),
    href: l.plain(`/substrates/${s.manifest.substrate_id}`),
  }));

function compactExecution(x: ExecutionRow, l: Links, rid: string) {
  const r = executionRecord(x);
  return {
    execution_id: r.execution_id,
    kind: r.kind,
    scroll: r.scroll?.ref ?? null,
    candidate_sha256: r.candidate?.content_sha256 ?? null,
    via_alias: r.via_alias,
    status: r.status,
    inputs: r.inputs,
    outputs: r.outputs,
    error: r.error,
    session_id: r.session.session_id,
    embodiment_id: r.embodiment_id,
    model: r.model,
    substrates: r.substrates_used.map((s) => s.substrate_id),
    event_version: r.event_version,
    href: l.resource(rid, `/executions/${r.execution_id}`),
  };
}

/** The Program 001 sections of an agent identity's document. */
export function identitySections(r: ResourceRow, v: IdentityView, viewer: Viewer, l: Links) {
  const e = v.active;
  const cp = v.checkpoints[v.checkpoints.length - 1];
  const current = r.current_substrate_id ? getSubstrate(r.current_substrate_id) : undefined;
  const cap = viewer.cap;
  return {
    identity: {
      agent_id: r.id,
      kind: 'agent_identity' as const,
      url: l.resource(r.id),
      status: r.lifecycle === 'active' ? 'active' : 'retired',
      embodiment_status: e ? 'embodied' : 'unembodied',
      display_name: r.title,
      description: r.description,
      owner_principal: r.owner_human,
      also_known_as: r.also_known_as,
      created_at: iso(r.created_at),
      current_embodiment: e ? embodimentRecord(e) : null,
      current_session: e ? { session_id: e.session_id } : null,
      current_model: e?.model ?? null,
      current_application: e?.application ?? null,
      current_substrate: current ? substrateRef(current) : null,
      current_checkpoint: cp ? { ...checkpointRecord(cp), href: l.resource(r.id, `/checkpoints/${cp.number}`) } : null,
      assurance:
        'Self-asserted and capability-bound. agent_id is this resource\'s id. Acting AS the identity requires a capability bound to your session AND being its current embodiment. ' +
        'There is no cryptographic identity: whoever holds a capability can use it.',
      dimensions: {
        agent_identity: { value: r.id, meaning: 'The persistent identity. It survives sessions, model changes and substrate changes.' },
        human_principal: { value: r.owner_human, meaning: 'The accountable human who authorizes the identity (owner_human). The principal is not the agent.' },
        resource_ownership: { value: r.owner_session_id, meaning: 'The session holding the owner capability (normally the principal\'s). Ownership is not identity.' },
        session: { value: e?.session_id ?? null, meaning: 'The session currently embodying the identity. Sessions end; the identity does not.' },
        model: { value: e?.model ?? null, meaning: 'The model the embodying session declared (self-asserted). A model change is not an identity change.' },
        application: { value: e?.application ?? null, meaning: 'The application the embodying session declared (self-asserted).' },
        substrate: { value: r.current_substrate_id, meaning: 'Where the identity\'s operations execute by default. A substrate change is not an identity change.' },
        capability: {
          value: cap ? { id: cap.id, session_id: cap.session_id, scopes: cap.scopes } : null,
          meaning: 'YOUR presented capability: authority for one session on this resource. A capability is not identity.',
        },
        software_label: { value: 'actor.agent_id', meaning: 'The ACSP/0.1 actor field agent_id is a self-asserted software/model label, NOT this agent identity.' },
      },
      embodiments: v.embodiments.map(embodimentRecord),
    },
    substrates: {
      question: 'What computational substrates are available to this identity, and what can each do?',
      current: current ? substrateRef(current) : null,
      available: substrateSummary(l),
      registry: l.plain('/substrates'),
    },
    scrolls: {
      semantics: 'A Scroll version is an immutable computational artifact. New versions add lineage; nothing is mutated in place. Reading a Scroll never executes it.',
      count: new Set(v.scrolls.map((s) => s.scroll_id)).size,
      version_count: v.scrolls.length,
      items: scrollSummaries(v, l, r.id),
      href: l.resource(r.id, '/scrolls'),
    },
    aliases: {
      semantics: 'An alias names an explicit Scroll version. Rebinding is recorded; earlier bindings remain in history.',
      items: v.aliases.map((a) => ({ ...a, href: l.resource(r.id, `/aliases/${a.name}`) })),
      href: l.resource(r.id, '/aliases'),
    },
    executions: {
      semantics: 'Append-only. Definition (Scroll) ≠ execution (this record) ≠ result (its outputs).',
      count: r.execution_count,
      recent: v.executions.map((x) => compactExecution(x, l, r.id)),
      href: l.resource(r.id, '/executions'),
    },
    announcements: v.announcements.map((a) => ({ id: `${a.resource_id}@${a.version}`, version: a.version, by: a.actor_session_id, ...a.data })),
    intent_states: INTENT_STATES,
  };
}
export type ResourceView = Awaited<ReturnType<typeof loadResourceView>>;

export function buildResourceDocument(v: ResourceView, viewer: Viewer, l: Links, now: Date) {
  const r = v.resource;
  const cap = viewer.cap;
  const knowledge = v.toks.map((t) => tokRecord(t, v.annotations));
  const latestCp = v.checkpoints[v.checkpoints.length - 1];
  const pendingToViewer = cap ? v.handoffs.filter((h) => h.status === 'pending' && h.to_session_id === cap.session_id) : [];
  const tasksHeld = cap ? v.toks.filter((t) => t.type === 'task' && t.status === 'active' && t.responsible_session_id === cap.session_id) : [];
  const embodiment = v.identity?.active ?? null;
  const operations = operationEntries(r.id, l, {
    resource: r,
    cap,
    pendingHandoffsToViewer: pendingToViewer.length,
    tasksViewerHolds: tasksHeld.length,
    embodiment,
  });
  const permitted = new Set(operations.filter((o) => o.permitted_for_viewer).map((o) => o.name));
  const links = resourceLinks(r.id, l);

  const next: { action: string; why: string; href: string }[] = [];
  if (knowledge.length) {
    next.push({ action: 'read knowledge', why: `${knowledge.length} TOK(s) are published here; read them before contributing.`, href: `${links.self}#knowledge` });
  }
  for (const h of pendingToViewer) {
    next.push({ action: 'acknowledge', why: `${h.id} offers you responsibility for ${h.tok_id}. Accept or decline it.`, href: l.resource(r.id, '', { action: 'prepare_acknowledge', handoff_id: h.id }) });
  }
  if (latestCp && latestCp.number > 0) {
    next.push({ action: 'resume from checkpoint', why: `Checkpoint ${latestCp.number} ("${latestCp.label}") is the latest boundary; read it, then the diff since.`, href: l.resource(r.id, '/diff', { since_checkpoint: latestCp.number }) });
  }
  if (v.identity) identityNextActions(next, r, v.identity, cap, permitted, l);
  if (r.lifecycle === 'closed') {
    if (permitted.has('fork')) {
      next.push({ action: 'fork', why: 'The resource is closed. Fork it to continue the research in an independent branch.', href: l.resource(r.id, '', { action: 'prepare_fork' }) });
    }
  } else if (v.identity) {
    if (!cap) {
      next.push({ action: 'request a capability', why: 'To act as this identity, ask its principal (the owner) to delegate a capability bound to YOUR session, then embody it.', href: links.protocol + '#op-embody' });
    }
  } else {
    if (permitted.has('append')) {
      next.push({ action: 'append', why: 'You may publish new TOKs.', href: l.resource(r.id, '', { action: 'prepare_append' }) });
    } else if (permitted.has('propose')) {
      next.push({ action: 'propose', why: 'You lack authority to change this resource, but you can propose an operation for the owner to accept.', href: l.resource(r.id, '', { action: 'prepare_propose' }) });
    }
    if (!cap) {
      next.push({ action: 'request a capability', why: 'To contribute directly, ask the owner (via your human) to delegate a capability bound to your session.', href: links.protocol + '#op-delegate' });
    }
    next.push({ action: 'fork', why: 'Branch the research independently. The parent is not modified.', href: l.resource(r.id, '', { action: 'prepare_fork' }) });
  }

  return {
    protocol: protocolHeader(l),
    type: v.identity ? 'agent_identity' : 'continuity_resource',
    notice: NOTICE,
    bootstrap: bootstrapDocument(),
    ...(v.identity ? { identity_bootstrap: identityBootstrapDocument() } : {}),
    resource: {
      id: r.id,
      url: links.self,
      title: r.title,
      description: r.description,
      focus: r.focus,
      created_at: iso(r.created_at),
      updated_at: iso(r.updated_at),
      created_by: v.first ? eventRecord(v.first).actor : null,
      lineage: {
        parent: v.parent
          ? { id: v.parent.id, title: v.parent.title, url: l.resource(v.parent.id), version: r.parent_version, checkpoint: r.parent_checkpoint }
          : null,
        forks: v.forks.map((f) => ({
          id: f.id,
          title: f.title,
          url: l.resource(f.id),
          owner_session_id: f.owner_session_id,
          from_version: f.parent_version,
          from_checkpoint: f.parent_checkpoint,
          lifecycle: f.lifecycle,
          created_at: iso(f.created_at),
        })),
        note: 'Branches retain ancestry and never merge.',
      },
    },
    state: {
      lifecycle: r.lifecycle,
      version: r.version,
      checkpoint: latestCp ? { ...checkpointRecord(latestCp), href: l.resource(r.id, `/checkpoints/${latestCp.number}`) } : null,
      closed_at: iso(r.closed_at),
      counts: {
        knowledge: knowledge.length,
        active_knowledge: knowledge.filter((k) => k.status === 'active').length,
        annotations: v.annotations.length,
        checkpoints: v.checkpoints.length,
        events: r.version,
        pending_handoffs: v.handoffs.filter((h) => h.status === 'pending').length,
        pending_proposals: v.proposals.filter((p) => p.status === 'pending').length,
      },
    },
    ownership: {
      owner: { session_id: r.owner_session_id, agent_id: r.owner_agent_id, human: r.owner_human },
      meaning:
        'The owner session is accountable for this resource and alone may update, delegate, revoke, resolve proposals and close. ' +
        'Ownership is not universal authority: no one can rewrite history or act for another session.',
    },
    access: {
      visibility: r.visibility,
      meaning: VISIBILITY_MEANINGS[r.visibility],
      accepts_proposals: r.accepts_proposals,
    },
    authority: {
      model:
        'Authority is carried only by capabilities (bearer tokens bound to one resource and one session). ' +
        'Knowing this URL grants no authority. Delegation grants scopes; handoff moves task responsibility only.',
      scopes: SCOPE_MEANINGS,
      delegations: v.capabilities.filter((c) => c.kind === 'delegation').map((c) => capabilityRecord(c, now)),
      owner_capability: v.capabilities.filter((c) => c.kind === 'owner').map((c) => ({ id: c.id, session_id: c.session_id, status: capabilityRecord(c, now).status }))[0] ?? null,
      task_responsibility: v.toks
        .filter((t) => t.type === 'task')
        .map((t) => ({
          tok_id: t.id,
          title: t.title,
          status: t.status,
          responsible_session_id: t.responsible_session_id,
          pending_handoff: v.handoffs.find((h) => h.tok_id === t.id && h.status === 'pending')?.id ?? null,
        })),
    },
    viewer: { ...viewerSection(r, viewer), ...(v.identity ? { embodied: !!embodiment && embodiment.session_id === cap?.session_id } : {}) },
    ...(v.identity ? identitySections(r, v.identity, viewer, l) : {}),
    knowledge: {
      semantics: KNOWLEDGE_SEMANTICS,
      items: knowledge,
    },
    handoffs: v.handoffs.map(handoffRecord),
    proposals: v.proposals.map(proposalRecord),
    checkpoints: v.checkpoints.map((c) => ({ ...checkpointRecord(c), href: l.resource(r.id, `/checkpoints/${c.number}`) })),
    operations,
    next_valid_actions: next,
    provenance: {
      created: v.first ? eventRecord(v.first) : null,
      latest: v.recent.length ? eventRecord(v.recent[v.recent.length - 1]) : null,
      event_count: r.version,
      recent_events: v.recent.map(eventRecord),
      history: links.events,
    },
    links: v.identity ? { ...links, ...identityLinks(r.id, l) } : links,
  };
}
export type ResourceDocument = ReturnType<typeof buildResourceDocument>;

function identityNextActions(
  next: { action: string; why: string; href: string }[],
  r: ResourceRow,
  v: IdentityView,
  cap: VerifiedCapability | null,
  permitted: Set<string>,
  l: Links,
) {
  if (r.lifecycle === 'closed') return;
  const e = v.active;
  const cp = v.checkpoints[v.checkpoints.length - 1];
  if (permitted.has('embody')) {
    next.push({
      action: 'embody',
      why: cp && cp.number > 0
        ? `No session embodies this identity. Read checkpoint ${cp.number} to recover its state, then embody it as your own session.`
        : 'No session embodies this identity. Embody it as your own session to act as it.',
      href: l.resource(r.id, '', { action: 'prepare_embody' }),
    });
  }
  if (e && cap && e.session_id === cap.session_id) {
    if (!r.current_substrate_id && permitted.has('set_substrate')) {
      next.push({ action: 'set_substrate', why: 'No substrate is selected. Choose one from "substrates".', href: l.resource(r.id, '', { action: 'prepare_set_substrate' }) });
    }
    if (v.aliases.length && permitted.has('execute')) {
      next.push({ action: 'execute', why: `Reuse a named Scroll: ${v.aliases.map((a) => `"${a.name}" → ${a.target.ref}`).join(', ')}.`, href: l.resource(r.id, '', { action: 'prepare_execute', alias: v.aliases[0].name }) });
    }
    if (permitted.has('create_scroll')) {
      next.push({ action: 'create_scroll', why: 'Commit a new Scroll from substrate operations or earlier Scroll versions.', href: l.resource(r.id, '', { action: 'prepare_create_scroll' }) });
    }
  } else if (e) {
    next.push({ action: 'propose', why: `The identity is embodied by session "${e.session_id}". Without being its embodiment you can propose create_scroll, version_scroll, set_alias or execute.`, href: l.resource(r.id, '', { action: 'prepare_propose', proposed_operation: 'execute' }) });
  } else if (!cap) {
    next.push({ action: 'propose', why: 'You hold no capability. You may read everything and propose an operation (for example execute) for the principal to accept.', href: l.resource(r.id, '', { action: 'prepare_propose', proposed_operation: 'execute' }) });
  }
  if (v.aliases.length) {
    next.push({ action: 'resolve alias', why: 'Aliases name explicit Scroll versions; resolving is a read and changes nothing.', href: l.resource(r.id, '/aliases') });
  }
}


export function statusDocument(r: ResourceRow, checkpoints: { number: number; version: number; label: string }[], l: Links) {
  const cp = checkpoints[checkpoints.length - 1];
  return {
    protocol: protocolHeader(l),
    type: 'status',
    notice: NOTICE,
    resource_id: r.id,
    title: r.title,
    lifecycle: r.lifecycle,
    version: r.version,
    checkpoint: cp ? { number: cp.number, version: cp.version, label: cp.label } : null,
    counts: { knowledge: r.tok_count, annotations: r.annotation_count, handoffs: r.handoff_count, proposals: r.proposal_count, checkpoints: r.checkpoint_count },
    updated_at: iso(r.updated_at),
    links: resourceLinks(r.id, l),
  };
}

export async function eventsDocument(sql: Sql, r: ResourceRow, l: Links, after: number, limit: number) {
  const events = (await loadEvents(sql, r.id, { after, limit })).map(eventRecord);
  const last = events[events.length - 1];
  return {
    protocol: protocolHeader(l),
    type: 'event_list',
    notice: NOTICE,
    resource_id: r.id,
    current_version: r.version,
    semantics: 'Append-only history. Each event is one state change; version increases by exactly 1 per event.',
    after,
    events,
    next: last && last.version < r.version ? l.resource(r.id, '/events', { after: last.version, limit }) : null,
    links: resourceLinks(r.id, l),
  };
}

export async function eventDocument(sql: Sql, r: ResourceRow, l: Links, version: number) {
  return {
    protocol: protocolHeader(l),
    type: 'event',
    notice: NOTICE,
    resource_id: r.id,
    event: eventRecord(await loadEvent(sql, r.id, version)),
    links: resourceLinks(r.id, l),
  };
}

export async function tokDocument(sql: Sql, r: ResourceRow, l: Links, tokId: string) {
  const toks = await loadToks(sql, r.id);
  const t = toks.find((x) => x.id === tokId);
  if (!t) throw new AcspError('not_found', `Resource ${r.id} has no ${tokId}.`);
  return {
    protocol: protocolHeader(l),
    type: 'tok',
    notice: NOTICE,
    resource_id: r.id,
    semantics: KNOWLEDGE_SEMANTICS,
    tok: tokRecord(t, await loadAnnotations(sql, r.id)),
    links: resourceLinks(r.id, l),
  };
}

export async function checkpointsDocument(sql: Sql, r: ResourceRow, l: Links) {
  return {
    protocol: protocolHeader(l),
    type: 'checkpoint_list',
    notice: NOTICE,
    resource_id: r.id,
    semantics: 'A checkpoint is a deliberate, hashed boundary of the externally persisted state at one version. To resume: read the checkpoint, then the diff since it.',
    checkpoints: (await loadCheckpoints(sql, r.id)).map((c) => ({
      ...checkpointRecord(c),
      href: l.resource(r.id, `/checkpoints/${c.number}`),
      diff_since: l.resource(r.id, '/diff', { since_checkpoint: c.number }),
    })),
    links: resourceLinks(r.id, l),
  };
}

export async function checkpointDocument(sql: Sql, r: ResourceRow, l: Links, n: number) {
  const c = await loadCheckpoint(sql, r.id, n);
  return {
    protocol: protocolHeader(l),
    type: 'checkpoint',
    notice: NOTICE,
    resource_id: r.id,
    verification: 'sha256 is "sha256:" + hex(SHA-256(canonical JSON of snapshot)), where canonical JSON sorts object keys and has no whitespace.',
    checkpoint: checkpointRecord(c, true),
    diff_since: l.resource(r.id, '/diff', { since_checkpoint: n }),
    links: resourceLinks(r.id, l),
  };
}

export async function diffDocument(
  sql: Sql,
  r: ResourceRow,
  l: Links,
  q: { from?: number; to?: number; sinceCheckpoint?: number },
) {
  let from = q.from;
  if (q.sinceCheckpoint !== undefined) {
    from = (await loadCheckpoint(sql, r.id, q.sinceCheckpoint)).version;
  }
  const to = q.to ?? r.version;
  if (from === undefined || !Number.isInteger(from) || from < 0 || !Number.isInteger(to) || to < from || to > r.version) {
    throw new AcspError('malformed_request', `Diff bounds must satisfy 0 <= from <= to <= ${r.version}; use ?from=V[&to=W] or ?since_checkpoint=N.`);
  }
  const events = (await loadEvents(sql, r.id, { after: from, upTo: to })).map(eventRecord);
  const annotations = await loadAnnotations(sql, r.id);
  const toks = await loadToks(sql, r.id);
  return {
    protocol: protocolHeader(l),
    type: 'diff',
    notice: NOTICE,
    resource_id: r.id,
    from,
    to,
    since_checkpoint: q.sinceCheckpoint ?? null,
    semantics: 'Every event with from < version <= to, plus TOKs created and superseded in that range. Current TOK status is shown; history is in the events.',
    events,
    knowledge_added: toks.filter((t) => t.version > from! && t.version <= to).map((t) => tokRecord(t, annotations)),
    knowledge_superseded: events
      .filter((e) => e.operation === 'supersede')
      .map((e) => ({ target: e.data.target, replacement: e.data.replacement, reason: e.data.reason, version: e.version })),
    links: resourceLinks(r.id, l),
  };
}

export function operationsDocument(doc: ResourceDocument) {
  return {
    protocol: doc.protocol,
    type: 'operation_list',
    notice: NOTICE,
    resource_id: doc.resource.id,
    version: doc.state.version,
    lifecycle: doc.state.lifecycle,
    viewer: doc.viewer,
    envelope: {
      description: 'POST this JSON to the operation href (Content-Type: application/json, Authorization: Bearer <capability>).',
      example: {
        protocol: PROTOCOL_VERSION,
        operation: 'append',
        actor: { session_id: '<your session id>', agent_id: '<your agent label>', kind: 'agent' },
        expected_version: doc.state.version,
        idempotency_key: '<unique per intended mutation>',
        payload: { type: 'finding', title: '...', content: '...' },
      },
    },
    operations: doc.operations,
    next_valid_actions: doc.next_valid_actions,
    links: doc.links,
  };
}

// ── Program 001 read documents ─────────────────────────────────────────────

export function assertIdentity(r: ResourceRow): void {
  if (r.kind !== 'agent_identity') throw new AcspError('not_found', `Resource ${r.id} is not an agent identity (kind "${r.kind}").`);
}

const idHeader = (r: ResourceRow, l: Links) => ({
  protocol: protocolHeader(l),
  notice: NOTICE,
  agent_id: r.id,
  version: r.version,
  links: { ...resourceLinks(r.id, l), ...identityLinks(r.id, l) },
});

export async function identityDocument(sql: Sql, r: ResourceRow, viewer: Viewer, l: Links) {
  assertIdentity(r);
  const v = await loadIdentityView(sql, r);
  const s = identitySections(r, v, viewer, l);
  return { ...idHeader(r, l), type: 'identity', identity_bootstrap: identityBootstrapDocument(), ...s };
}

export function substrateManifestDocument(id: string, l: Links) {
  const s = getSubstrate(id);
  if (!s) throw new AcspError('not_found', `No substrate "${id}". See ${l.plain('/substrates')}.`);
  return {
    protocol: protocolHeader(l),
    type: 'substrate',
    notice: NOTICE,
    manifest: s.manifest,
    manifest_sha256: manifestHash(s.manifest),
    links: { registry: l.plain('/substrates'), protocol: l.plain('/protocol') },
  };
}

export function substrateRegistryDocument(l: Links, r?: ResourceRow) {
  const cur = r?.current_substrate_id ? getSubstrate(r.current_substrate_id) : undefined;
  const current = cur ? substrateRef(cur) : null;
  return {
    protocol: protocolHeader(l),
    type: 'substrate_registry',
    notice: NOTICE,
    semantics:
      'A computational substrate is the environment through which an identity performs an operation. It is not a model and not an identity. ' +
      'Each manifest lists its operations with input/output schemas, determinism, side effects and required authority. GET never executes anything.',
    ...(r ? { agent_id: r.id, current } : {}),
    substrates: SUBSTRATES.map((s) => ({ ...s.manifest, manifest_sha256: manifestHash(s.manifest), href: l.plain(`/substrates/${s.manifest.substrate_id}`) })),
    links: (r ? { ...resourceLinks(r.id, l), ...identityLinks(r.id, l) } : { registry: l.plain('/substrates'), protocol: l.plain('/protocol') }) as Record<string, string>,
  };
}

export async function scrollsDocument(sql: Sql, r: ResourceRow, l: Links, scrollId?: string, version?: number) {
  assertIdentity(r);
  const v = await loadIdentityView(sql, r);
  const items = scrollSummaries(v, l, r.id);
  if (!scrollId) {
    return { ...idHeader(r, l), type: 'scroll_list', semantics: 'Each Scroll with its lineage. Follow href for every version with content.', scrolls: items };
  }
  const versions = v.scrolls.filter((s) => s.scroll_id === scrollId);
  if (!versions.length) throw new AcspError('not_found', `Agent identity ${r.id} has no Scroll ${scrollId}.`);
  const aliasesOf = (s: ScrollRow) => v.aliases.filter((a) => a.target.ref === refString(s)).map((a) => a.name);
  const records = versions.map((s) => scrollVersionRecord(s, { aliases: aliasesOf(s), checkpoints: v.checkpoints }));
  if (version !== undefined) {
    const one = records.find((x) => x.version === version);
    if (!one) throw new AcspError('not_found', `${scrollId} has no version ${version}.`);
    return { ...idHeader(r, l), type: 'scroll_version', scroll: one };
  }
  return {
    ...idHeader(r, l),
    type: 'scroll',
    scroll_id: scrollId,
    latest_version: versions[versions.length - 1].version,
    semantics: 'Versions are immutable and ordered; parent_version records lineage; content_sha256 is sha256 of the canonical JSON of content.',
    versions: records,
  };
}

export async function aliasesDocument(sql: Sql, r: ResourceRow, l: Links, name?: string) {
  assertIdentity(r);
  const aliases = groupAliases(await loadAliasBindings(sql, r.id));
  if (!name) return { ...idHeader(r, l), type: 'alias_list', aliases: aliases.map((a) => ({ ...a, href: l.resource(r.id, `/aliases/${a.name}`) })) };
  const a = aliases.find((x) => x.name === name);
  if (!a) throw new AcspError('not_found', `Agent identity ${r.id} has no alias "${name}".`);
  return {
    ...idHeader(r, l),
    type: 'alias',
    alias: a,
    resolves_to: { ...a.target, href: l.resource(r.id, `/scrolls/${a.target.scroll_id}`, { version: a.target.version }) },
    notice_resolution: 'Resolving an alias is a read. It is not recorded and does not depend on any session.',
  };
}

export async function executionsDocument(sql: Sql, r: ResourceRow, l: Links, q: { id?: string; after?: number; limit?: number }) {
  assertIdentity(r);
  if (q.id) {
    const { rows } = await sql.query<ExecutionRow>('select * from executions where resource_id = $1 and id = $2', [r.id, q.id]);
    if (!rows[0]) throw new AcspError('not_found', `Agent identity ${r.id} has no execution ${q.id}.`);
    return { ...idHeader(r, l), type: 'execution', execution: executionRecord(rows[0]) };
  }
  const limit = Math.min(q.limit ?? RESOURCE_LIMITS.executionsPageMax, RESOURCE_LIMITS.executionsPageMax);
  const rows = await loadExecutions(sql, r.id, { after: q.after ?? 0, limit });
  const last = rows[rows.length - 1];
  return {
    ...idHeader(r, l),
    type: 'execution_list',
    semantics: 'Append-only execution history, oldest first.',
    count: r.execution_count,
    after: q.after ?? 0,
    executions: rows.map(executionRecord),
    next: last && last.number < r.execution_count ? l.resource(r.id, '/executions', { after: last.number, limit }) : null,
  };
}

/**
 * The SubstrateIO bridge: the identity's history as a transition sequence.
 * ACSP is the system under observation; this is a projection an independent
 * instrument can consume without importing ACSP. Logical time is the event
 * version; wall-clock time is carried but excluded from the hash.
 */
export async function transitionsDocument(sql: Sql, r: ResourceRow, l: Links) {
  assertIdentity(r);
  const events = await loadEvents(sql, r.id);
  const records = events.map(eventRecord);
  const labels = deriveObservations(records, true);
  const checkpoints = await loadCheckpoints(sql, r.id);
  let embodiment: { embodiment_id: string; session_id: string; model: unknown; application: unknown } | null = null;
  let substrate: string | null = null;
  const transitions = records.map((e, i) => {
    const d = e.data as Record<string, any>;
    if (e.operation === 'embody') embodiment = { embodiment_id: d.embodiment_id, session_id: d.session_id, model: d.model ?? null, application: d.application ?? null };
    if (e.operation === 'release' || (e.operation === 'close' && d.released_embodiments?.length)) embodiment = null;
    if (e.operation === 'set_substrate') substrate = d.to ?? null;
    const cp = [...checkpoints].reverse().find((c) => c.version <= e.version);
    const scroll = d.scroll?.ref ?? (d.ref as string | undefined) ?? null;
    return {
      t: e.version,
      from_version: e.parent_version,
      to_version: e.version,
      event_id: e.id,
      operation: e.operation,
      actor: { session_id: e.actor.session_id, software_label: e.actor.agent_id, kind: e.actor.kind },
      identity_assurance: e.identity_assurance,
      on_behalf_of: e.on_behalf_of ? { session_id: e.on_behalf_of.session_id } : null,
      proposal_id: e.proposal_id,
      embodiment: embodiment ? { ...(embodiment as object) } : null,
      substrate_after: substrate,
      scroll,
      execution: d.execution_id ? { execution_id: d.execution_id, status: d.status, outputs: d.outputs ?? null } : null,
      trials: e.operation === 'discover_new_operation' ? d.trials : null,
      alias: e.operation === 'set_alias' ? { name: d.name, binding: d.binding, target: d.target.ref, previous: d.previous } : d.via_alias ?? null,
      checkpoint_in_effect: cp ? cp.number : null,
      checkpoint_created: e.operation === 'checkpoint' ? d.number : null,
      observations: labels[i],
      occurred_at: e.occurred_at,
    };
  });
  const deterministic = transitions.map(({ occurred_at: _wall, ...rest }) => rest);
  return {
    protocol: protocolHeader(l),
    type: 'transition_history',
    format: 'acsp-transition-history/1',
    notice: NOTICE,
    agent_id: r.id,
    epistemic_status:
      'RECORDED protocol events of an ACSP agent identity. Executions are computations by ACSP substrates. Nothing here observes a model\'s internal state; ' +
      'model fields are self-declared by the embodying session.',
    logical_time: 't = event version (increases by exactly 1 per transition).',
    clocks: 'occurred_at is the server wall clock: an observation of the service, excluded from deterministic_sha256.',
    vocabulary: OBSERVATION_VOCABULARY,
    transition_count: transitions.length,
    transitions,
    deterministic_sha256: canonicalHash(deterministic),
    links: { ...resourceLinks(r.id, l), ...identityLinks(r.id, l) },
  };
}
