/**
 * Extension (custom) operations — ACSP/0.2.
 *
 * Three things are kept apart:
 *
 *   DEFINITION     what the operation means: name, version, input and output
 *                  schema, the state transition as a fixed list of CORE effects,
 *                  idempotency, security notes, lifecycle status. Declarative data.
 *   IMPLEMENTATION the one interpreter in src/continuity/extensions.ts. It
 *                  substitutes input values into the effect templates, validates
 *                  each effect against the core operation's schema, checks the
 *                  core authority for each effect, and runs the core handler.
 *                  There is no other way for an extension to touch state.
 *   AUTHORITY      the invoking capability must satisfy EVERY effect's core
 *                  requirement (the union of scopes); the resource owner must
 *                  have enabled the extension on the resource.
 *
 * Only definitions compiled into this file (reviewed with the service's code)
 * are ever executable. Nothing supplied at run time — a URL, a payload, TOK
 * content, a definition submitted for validation — is ever executed.
 */
import { z } from 'zod';
import { TokIdSchema } from '../research/tok';

/** Lifecycle of an extension operation (PROTOCOL.md §15). */
export const EXTENSION_STATUSES = ['draft', 'experimental', 'validated', 'promoted', 'deprecated', 'retired'] as const;
export type ExtensionStatus = (typeof EXTENSION_STATUSES)[number];

/** Statuses in which an extension may run (on resources that enabled it). */
export const EXECUTABLE_STATUSES: readonly ExtensionStatus[] = ['experimental', 'validated', 'promoted', 'deprecated'];
/** Statuses an owner may newly enable. Deprecated extensions stay runnable where already enabled. */
export const ENABLEABLE_STATUSES: readonly ExtensionStatus[] = ['experimental', 'validated', 'promoted'];

/** The only core operations an extension effect may use: the non-owner content operations. */
export const EFFECT_OPERATIONS = ['append', 'annotate', 'checkpoint', 'supersede'] as const;
export type EffectOperation = (typeof EFFECT_OPERATIONS)[number];

/** `ext:<namespace>:<name>`; namespace is lowercase dot-separated, name snake_case. */
export const EXTENSION_NAME_RE = /^ext:[a-z][a-z0-9]*(?:\.[a-z][a-z0-9]*)*:[a-z][a-z0-9_]{0,63}$/;

/**
 * A template value: a JSON literal, `{ "$input": "<field>" }` (a top-level
 * input field), or `{ "$step": <i>, "path": "<a.b.c>" }` (a value from the
 * result of an earlier effect). No expressions, conditionals or loops.
 */
export type Template = unknown;

export interface Effect {
  operation: EffectOperation;
  payload: Template;
}

export interface PromotionRequirement {
  id: string;
  requirement: string;
}

/** What must hold before an extension may move to the next status. Checked by tests where mechanical. */
export const PROMOTION_REQUIREMENTS: Record<'experimental' | 'validated' | 'promoted', PromotionRequirement[]> = {
  experimental: [
    { id: 'schema', requirement: 'Input schema defined and published; output described.' },
    { id: 'effects', requirement: 'Every effect is an allowed core operation; authority is the union of the effects\' requirements.' },
    { id: 'idempotency', requirement: 'Request, repeat and event idempotency stated.' },
    { id: 'security', requirement: 'Security notes written (what it can and cannot change).' },
  ],
  validated: [
    { id: 'tests', requirement: 'Harness checks cover success, authorization failure, schema failure, idempotent replay and no-partial-effects on failure; named in evidence.' },
    { id: 'adversarial', requirement: 'Adversarial checks (scope escalation, disabled resource, template injection) pass; named in evidence.' },
    { id: 'determinism', requirement: 'Same input on the same state yields the same state transition (no clock, randomness or external input beyond the core operations).' },
    { id: 'provenance', requirement: 'Every emitted event records the extension name and version; the operation record is complete.' },
  ],
  promoted: [
    { id: 'stability', requirement: 'Schema and effects unchanged for at least one protocol minor version while validated.' },
    { id: 'review', requirement: 'A security review recorded in SECURITY.md.' },
    { id: 'identity', requirement: 'A stable qualified name and version are fixed; a later change requires a new version, never an edit.' },
    { id: 'compatibility', requirement: 'Promotion into the core registry, if ever, keeps the ext: name as an alias and records promoted_from; it is never presented as having been core.' },
  ],
};

export interface ExtensionDefinition {
  name: string;
  namespace: string;
  version: string;
  status: ExtensionStatus;
  description: string;
  input: z.ZodType;
  output: string;
  effects: Effect[];
  idempotency: { request: 'replay'; repeat: 'new_effect' | 'refused'; note: string };
  security: string[];
  /** Status history; the first entry is when the definition entered the registry. */
  history: { status: ExtensionStatus; protocol: string; note: string; evidence?: string[] }[];
}

