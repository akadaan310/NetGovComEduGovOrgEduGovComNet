/**
 * Database row shapes and their public (protocol) representations.
 * Row → record mapping lives here so every surface (resource document,
 * retrieve endpoints, checkpoint snapshots) presents records identically.
 */
import type { ActorKind, ResourceKind, Scope, Visibility } from '../protocol/constants';
import { dependencies, refString, type ScrollContent, type StepRecord } from '../scrolls/scroll';
import type { Value } from '../substrates/types';

export type Assurance = 'capability' | 'asserted';

export interface ResourceRow {
  id: string;
  protocol: string;
  title: string;
  description: string;
  focus: string;
  lifecycle: 'active' | 'closed';
  visibility: Visibility;
  accepts_proposals: boolean;
  owner_session_id: string;
  owner_agent_id: string | null;
  owner_human: string | null;
  version: number;
  checkpoint_count: number;
  tok_count: number;
  annotation_count: number;
  handoff_count: number;
  proposal_count: number;
  parent_id: string | null;
  parent_version: number | null;
  parent_checkpoint: number | null;
  created_at: Date;
  updated_at: Date;
  closed_at: Date | null;
  // Program 001
  kind: ResourceKind;
  also_known_as: string[];
  current_substrate_id: string | null;
  scroll_count: number;
  execution_count: number;
  embodiment_count: number;
}

export interface EventRow {
  resource_id: string;
  version: number;
  parent_version: number;
  operation: string;
  actor_session_id: string;
  actor_agent_id: string | null;
  actor_kind: ActorKind;
  identity_assurance: Assurance;
  capability_id: string | null;
  on_behalf_of: Participant | null;
  proposal_id: string | null;
  occurred_at: Date;
  summary: string;
  data: Record<string, unknown>;
  request_hash: string | null;
  idempotency_key: string | null;
}

export interface TokRow {
  resource_id: string;
  id: string;
  type: string;
  title: string;
  summary: string;
  content: string;
  stated_confidence: string;
  status: 'active' | 'superseded';
  supersedes: string | null;
  superseded_by: string | null;
  supersession_reason: string | null;
  refs: unknown[];
  author_session_id: string;
  author_agent_id: string | null;
  author_kind: ActorKind;
  author_assurance: Assurance;
  recorded_by_session_id: string;
  proposal_id: string | null;
  version: number;
  after_checkpoint: number;
  created_at: Date;
  responsible_session_id: string | null;
  origin: Record<string, unknown> | null;
}

export interface AnnotationRow {
  resource_id: string;
  id: string;
  tok_id: string;
  kind: string;
  content: string;
  evidence: Record<string, unknown> | null;
  author_session_id: string;
  author_agent_id: string | null;
  author_kind: ActorKind;
  author_assurance: Assurance;
  recorded_by_session_id: string;
  proposal_id: string | null;
  version: number;
  created_at: Date;
}

export interface CheckpointRow {
  resource_id: string;
  number: number;
  version: number;
  label: string;
  note: string;
  snapshot?: Record<string, unknown>;
  snapshot_sha256: string;
  created_by_session_id: string;
  created_at: Date;
}

export interface CapabilityRow {
  id: string;
  resource_id: string;
  secret_hash: string;
  kind: 'owner' | 'delegation';
  session_id: string;
  agent_id: string | null;
  scopes: Scope[];
  label: string;
  delegated_by_session_id: string | null;
  created_version: number;
  created_at: Date;
  expires_at: Date | null;
  revoked_at: Date | null;
  revoked_version: number | null;
}

export interface HandoffRow {
  resource_id: string;
  id: string;
  tok_id: string;
  from_session_id: string;
  to_session_id: string;
  to_agent_id: string | null;
  note: string;
  status: 'pending' | 'accepted' | 'declined' | 'cancelled';
  created_version: number;
  resolved_version: number | null;
  resolution_note: string | null;
  created_at: Date;
}

export interface ProposalRow {
  resource_id: string;
  id: string;
  operation: string;
  payload: Record<string, unknown>;
  rationale: string;
  proposer_session_id: string;
  proposer_agent_id: string | null;
  proposer_kind: ActorKind;
  proposer_assurance: Assurance;
  status: 'pending' | 'accepted' | 'rejected' | 'cancelled';
  created_version: number;
  resolved_version: number | null;
  resolution_note: string | null;
  result: Record<string, unknown> | null;
  created_at: Date;
}

