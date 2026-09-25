/**
 * The ACSP/0.1 operation registry — the protocol as code.
 *
 * The engine (authority, validation), the resource document (operation
 * discovery), the HTML surface and GET /protocol all read this registry, so
 * operation semantics are defined exactly once.
 */
import { z } from 'zod';
import { AnnotationInputSchema, TokIdSchema, TokInputSchema } from '../research/tok';
import {
  ACTOR_KINDS,
  DELEGABLE_SCOPES,
  IdempotencyKeySchema,
  IdentifierSchema,
  RESOURCE_LIMITS,
  VISIBILITIES,
  type Scope,
} from './constants';

export type Family = 'read' | 'write' | 'transfer' | 'structural' | 'termination';

export type AuthorityRequirement =
  | { kind: 'none' }
  | { kind: 'read' }
  | { kind: 'scope'; scope: Exclude<Scope, 'owner' | 'read'> }
  | { kind: 'owner' }
  | { kind: 'addressee' };

export interface OperationSpec {
  name: string;
  family: Family;
  mutation: boolean;
  purpose: string;
  authority: AuthorityRequirement;
  authority_text: string;
  /** How the operation is invoked. */
  invocation: { method: 'GET' | 'POST'; path: string };
  requires_expected_version: boolean;
  /** May be requested through `propose` by a session without authority. */
  proposable: boolean;
  /** Permitted when the resource lifecycle is `closed`. */
  allowed_when_closed: boolean;
  payload?: z.ZodType;
  input: string;
  output: string;
  side_effects: string;
  provenance: string;
  failures: string[];
}

const ParticipantSchema = z.strictObject({
  session_id: IdentifierSchema,
  agent_id: IdentifierSchema.optional(),
});

const text = (max: number) => z.string().trim().max(max);

export const PAYLOADS = {
  create: z.strictObject({
    title: text(200).min(1),
    description: text(5_000).default(''),
    focus: text(2_000).default(''),
    visibility: z.enum(VISIBILITIES).default('unlisted'),
    accepts_proposals: z.boolean().default(true),
    owner_human: text(200).optional(),
    owner_capability_ttl_seconds: z.number().int().min(60).max(365 * 24 * 3600).optional(),
  }),
  append: TokInputSchema,
  annotate: AnnotationInputSchema,
  update: z
    .strictObject({
      title: text(200).min(1).optional(),
      description: text(5_000).optional(),
      focus: text(2_000).optional(),
      accepts_proposals: z.boolean().optional(),
    })
    .refine((p) => Object.keys(p).length > 0, 'at least one field must be supplied'),
  supersede: z
    .strictObject({
      target: TokIdSchema,
      reason: text(2_000).min(1),
      replacement: TokInputSchema.optional(),
      by: TokIdSchema.optional(),
    })
    .refine((p) => (p.replacement === undefined) !== (p.by === undefined), 'supply exactly one of replacement or by'),
  checkpoint: z.strictObject({
    label: text(200).min(1),
    note: text(5_000).default(''),
  }),
  fork: z.strictObject({
    title: text(200).min(1).optional(),
    reason: text(2_000).default(''),
    from_checkpoint: z.number().int().min(0).optional(),
    visibility: z.enum(VISIBILITIES).optional(),
    owner_human: text(200).optional(),
  }),
  delegate: z.strictObject({
    to: ParticipantSchema,
    scopes: z
      .array(z.enum(DELEGABLE_SCOPES))
      .min(1)
      .max(DELEGABLE_SCOPES.length)
      .refine((s) => new Set(s).size === s.length, 'scopes must be unique'),
    expires_in_seconds: z
      .number()
      .int()
      .min(60)
      .max(RESOURCE_LIMITS.delegationMaxTtlSeconds)
      .default(RESOURCE_LIMITS.delegationDefaultTtlSeconds),
    label: text(200).default(''),
  }),
  revoke: z.strictObject({
    capability_id: z.string().regex(/^cap_[0-9A-Z]{10}$/, 'must look like cap_XXXXXXXXXX'),
    reason: text(2_000).default(''),
  }),
  handoff: z.strictObject({
    tok_id: TokIdSchema,
    to: ParticipantSchema,
    note: text(5_000).default(''),
  }),
  acknowledge: z.strictObject({
    handoff_id: z.string().regex(/^HO-\d{3,}$/, 'must look like HO-001'),
    decision: z.enum(['accept', 'decline']),
    note: text(5_000).default(''),
  }),
  propose: z.strictObject({
    operation: z.enum(['append', 'annotate', 'supersede', 'checkpoint']),
    payload: z.record(z.string(), z.unknown()),
    rationale: text(5_000).default(''),
  }),
  resolve_proposal: z.strictObject({
    proposal_id: z.string().regex(/^P-\d{3,}$/, 'must look like P-001'),
    decision: z.enum(['accept', 'reject']),
    note: text(5_000).default(''),
  }),
  close: z.strictObject({
    reason: text(2_000).min(1),
    final_note: text(5_000).default(''),
  }),
} as const;

