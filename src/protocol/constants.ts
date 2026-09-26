import { z } from 'zod';

export const PROTOCOL_NAME = 'ACSP';
export const PROTOCOL_VERSION = 'ACSP/0.1';
export const PROTOCOL_TITLE = 'Agent Continuity & Session Protocol';

export const INVARIANTS = [
  'Continuity does not imply identity.',
  'Reference does not imply ownership.',
  'Awareness does not imply authority.',
  'Handoff does not imply merger.',
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
export const DELEGABLE_SCOPES = [
  'read',
  'append',
  'annotate',
  'checkpoint',
  'supersede',
  'handoff',
  // Program 001 (agent identities only)
  'embody',
  'substrate',
  'scroll',
  'alias',
  'execute',
  'announce',
] as const;
export type DelegableScope = (typeof DELEGABLE_SCOPES)[number];
export type Scope = DelegableScope | 'owner';

export const SCOPE_MEANINGS: Record<Scope, string> = {
  read: 'Read the resource (needed only for restricted resources). Implied by every capability.',
  append: 'Add new TOKs (append).',
  annotate: 'Attach annotations to TOKs (annotate).',
  checkpoint: 'Create checkpoints (checkpoint).',
  supersede: 'Replace a TOK with a newer one while retaining it (supersede).',
  handoff: 'Offer tasks to other sessions (handoff) — only for tasks you are responsible for, or as owner.',
  embody: 'Agent identities: embody the identity as your own session (embody) and release that embodiment (release).',
  substrate: 'Agent identities: select the computational substrate the embodied identity uses (set_substrate).',
  scroll: 'Agent identities: create Scrolls and new Scroll versions (create_scroll, version_scroll).',
  alias: 'Agent identities: bind a reusable name to an explicit Scroll version (set_alias).',
  execute: 'Agent identities: execute Scrolls and test candidate compositions (execute, discover_new_operation).',
  announce: 'Agent identities: publish an announcement that grants and commits nothing (announce).',
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
  // Program 001 (per agent identity)
  scrollVersions: 1_000,
  aliases: 200,
  aliasBindings: 2_000,
  executions: 5_000,
  embodiments: 1_000,
  recentExecutions: 20,
  executionsPageMax: 200,
} as const;

/**
 * Kinds of continuity resource. `agent_identity` is the Program 001
 * extension: a persistent identity that sessions embody, which owns Scrolls,
 * aliases and an execution history.
 */
export const RESOURCE_KINDS = ['continuity_resource', 'agent_identity'] as const;
export type ResourceKind = (typeof RESOURCE_KINDS)[number];

/** Additive extensions to ACSP/0.1 that this server implements. */
export const EXTENSIONS = ['program-001'] as const;

export const VISIBILITIES = ['unlisted', 'restricted'] as const;
export type Visibility = (typeof VISIBILITIES)[number];

export const VISIBILITY_MEANINGS: Record<Visibility, string> = {
  unlisted:
    'Anyone holding this URL can read the resource. The URL grants no authority to change it; every mutation requires a capability.',
  restricted: 'Reading requires a capability for this resource (Authorization: Bearer, or ?cap= on GET).',
};