export interface Participant {
  session_id: string;
  agent_id: string | null;
  kind: ActorKind;
  identity_assurance: Assurance;
}

export const iso = (d: Date | string | null | undefined): string | null =>
  d == null ? null : (d instanceof Date ? d : new Date(d)).toISOString();

export const eventId = (resourceId: string, version: number) => `${resourceId}@${version}`;

export function eventRecord(e: EventRow) {
  return {
    id: eventId(e.resource_id, e.version),
    resource_id: e.resource_id,
    version: e.version,
    parent_version: e.parent_version,
    resulting_version: e.version,
    operation: e.operation,
    occurred_at: iso(e.occurred_at),
    actor: { session_id: e.actor_session_id, agent_id: e.actor_agent_id, kind: e.actor_kind },
    identity_assurance: e.identity_assurance,
    capability_id: e.capability_id,
    on_behalf_of: e.on_behalf_of,
    proposal_id: e.proposal_id,
    summary: e.summary,
    data: e.data,
    request_hash: e.request_hash,
    idempotency_key: e.idempotency_key,
  };
}
export type EventRecord = ReturnType<typeof eventRecord>;

export function annotationRecord(a: AnnotationRow) {
  return {
    id: a.id,
    tok_id: a.tok_id,
    kind: a.kind,
    content: a.content,
    evidence: a.evidence,
    ...(a.kind === 'validation'
      ? { note: 'Validation claimed by the annotator with the evidence given. ACSP has not verified it.' }
      : {}),
    source: {
      session_id: a.author_session_id,
      agent_id: a.author_agent_id,
      kind: a.author_kind,
      identity_assurance: a.author_assurance,
    },
    recorded_by: { session_id: a.recorded_by_session_id },
    proposal_id: a.proposal_id,
    version: a.version,
    created_at: iso(a.created_at),
  };
}

export function tokRecord(t: TokRow, annotations: AnnotationRow[] = []) {
  return {
    id: t.id,
    type: t.type,
    title: t.title,
    summary: t.summary,
    content: t.content,
    stated_confidence: t.stated_confidence,
    status: t.status,
    supersedes: t.supersedes,
    superseded_by: t.superseded_by,
    supersession_reason: t.supersession_reason,
    refs: t.refs,
    source: {
      session_id: t.author_session_id,
      agent_id: t.author_agent_id,
      kind: t.author_kind,
      identity_assurance: t.author_assurance,
    },
    recorded_by: { session_id: t.recorded_by_session_id },
    proposal_id: t.proposal_id,
    version: t.version,
    after_checkpoint: t.after_checkpoint,
    created_at: iso(t.created_at),
    task: t.type === 'task' ? { responsible_session_id: t.responsible_session_id } : null,
    origin: t.origin,
    annotations: annotations.filter((a) => a.tok_id === t.id).map(annotationRecord),
  };
}
export type TokRecord = ReturnType<typeof tokRecord>;

export function checkpointRecord(c: CheckpointRow, withSnapshot = false) {
  return {
    number: c.number,
    version: c.version,
    label: c.label,
    note: c.note,
    created_by: { session_id: c.created_by_session_id },
    created_at: iso(c.created_at),
    sha256: c.snapshot_sha256,
    ...(withSnapshot ? { snapshot: c.snapshot } : {}),
  };
}

export function capabilityStatus(c: CapabilityRow, now: Date): 'active' | 'expired' | 'revoked' {
  if (c.revoked_at) return 'revoked';
  if (c.expires_at && c.expires_at.getTime() <= now.getTime()) return 'expired';
  return 'active';
}

/** Public view of a capability. Never includes the secret or its hash. */
export function capabilityRecord(c: CapabilityRow, now: Date) {
  return {
    id: c.id,
    kind: c.kind,
    session_id: c.session_id,
    agent_id: c.agent_id,
    scopes: c.scopes,
    label: c.label,
    delegated_by: c.delegated_by_session_id,
    created_version: c.created_version,
    created_at: iso(c.created_at),
    expires_at: iso(c.expires_at),
    revoked_at: iso(c.revoked_at),
    status: capabilityStatus(c, now),
  };
}

