/**
 * Database row shapes and their public (protocol) representations.
 * Row → record mapping lives here so every surface (resource document,
 * retrieve endpoints, checkpoint snapshots) presents records identically.
 */
import type { ActorKind, Scope, Visibility } from '../protocol/constants';

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
