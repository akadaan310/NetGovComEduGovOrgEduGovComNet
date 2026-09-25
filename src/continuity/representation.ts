/**
 * The canonical resource document and the other read representations.
 *
 * Each document is plain JSON. The transport layer serialises it or renders
 * it to HTML (embedding it verbatim), so the formats cannot drift apart.
 */
import type { Sql } from '../db/types';
import { bootstrapDocument, NOTICE } from '../protocol/bootstrap';
import {
  INVARIANTS,
  PROTOCOL_NAME,
  PROTOCOL_TITLE,
  PROTOCOL_VERSION,
  RESOURCE_LIMITS,
  SCOPE_MEANINGS,
  VISIBILITY_MEANINGS,
} from '../protocol/constants';
import { OPERATIONS, type OperationSpec } from '../protocol/operations';
import { KNOWLEDGE_SEMANTICS } from '../research/tok';
import { authorize, describeRequirement, effectiveScopes, isOwner, type VerifiedCapability } from './authority';
import { AcspError } from '../protocol/errors';
import {
  capabilityRecord,
  checkpointRecord,
  eventRecord,
  handoffRecord,
  iso,
  proposalRecord,
  tokRecord,
  type ResourceRow,
} from './records';
import {
  loadAnnotations,
  loadCapabilities,
  loadCheckpoint,
  loadCheckpoints,
  loadEvent,
  loadEvents,
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

export const protocolHeader = (l: Links) => ({
  name: PROTOCOL_NAME,
  version: PROTOCOL_VERSION,
  title: PROTOCOL_TITLE,
  spec: l.plain('/protocol'),
  spec_json: l.plain('/protocol.json'),
  invariants: [...INVARIANTS],
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
  if (spec.name === 'propose' && !c.cap) {
    return { permitted: true, reason: 'Anyone who can read may propose; your identity will be recorded as asserted.' };
  }
  return { permitted: true, reason: spec.mutation ? `Your capability satisfies: ${spec.authority_text}` : 'Read access.' };
}

function operationEntries(id: string, l: Links, c: PermissionContext) {
  return OPERATIONS.filter((o) => o.name !== 'create').map((spec) => {
    const p = permission(spec, c);
    const readHref: Record<string, string> = {
      inspect: l.resource(id),
      status: l.resource(id, '', { action: 'status' }),
      retrieve: `${l.plain(`/r/${id}/knowledge/`)}{tokId}`,
      diff: l.resource(id, '/diff', { from: 1 }),
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
  return { resource: r, toks, annotations, handoffs, proposals, capabilities, checkpoints, recent, first, forks, parent };
}
export type ResourceView = Awaited<ReturnType<typeof loadResourceView>>;

export function buildResourceDocument(v: ResourceView, viewer: Viewer, l: Links, now: Date) {
  const r = v.resource;
  const cap = viewer.cap;
  const knowledge = v.toks.map((t) => tokRecord(t, v.annotations));
  const latestCp = v.checkpoints[v.checkpoints.length - 1];
  const pendingToViewer = cap ? v.handoffs.filter((h) => h.status === 'pending' && h.to_session_id === cap.session_id) : [];
  const tasksHeld = cap ? v.toks.filter((t) => t.type === 'task' && t.status === 'active' && t.responsible_session_id === cap.session_id) : [];
  const operations = operationEntries(r.id, l, {
    resource: r,
    cap,
    pendingHandoffsToViewer: pendingToViewer.length,
    tasksViewerHolds: tasksHeld.length,
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
  if (r.lifecycle === 'closed') {
    next.push({ action: 'fork', why: 'The resource is closed. Fork it to continue the research in an independent branch.', href: l.resource(r.id, '', { action: 'prepare_fork' }) });
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
    type: 'continuity_resource',
    notice: NOTICE,
    bootstrap: bootstrapDocument(),
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
    viewer: viewerSection(r, viewer),
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
    links,
  };
}
export type ResourceDocument = ReturnType<typeof buildResourceDocument>;

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