export function handoffRecord(h: HandoffRow) {
  return {
    id: h.id,
    tok_id: h.tok_id,
    from: { session_id: h.from_session_id },
    to: { session_id: h.to_session_id, agent_id: h.to_agent_id },
    note: h.note,
    status: h.status,
    created_version: h.created_version,
    resolved_version: h.resolved_version,
    resolution_note: h.resolution_note,
    created_at: iso(h.created_at),
  };
}

export function proposalRecord(p: ProposalRow) {
  return {
    id: p.id,
    type: 'operation_intent',
    operation: p.operation,
    payload: p.payload,
    rationale: p.rationale,
    requested_by: {
      session_id: p.proposer_session_id,
      agent_id: p.proposer_agent_id,
      kind: p.proposer_kind,
      identity_assurance: p.proposer_assurance,
    },
    status: p.status,
    created_version: p.created_version,
    resolved_version: p.resolved_version,
    resolution_note: p.resolution_note,
    result: p.result,
    created_at: iso(p.created_at),
  };
}

// ── Program 001 ────────────────────────────────────────────────────────────

export interface ModelRef {
  provider: string;
  model_id: string;
  version?: string;
}

export interface EmbodimentRow {
  resource_id: string;
  id: string;
  session_id: string;
  agent_label: string | null;
  capability_id: string | null;
  model: ModelRef | null;
  application: { application_id: string } | null;
  note: string;
  status: 'active' | 'released';
  attached_version: number;
  released_version: number | null;
  release_reason: string | null;
  released_by_session_id: string | null;
  created_at: Date;
  released_at: Date | null;
}

export function embodimentRecord(e: EmbodimentRow) {
  return {
    id: e.id,
    status: e.status,
    session: { session_id: e.session_id, agent_label: e.agent_label, capability_id: e.capability_id },
    model: e.model,
    application: e.application,
    note: e.note,
    attached_version: e.attached_version,
    released_version: e.released_version,
    release_reason: e.release_reason,
    released_by: e.released_by_session_id ? { session_id: e.released_by_session_id } : null,
    attached_at: iso(e.created_at),
    released_at: iso(e.released_at),
  };
}
export type EmbodimentRecord = ReturnType<typeof embodimentRecord>;

export interface ScrollRow {
  resource_id: string;
  scroll_id: string;
  version: number;
  parent_version: number | null;
  content: ScrollContent;
  content_sha256: string;
  author_session_id: string;
  author_agent_id: string | null;
  author_kind: ActorKind;
  author_assurance: Assurance;
  recorded_by_session_id: string;
  embodiment_id: string | null;
  proposal_id: string | null;
  event_version: number;
  after_checkpoint: number;
  created_at: Date;
}

/**
 * Intent state of a committed record (Program 001): "committed" once its
 * event exists, "persisted" once a checkpoint at or after that event covers it.
 */
export const commitState = (eventVersion: number, checkpoints: { number: number; version: number }[]) => {
  const cp = checkpoints.find((c) => c.version >= eventVersion);
  return { state: cp ? ('persisted' as const) : ('committed' as const), persisted_in_checkpoint: cp ? cp.number : null };
};

export function scrollVersionRecord(s: ScrollRow, ctx: { aliases?: string[]; checkpoints?: { number: number; version: number }[] } = {}) {
  return {
    scroll_id: s.scroll_id,
    version: s.version,
    ref: refString({ scroll_id: s.scroll_id, version: s.version }),
    parent_version: s.parent_version,
    content_sha256: s.content_sha256,
    content: s.content,
    dependencies: dependencies(s.content),
    created_by: {
      session_id: s.author_session_id,
      agent_id: s.author_agent_id,
      kind: s.author_kind,
      identity_assurance: s.author_assurance,
      embodiment_id: s.embodiment_id,
    },
    recorded_by: { session_id: s.recorded_by_session_id },
    proposal_id: s.proposal_id,
    event_version: s.event_version,
    after_checkpoint: s.after_checkpoint,
    created_at: iso(s.created_at),
    aliases: ctx.aliases ?? [],
    ...(ctx.checkpoints ? commitState(s.event_version, ctx.checkpoints) : {}),
  };
}
export type ScrollVersionRecord = ReturnType<typeof scrollVersionRecord>;