export type OperationName = keyof typeof PAYLOADS;
export type PayloadOf<N extends OperationName> = z.output<(typeof PAYLOADS)[N]>;

/** The envelope every mutating request uses. */
export const EnvelopeSchema = z.strictObject({
  protocol: z.string(),
  operation: z.string(),
  actor: z
    .strictObject({
      session_id: IdentifierSchema.optional(),
      agent_id: IdentifierSchema.optional(),
      kind: z.enum(ACTOR_KINDS).default('agent'),
    })
    .optional(),
  expected_version: z.number().int().min(1).optional(),
  idempotency_key: IdempotencyKeySchema,
  payload: z.unknown().optional(),
  capability: z.string().max(200).optional(),
  create_key: z.string().max(500).optional(),
});
export type Envelope = z.output<typeof EnvelopeSchema>;

const POST_OPS = { method: 'POST', path: '/r/{id}/operations' } as const;
const COMMON_WRITE_FAILURES = [
  '401 authentication_required — no capability presented',
  '401 invalid_capability | capability_expired | capability_revoked',
  '403 capability_resource_mismatch | session_mismatch | insufficient_authority',
  '409 resource_closed',
  '409 stale_version — expected_version given and not current',
  '422 invalid_payload | idempotency_key_reuse',
];

export const OPERATIONS: OperationSpec[] = [
  // ── READ ────────────────────────────────────────────────────────────────
  {
    name: 'inspect',
    family: 'read',
    mutation: false,
    purpose: 'Read the full current resource document: protocol, state, ownership, access, authority, knowledge, operations, provenance.',
    authority: { kind: 'read' },
    authority_text: 'Read access (anyone with the URL for unlisted resources; a capability for restricted ones).',
    invocation: { method: 'GET', path: '/r/{id}' },
    requires_expected_version: false,
    proposable: false,
    allowed_when_closed: true,
    input: 'None. Optionally present a capability (?cap= or Authorization: Bearer) to see your own authority.',
    output: 'The canonical resource document (HTML by default; JSON via .json, ?format=json or Accept: application/json).',
    side_effects: 'None. GET never changes state.',
    provenance: 'None — reads are not recorded.',
    failures: ['404 not_found', '401/403 for restricted resources without a valid capability'],
  },
  {
    name: 'status',
    family: 'read',
    mutation: false,
    purpose: 'Compact state check: lifecycle, version, latest checkpoint, counts.',
    authority: { kind: 'read' },
    authority_text: 'Read access.',
    invocation: { method: 'GET', path: '/r/{id}?action=status' },
    requires_expected_version: false,
    proposable: false,
    allowed_when_closed: true,
    input: 'None.',
    output: '{ resource_id, lifecycle, version, checkpoint, counts, updated_at }',
    side_effects: 'None.',
    provenance: 'None.',
    failures: ['404 not_found'],
  },
  {
    name: 'retrieve',
    family: 'read',
    mutation: false,
    purpose: 'Read one record: a TOK (with annotations), an event, or a checkpoint (with its full snapshot).',
    authority: { kind: 'read' },
    authority_text: 'Read access.',
    invocation: { method: 'GET', path: '/r/{id}/knowledge/{tokId} | /r/{id}/events/{version} | /r/{id}/checkpoints/{n}' },
    requires_expected_version: false,
    proposable: false,
    allowed_when_closed: true,
    input: 'The record identifier in the path.',
    output: 'The record.',
    side_effects: 'None.',
    provenance: 'None.',
    failures: ['404 not_found'],
  },
  {
    name: 'diff',
    family: 'read',
    mutation: false,
    purpose: 'What changed between two versions, or since a checkpoint. Use it to resume from a checkpoint.',
    authority: { kind: 'read' },
    authority_text: 'Read access.',
    invocation: { method: 'GET', path: '/r/{id}/diff?from={version}&to={version} | ?since_checkpoint={n}' },
    requires_expected_version: false,
    proposable: false,
    allowed_when_closed: true,
    input: 'from (version) or since_checkpoint (number); optional to (default: current version).',
    output: '{ from, to, events, knowledge_added, knowledge_superseded }',
    side_effects: 'None.',
    provenance: 'None.',
    failures: ['400 malformed_request — bad bounds', '404 not_found — unknown checkpoint'],
  },
  // ── WRITE ───────────────────────────────────────────────────────────────
  {
    name: 'create',
    family: 'write',
    mutation: true,
    purpose: 'Create a new continuity resource. The acting session becomes its owner and receives the owner capability.',
    authority: { kind: 'none' },
    authority_text: 'None (rate-limited). If the operator set ACSP_CREATE_KEY, the request must carry create_key.',
    invocation: { method: 'POST', path: '/r' },
    requires_expected_version: false,
    proposable: false,
    allowed_when_closed: true,
    payload: PAYLOADS.create,
    input: '{ title, description?, focus?, visibility?: unlisted|restricted, accepts_proposals?, owner_human?, owner_capability_ttl_seconds? }',
    output: '{ resource, owner_capability: { id, token, session_id, scopes: ["owner"], expires_at }, capability_url } — the token is shown ONCE.',
    side_effects: 'New resource at version 1 with genesis checkpoint 0 and an owner capability bound to the acting session.',
    provenance: 'Event 1 "create" (identity_assurance: asserted — the session binds itself to the capability it receives).',
    failures: ['403 invalid_create_key', '422 invalid_payload', '429 rate_limited'],
  },
  {
    name: 'append',
    family: 'write',
    mutation: true,
    purpose: 'Add a new knowledge-transfer record (TOK).',
    authority: { kind: 'scope', scope: 'append' },
    authority_text: 'Capability with scope "append" (or the owner capability).',
    invocation: POST_OPS,
    requires_expected_version: false,
    proposable: true,
    allowed_when_closed: false,
    payload: PAYLOADS.append,
    input: '{ type, title, summary?, content?, stated_confidence?, refs? }',
    output: '{ tok }',
    side_effects: 'New immutable TOK with the next id (TOK-001, …). Task TOKs start with the author as responsible session.',
    provenance: 'Event "append" { tok_id, type, title }. The TOK records its source session and identity_assurance.',
    failures: [...COMMON_WRITE_FAILURES, '422 limit_exceeded — 1000 TOKs'],
  },
  {
    name: 'annotate',
    family: 'write',
    mutation: true,
    purpose: 'Attach a comment, endorsement, dispute, correction or validation record to a TOK without changing it.',
    authority: { kind: 'scope', scope: 'annotate' },
    authority_text: 'Capability with scope "annotate" (or the owner capability).',
    invocation: POST_OPS,
    requires_expected_version: false,
    proposable: true,
    allowed_when_closed: false,
    payload: PAYLOADS.annotate,
    input: '{ tok_id, kind: comment|endorsement|dispute|correction|validation, content, evidence? } — evidence { method, reference?, result } required for validation.',
    output: '{ annotation }',
    side_effects: 'New annotation (ANN-001, …). The TOK itself is unchanged.',
    provenance: 'Event "annotate". A validation annotation is the annotator\'s claim, not a verdict by ACSP.',
    failures: [...COMMON_WRITE_FAILURES, '404 not_found — TOK'],
  },
  {
    name: 'update',
    family: 'write',
    mutation: true,
    purpose: 'Change resource metadata (title, description, focus, accepts_proposals). TOKs are never updated in place — supersede them.',
    authority: { kind: 'owner' },
    authority_text: 'Owner capability.',
    invocation: POST_OPS,
    requires_expected_version: true,
    proposable: false,
    allowed_when_closed: false,
    payload: PAYLOADS.update,
    input: 'At least one of { title, description, focus, accepts_proposals }. expected_version REQUIRED.',
    output: '{ changes: { field: { from, to } } }',
    side_effects: 'Resource metadata changed.',
    provenance: 'Event "update" storing every before/after value, so nothing is silently overwritten.',
    failures: [...COMMON_WRITE_FAILURES, '400 missing_expected_version'],
  },
  // ── STRUCTURAL ──────────────────────────────────────────────────────────
  {
    name: 'supersede',
    family: 'structural',
    mutation: true,
    purpose: 'Replace a TOK with a newer one while retaining it: the old TOK becomes status "superseded" with superseded_by.',
    authority: { kind: 'scope', scope: 'supersede' },
    authority_text: 'Capability with scope "supersede" (or the owner capability).',
    invocation: POST_OPS,
    requires_expected_version: true,
    proposable: true,
    allowed_when_closed: false,
    payload: PAYLOADS.supersede,
    input: '{ target, reason, replacement: {TOK fields} } or { target, reason, by: "TOK-xxx" }. expected_version REQUIRED.',
    output: '{ superseded, replacement }',
    side_effects: 'Target marked superseded (retained). Replacement created (or existing one linked) with supersedes = target.',
    provenance: 'Event "supersede" { target, replacement, reason } (plus the replacement\'s own authorship).',
    failures: [...COMMON_WRITE_FAILURES, '400 missing_expected_version', '404 not_found', '409 invalid_state — already superseded'],
  },
  {
    name: 'checkpoint',
    family: 'structural',
    mutation: true,
    purpose: 'Create a coherent, hashed state boundary that other sessions can resume from.',
    authority: { kind: 'scope', scope: 'checkpoint' },
    authority_text: 'Capability with scope "checkpoint" (or the owner capability).',
    invocation: POST_OPS,
    requires_expected_version: false,
    proposable: true,
    allowed_when_closed: false,
    payload: PAYLOADS.checkpoint,
    input: '{ label, note? }',
    output: '{ checkpoint: { number, version, label, sha256 } }',
    side_effects: 'Snapshot of metadata, TOKs (with annotations) and handoffs as of the checkpoint\'s version, with SHA-256 of its canonical JSON.',
    provenance: 'Event "checkpoint" { number, label, sha256 }.',
    failures: COMMON_WRITE_FAILURES,
  },
  {
    name: 'fork',
    family: 'structural',
    mutation: true,
    purpose: 'Create an independent branch: a new resource owned by the forking session, linked to its parent. Branches never merge.',
    authority: { kind: 'read' },
    authority_text: 'Read access on the parent (knowing is enough to branch; it grants nothing on the parent).',
    invocation: POST_OPS,
    requires_expected_version: false,
    proposable: false,
    allowed_when_closed: true,
    payload: PAYLOADS.fork,
    input: '{ title?, reason?, from_checkpoint?, visibility?, owner_human? }',
    output: 'As create, plus { lineage: { parent, parent_version, parent_checkpoint } }.',
    side_effects: 'New child resource with copies of the parent\'s TOKs (each with origin). The PARENT IS NOT MODIFIED.',
    provenance: 'Child event 1 "fork" recording the parent reference. Copied TOKs keep their original source.',
    failures: ['404 not_found — checkpoint', '422 invalid_payload', '429 rate_limited'],
  },
  // ── TRANSFER ────────────────────────────────────────────────────────────
  {
    name: 'delegate',
    family: 'transfer',
    mutation: true,
    purpose: 'Grant a named session scoped, expiring authority on this resource.',
    authority: { kind: 'owner' },
    authority_text: 'Owner capability. Delegated capabilities cannot re-delegate.',
    invocation: POST_OPS,
    requires_expected_version: false,
    proposable: false,
    allowed_when_closed: false,
    payload: PAYLOADS.delegate,
    input: `{ to: { session_id, agent_id? }, scopes: subset of [${DELEGABLE_SCOPES.join(', ')}], expires_in_seconds? (default 86400), label? }`,
    output: '{ capability: { id, token, session_id, scopes, expires_at }, capability_url } — the token is shown ONCE.',
    side_effects: 'New capability bound to the grantee session. ["read"] alone grants access without authority.',
    provenance: 'Event "delegate" { capability_id, to, scopes, expires_at } — the secret is never stored.',
    failures: [...COMMON_WRITE_FAILURES, '422 limit_exceeded — 100 active delegations'],
  },
  {
    name: 'revoke',
    family: 'transfer',
    mutation: true,
    purpose: 'Revoke a delegated capability.',
    authority: { kind: 'owner' },
    authority_text: 'Owner capability.',
    invocation: POST_OPS,
    requires_expected_version: false,
    proposable: false,
    allowed_when_closed: false,
    payload: PAYLOADS.revoke,
    input: '{ capability_id, reason? }',
    output: '{ capability_id, revoked_at }',
    side_effects: 'The capability stops working immediately.',
    provenance: 'Event "revoke".',
    failures: [...COMMON_WRITE_FAILURES, '404 not_found', '409 invalid_state — already revoked or owner capability'],
  },
  {
    name: 'handoff',
    family: 'transfer',
    mutation: true,
    purpose: 'Offer responsibility for one task TOK to another session. Takes effect only when that session acknowledges.',
    authority: { kind: 'scope', scope: 'handoff' },
    authority_text: 'Scope "handoff" AND being the owner or the task\'s current responsible session.',
    invocation: POST_OPS,
    requires_expected_version: false,
    proposable: false,
    allowed_when_closed: false,
    payload: PAYLOADS.handoff,
    input: '{ tok_id, to: { session_id, agent_id? }, note? }',
    output: '{ handoff: { id, status: "pending", … } }',
    side_effects: 'Pending handoff (HO-001, …). Responsibility does NOT move yet, and no authority is granted — delegate separately.',
    provenance: 'Event "handoff".',
    failures: [...COMMON_WRITE_FAILURES, '404 not_found', '409 invalid_state — not a task / superseded / already pending / same session'],
  },
  {
    name: 'acknowledge',
    family: 'transfer',
    mutation: true,
    purpose: 'The addressed session accepts or declines a pending handoff.',
    authority: { kind: 'addressee' },
    authority_text: 'A capability bound to the handoff\'s recipient session. Nobody else — not even the owner — can acknowledge.',
    invocation: POST_OPS,
    requires_expected_version: false,
    proposable: false,
    allowed_when_closed: false,
    payload: PAYLOADS.acknowledge,
    input: '{ handoff_id, decision: accept|decline, note? }',
    output: '{ handoff }',
    side_effects: 'On accept, the task\'s responsible session becomes the recipient. Ownership of the resource never changes.',
    provenance: 'Event "acknowledge".',
    failures: [...COMMON_WRITE_FAILURES, '404 not_found', '409 invalid_state — not pending'],
  },
  {
    name: 'propose',
    family: 'transfer',
    mutation: true,
    purpose: 'Record an operation intent: ask whoever holds authority to perform an operation. Propose without authority to execute.',
    authority: { kind: 'read' },
    authority_text: 'Read access, and the resource must accept proposals. No capability needed (identity is then asserted).',
    invocation: POST_OPS,
    requires_expected_version: false,
    proposable: false,
    allowed_when_closed: false,
    payload: PAYLOADS.propose,
    input: '{ operation: append|annotate|supersede|checkpoint, payload: {…}, rationale? } — the inner payload is validated now.',
    output: '{ proposal: { id, status: "pending" } }',
    side_effects: 'Pending proposal (P-001, …); nothing else changes until the owner resolves it.',
    provenance: 'Event "propose", usually with identity_assurance "asserted".',
    failures: ['403 proposals_closed', '409 resource_closed', '422 invalid_payload | limit_exceeded', '429 rate_limited'],
  },
  {
    name: 'resolve_proposal',
    family: 'transfer',
    mutation: true,
    purpose: 'The owner accepts (executes) or rejects a pending proposal.',
    authority: { kind: 'owner' },
    authority_text: 'Owner capability.',
    invocation: POST_OPS,
    requires_expected_version: true,
    proposable: false,
    allowed_when_closed: false,
    payload: PAYLOADS.resolve_proposal,
    input: '{ proposal_id, decision: accept|reject, note? }. expected_version REQUIRED.',
    output: '{ proposal, executed? }',
    side_effects: 'On accept the proposed operation runs with the owner\'s authority; created records keep the PROPOSER as source and the owner as recorded_by.',
    provenance: 'Event "resolve_proposal", then (on accept) the executed operation\'s event with on_behalf_of and proposal_id.',
    failures: [...COMMON_WRITE_FAILURES, '400 missing_expected_version', '404 not_found', '409 invalid_state — not pending'],
  },
  // ── TERMINATION ─────────────────────────────────────────────────────────
  {
    name: 'close',
    family: 'termination',
    mutation: true,
    purpose: 'End the resource lifecycle. It stays readable and forkable forever; no further mutation is possible.',
    authority: { kind: 'owner' },
    authority_text: 'Owner capability.',
    invocation: POST_OPS,
    requires_expected_version: true,
    proposable: false,
    allowed_when_closed: false,
    payload: PAYLOADS.close,
    input: '{ reason, final_note? }. expected_version REQUIRED.',
    output: '{ lifecycle: "closed", closed_at }',
    side_effects: 'lifecycle → closed; pending handoffs and proposals → cancelled.',
    provenance: 'Event "close".',
    failures: [...COMMON_WRITE_FAILURES, '400 missing_expected_version'],
  },
];

export const OPERATIONS_BY_NAME: Record<string, OperationSpec> = Object.fromEntries(OPERATIONS.map((o) => [o.name, o]));

export const MUTATING_OPERATIONS = OPERATIONS.filter((o) => o.mutation).map((o) => o.name) as OperationName[];

export function payloadJsonSchema(spec: OperationSpec): unknown {
  if (!spec.payload) return null;
  try {
    return z.toJSONSchema(spec.payload, { io: 'input', unrepresentable: 'any' });
  } catch {
    return null;
  }
}