export const EXTENSIONS: ExtensionDefinition[] = [
  {
    name: 'ext:acsp.review:request_review',
    namespace: 'acsp.review',
    version: '1',
    status: 'experimental',
    description: 'Ask for a review of one TOK: attaches a comment annotation carrying the request.',
    input: z.strictObject({ tok_id: TokIdSchema, request: z.string().trim().min(1).max(2_000) }),
    output: '{ steps: [ { operation: "annotate", result: { annotation } } ] }',
    effects: [{ operation: 'annotate', payload: { tok_id: { $input: 'tok_id' }, kind: 'comment', content: { $input: 'request' } } }],
    idempotency: { request: 'replay', repeat: 'new_effect', note: 'Each execution adds a new annotation.' },
    security: ['Needs scope annotate.', 'Changes nothing but the annotation set of an existing TOK.'],
    history: [{ status: 'experimental', protocol: 'ACSP/0.2', note: 'Introduced as an example of a one-effect extension.' }],
  },
  {
    name: 'ext:acsp.review:record_decision',
    namespace: 'acsp.review',
    version: '1',
    status: 'validated',
    description: 'Record a decision about a TOK and mark the boundary: appends a decision TOK citing it, then checkpoints.',
    input: z.strictObject({
      decides_on: TokIdSchema,
      title: z.string().trim().min(1).max(200),
      rationale: z.string().max(20_000).default(''),
      checkpoint_label: z.string().trim().min(1).max(200),
    }),
    output: '{ steps: [ { operation: "append", result: { tok } }, { operation: "checkpoint", result: { checkpoint } } ] }',
    effects: [
      { operation: 'append', payload: { type: 'decision', title: { $input: 'title' }, content: { $input: 'rationale' }, refs: [{ tok: { $input: 'decides_on' } }] } },
      { operation: 'checkpoint', payload: { label: { $input: 'checkpoint_label' }, note: { $step: 0, path: 'tok.id' } } },
    ],
    idempotency: { request: 'replay', repeat: 'new_effect', note: 'Each execution appends a new decision TOK and a new checkpoint.' },
    security: ['Needs scopes append AND checkpoint (union of its effects).', 'Two events, applied atomically: both or neither.'],
    history: [
      { status: 'experimental', protocol: 'ACSP/0.2', note: 'Introduced.' },
      {
        status: 'validated',
        protocol: 'ACSP/0.2',
        note: 'Promoted to validated after the extension checks below passed.',
        evidence: ['harness: extensions / record_decision success', 'harness: extensions / scope escalation refused', 'harness: extensions / no partial effects', 'harness: extensions / idempotent replay', 'harness: extensions / template injection is data'],
      },
    ],
  },
  {
    name: 'ext:acsp.lab:bulk_note',
    namespace: 'acsp.lab',
    version: '0',
    status: 'draft',
    description: 'Draft: append an observation TOK. Present to show that a draft is published but never executable.',
    input: z.strictObject({ title: z.string().trim().min(1).max(200) }),
    output: '{ steps: [ { operation: "append", result: { tok } } ] }',
    effects: [{ operation: 'append', payload: { type: 'observation', title: { $input: 'title' } } }],
    idempotency: { request: 'replay', repeat: 'new_effect', note: 'Would append a new TOK each time.' },
    security: ['Not executable in status draft.'],
    history: [{ status: 'draft', protocol: 'ACSP/0.2', note: 'Draft.' }],
  },
  {
    name: 'ext:acsp.lab:legacy_flag',
    namespace: 'acsp.lab',
    version: '1',
    status: 'retired',
    description: 'Retired example: flagged a TOK with a comment. Kept in the registry so its history stays readable.',
    input: z.strictObject({ tok_id: TokIdSchema }),
    output: '{ steps: [ { operation: "annotate", result: { annotation } } ] }',
    effects: [{ operation: 'annotate', payload: { tok_id: { $input: 'tok_id' }, kind: 'comment', content: 'flagged' } }],
    idempotency: { request: 'replay', repeat: 'new_effect', note: 'Would add a new annotation each time.' },
    security: ['Not executable in status retired.'],
    history: [
      { status: 'experimental', protocol: 'ACSP/0.2', note: 'Introduced.' },
      { status: 'deprecated', protocol: 'ACSP/0.2', note: 'Superseded by ext:acsp.review:request_review.' },
      { status: 'retired', protocol: 'ACSP/0.2', note: 'Retired.' },
    ],
  },
];

export const EXTENSIONS_BY_NAME: Record<string, ExtensionDefinition> = Object.fromEntries(EXTENSIONS.map((e) => [e.name, e]));

export const isExtensionName = (name: string) => name.startsWith('ext:');