export interface AliasBindingRow {
  resource_id: string;
  name: string;
  binding: number;
  scroll_id: string;
  scroll_version: number;
  reason: string;
  author_session_id: string;
  author_assurance: Assurance;
  embodiment_id: string | null;
  proposal_id: string | null;
  event_version: number;
  created_at: Date;
}

export function aliasBindingRecord(b: AliasBindingRow) {
  return {
    name: b.name,
    binding: b.binding,
    target: { scroll_id: b.scroll_id, version: b.scroll_version, ref: refString({ scroll_id: b.scroll_id, version: b.scroll_version }) },
    reason: b.reason,
    set_by: { session_id: b.author_session_id, identity_assurance: b.author_assurance, embodiment_id: b.embodiment_id },
    proposal_id: b.proposal_id,
    event_version: b.event_version,
    created_at: iso(b.created_at),
  };
}

/** Current binding plus full history for one alias; `bindings` must be ordered by binding. */
export function aliasRecord(bindings: AliasBindingRow[]) {
  const current = bindings[bindings.length - 1];
  return {
    name: current.name,
    target: aliasBindingRecord(current).target,
    binding: current.binding,
    history: bindings.map(aliasBindingRecord),
    semantics: 'An alias names an explicit Scroll version. Rebinding adds a new binding; earlier bindings and Scroll versions never change.',
  };
}
export type AliasRecord = ReturnType<typeof aliasRecord>;

export interface ExecutionRow {
  resource_id: string;
  id: string;
  number: number;
  kind: 'scroll' | 'trial';
  scroll_id: string | null;
  scroll_version: number | null;
  scroll_sha256: string | null;
  via_alias: { name: string; binding: number } | null;
  inputs: Record<string, Value>;
  steps: StepRecord[] | { candidate: ScrollContent; steps: StepRecord[] };
  outputs: Record<string, Value> | null;
  status: 'completed' | 'failed';
  error: { code: string; message: string; at: string } | null;
  default_substrate: { substrate_id: string; version: string; manifest_sha256: string } | null;
  session_id: string;
  agent_label: string | null;
  identity_assurance: Assurance;
  embodiment_id: string | null;
  model: ModelRef | null;
  application: { application_id: string } | null;
  proposal_id: string | null;
  on_behalf_of: Participant | null;
  parent_checkpoint: number;
  event_version: number;
  started_at: Date;
  completed_at: Date;
}

export function executionRecord(x: ExecutionRow) {
  const trial = x.kind === 'trial';
  const steps = Array.isArray(x.steps) ? x.steps : x.steps.steps;
  return {
    execution_id: x.id,
    kind: x.kind,
    identity: x.resource_id,
    session: { session_id: x.session_id, agent_label: x.agent_label, identity_assurance: x.identity_assurance },
    embodiment_id: x.embodiment_id,
    model: x.model,
    application: x.application,
    scroll: trial || !x.scroll_id
      ? null
      : { scroll_id: x.scroll_id, version: x.scroll_version, ref: refString({ scroll_id: x.scroll_id, version: x.scroll_version! }), content_sha256: x.scroll_sha256 },
    candidate: trial && !Array.isArray(x.steps) ? { content: x.steps.candidate, content_sha256: x.scroll_sha256 } : null,
    via_alias: x.via_alias,
    default_substrate: x.default_substrate,
    substrates_used: Array.from(new Map(steps.filter((s) => s.substrate).map((s) => [s.substrate!.substrate_id, s.substrate!])).values()),
    inputs: x.inputs,
    operation_sequence: steps,
    outputs: x.outputs,
    status: x.status,
    error: x.error,
    started_at: iso(x.started_at),
    completed_at: iso(x.completed_at),
    parent_checkpoint: x.parent_checkpoint,
    proposal_id: x.proposal_id,
    on_behalf_of: x.on_behalf_of,
    event_version: x.event_version,
    semantics:
      'An execution record: one run of one Scroll version (or candidate) on these inputs. The definition is the Scroll; the result is "outputs". ' +
      'Computed by an ACSP substrate, deterministically; not an observation of any model.',
  };
}
export type ExecutionRecord = ReturnType<typeof executionRecord>;
