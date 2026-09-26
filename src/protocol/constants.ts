import { z } from 'zod';

export const PROTOCOL_NAME = 'ACSP';
export const PROTOCOL_VERSION = 'ACSP/0.2';
/** Envelope protocol strings this server accepts. 0.1 envelopes remain valid unchanged. */
export const SUPPORTED_PROTOCOLS = ['ACSP/0.1', 'ACSP/0.2'] as const;
export const PROTOCOL_TITLE = 'Agent Continuity & Session Protocol';

export const INVARIANTS = [
  'Continuity does not imply identity.',
  'Reference does not imply ownership.',
  'Awareness does not imply authority.',
  'Handoff does not imply merger.',
] as const;

/**
 * The full invariant set of ACSP/0.2. The first four are the ACSP/0.1
 * invariants (INVARIANTS, kept for compatibility). Each has a mechanism;
 * PROTOCOL.md §0 names it and a test exercises it.
 */
export const INVARIANTS_V02 = [
  ...INVARIANTS,
  'Access does not imply control.',
  'Observation does not imply interpretation.',
  'Interpretation does not imply conclusion.',
  'Delegation does not erase provenance.',
  'Forking does not destroy lineage.',
  'Supersession does not require deletion.',
  'Preparation does not imply execution.',
  'Operation reference does not imply operation authority.',
  'Capability is explicit.',
  'Authority is scoped.',
  'State transitions are attributable.',
  'Replay does not imply re-execution.',
  'Definition does not imply execution.',
] as const;

/** Session ids, agent ids and other participant-chosen identifiers. */
export const IdentifierSchema = z
  .string()
  .regex(/^[A-Za-z0-9._:@-]{1,128}$/, 'must be 1-128 characters of [A-Za-z0-9._:@-]');

export const IdempotencyKeySchema = z
  .string()
  .regex(/^[A-Za-z0-9._:-]{8,128}$/, 'must be 8-128 characters of [A-Za-z0-9._:-]');

export const ACTOR_KINDS = ['agent', 'human', 'system'] as const;
export type ActorKind = (typeof ACTOR_KINDS)[number];

export const ResourceIdSchema = z.string().regex(/^[0-9A-HJKMNP-TV-Z]{12}$/, 'must be a 12-character ACSP resource id');

/** Scopes a delegation may carry. `owner` exists only on the owner capability. */
export const DELEGABLE_SCOPES = ['read', 'append', 'annotate', 'checkpoint', 'supersede', 'handoff'] as const;
export type DelegableScope = (typeof DELEGABLE_SCOPES)[number];
export type Scope = DelegableScope | 'owner';

export const SCOPE_MEANINGS: Record<Scope, string> = {
  read: 'Read the resource (needed only for restricted resources). Implied by every capability.',
  append: 'Add new TOKs (append).',
  annotate: 'Attach annotations to TOKs (annotate).',
  checkpoint: 'Create checkpoints (checkpoint).',
  supersede: 'Replace a TOK with a newer one while retaining it (supersede).',
  handoff: 'Offer tasks to other sessions (handoff) — only for tasks you are responsible for, or as owner.',
  owner: 'Held only by the owner capability: every scope above plus update, delegate, revoke, resolve_proposal, close.',
};

export const RESOURCE_LIMITS = {
  toks: 1_000,
  annotations: 2_000,
  pendingProposals: 100,
  activeDelegations: 100,
  bodyBytes: 64 * 1024,
  delegationDefaultTtlSeconds: 24 * 60 * 60,
  delegationMaxTtlSeconds: 30 * 24 * 60 * 60,
  eventsPageMax: 200,
  recentEvents: 20,
} as const;

export const VISIBILITIES = ['unlisted', 'restricted'] as const;
export type Visibility = (typeof VISIBILITIES)[number];

export const VISIBILITY_MEANINGS: Record<Visibility, string> = {
  unlisted:
    'Anyone holding this URL can read the resource. The URL grants no authority to change it; every mutation requires a capability.',
  restricted: 'Reading requires a capability for this resource (Authorization: Bearer, or ?cap= on GET).',
};
