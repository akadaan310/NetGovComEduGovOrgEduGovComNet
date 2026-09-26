/**
 * ACSP/0.2 document schemas. Like the payload schemas in operations.ts they
 * are zod types published as JSON Schema (GET /schemas/{name}); the files in
 * schemas/ are generated from them (npm run schemas) and a test keeps them in
 * sync. The harness validates real responses against these schemas.
 */
import { z } from 'zod';
import { ACTOR_KINDS, IdempotencyKeySchema, IdentifierSchema } from './constants';
import { EXTENSION_STATUSES, EFFECT_OPERATIONS, EXTENSION_NAME_RE } from './extensions';
import { CorrelationIdSchema, OperationIdSchema } from './operations';

const Sha = z.string().regex(/^sha256:[0-9a-f]{64}$/);
const ResourceId = z.string().regex(/^[0-9A-HJKMNP-TV-Z]{12}$/);
const Iso = z.string().datetime({ offset: true });
const Participant = z.strictObject({
  session_id: IdentifierSchema,
  agent_id: z.string().nullable(),
  kind: z.enum(ACTOR_KINDS),
  identity_assurance: z.enum(['capability', 'asserted']),
});

/** The request an actor sends: the ACSP/0.2 operation envelope (0.1 envelopes are the same minus the lineage fields). */
export const OperationEnvelopeSchema = z
  .strictObject({
    protocol: z.enum(['ACSP/0.1', 'ACSP/0.2']).describe('actor-supplied, required'),
    operation: z.string().describe('actor-supplied, required: a core name (append or core:append) or a registered extension (ext:ns:name)'),
    operation_version: z.string().max(32).optional().describe('actor-supplied, optional: pin an extension definition version'),
    actor: z
      .strictObject({ session_id: IdentifierSchema.optional(), agent_id: IdentifierSchema.optional(), kind: z.enum(ACTOR_KINDS).optional() })
      .optional()
      .describe('actor-supplied; with a capability session_id must match it (security-sensitive)'),
    expected_version: z.number().int().min(1).optional().describe('actor-supplied; required by update, supersede, resolve_proposal, close'),
    idempotency_key: IdempotencyKeySchema.describe('actor-supplied, required: request identity within the credential scope'),
    causation_id: OperationIdSchema.optional().describe('actor-supplied, optional: the operation this one responds to (validated, same resource)'),
    correlation_id: CorrelationIdSchema.optional().describe('actor-supplied, optional: workflow id (inherited from causation when omitted)'),
    payload: z.unknown().optional().describe('actor-supplied: operation-specific'),
    capability: z.string().max(200).optional().describe('actor-supplied, security-sensitive: alternative to Authorization; never stored'),
    create_key: z.string().max(500).optional(),
  })
  .describe('acsp.operation-envelope/0.2');

/** An executed operation (GET /r/{id}/op/{operation_id}): immutable, server-generated. */
export const OperationRecordSchema = z
  .strictObject({
    schema: z.literal('acsp.operation/0.2'),
    operation_id: OperationIdSchema,
    resource_id: ResourceId,
    sequence: z.number().int().min(1),
    operation_type: z.string(),
    definition_version: z.string(),
    protocol_version: z.string(),
    actor: z.strictObject({ session_id: IdentifierSchema, agent_id: z.string().nullable(), kind: z.enum(ACTOR_KINDS) }),
    identity_assurance: z.enum(['capability', 'asserted']),
    authority: z.strictObject({
      via: z.enum(['capability', 'none']),
      capability_id: z.string().nullable(),
      capability_kind: z.enum(['owner', 'delegation']).nullable(),
      scopes: z.array(z.string()),
    }),
    requested_by: Participant,
    executed_by: Participant,
    on_behalf_of: Participant.nullable(),
    proposal_id: z.string().nullable(),
    payload: z.record(z.string(), z.unknown()),
    expected_version: z.number().int().nullable(),
    idempotency_key: IdempotencyKeySchema,
    request_hash: Sha,
    transition: z.strictObject({
      from_version: z.number().int().min(0),
      to_version: z.number().int().min(1),
      state_before: Sha.nullable(),
      state_after: Sha,
      events: z.array(z.strictObject({ id: z.string(), version: z.number().int(), operation: z.string() })),
    }),
    lineage: z.strictObject({
      parent_operation_id: OperationIdSchema.nullable(),
      causation_id: OperationIdSchema.nullable(),
      causation_source: z.enum(['actor', 'derived']).nullable(),
      correlation_id: z.string(),
    }),
    executed: z.literal(true),
    result: z.record(z.string(), z.unknown()),
    created_at: Iso,
    links: z.record(z.string(), z.string()).optional(),
  })
  .describe('acsp.operation/0.2');

/** A continuation reference: the compact form a session passes on. */
export const ContinuationReferenceSchema = z
  .strictObject({
    schema: z.literal('acsp.continuation-reference/0.2'),
    href: z.string().url(),
    resource_id: ResourceId,
    operation_id: OperationIdSchema.nullable(),
    version: z.number().int().min(1),
    state_sha256: Sha.nullable(),
    correlation_id: z.string().nullable(),
  })
  .describe('acsp.continuation-reference/0.2');

/** The response to a successful mutation (POST). The ACSP/0.1 fields are unchanged. */
export const OperationResultSchema = z
  .object({
    ok: z.literal(true),
    protocol: z.string(),
    operation: z.string(),
    resource_id: ResourceId,
    version: z.number().int(),
    previous_version: z.number().int().min(0),
    events: z.array(z.record(z.string(), z.unknown())).min(1),
    result: z.record(z.string(), z.unknown()),
    replayed: z.boolean(),
    operation_id: OperationIdSchema,
    operation_record: OperationRecordSchema,
    continuation: ContinuationReferenceSchema,
    links: z.record(z.string(), z.string()),
  })
  .describe('acsp.operation-result/0.2');

/** The continuation document (GET /r/{id}/continue/{operation_id}). */
export const ContinuationDocumentSchema = z
  .object({
    type: z.literal('continuation'),
    schema: z.literal('acsp.continuation/0.2'),
    notice: z.string(),
    reference: ContinuationReferenceSchema,
    produced_by: z.record(z.string(), z.unknown()).nullable(),
    resource: z.record(z.string(), z.unknown()),
    current: z.strictObject({
      version: z.number().int(),
      moved_since_reference: z.boolean(),
      operations_since: z.array(z.record(z.string(), z.unknown())),
      operations_since_truncated: z.boolean(),
      diff: z.string(),
      state: z.string(),
    }),
    viewer: z.record(z.string(), z.unknown()),
    how_to_continue: z.record(z.string(), z.unknown()),
    verification: z.record(z.string(), z.unknown()),
    links: z.record(z.string(), z.string()),
  })
  .describe('acsp.continuation/0.2');

const TemplateValue: z.ZodType = z.lazy(() =>
  z.union([
    z.null(),
    z.string(),
    z.number(),
    z.boolean(),
    z.strictObject({ $input: z.string().regex(/^[a-z][a-z0-9_]{0,63}$/) }),
    z.strictObject({ $step: z.number().int().min(0).max(15), path: z.string().regex(/^[a-z_][a-z0-9_]*(\.[a-z_][a-z0-9_]*)*$/) }),
    z.array(TemplateValue),
    z.record(z.string().regex(/^[a-z_][a-z0-9_]*$/), TemplateValue),
  ]),
);

/** An operation definition as published (and as a draft may be submitted for validation). Declarative only. */
export const OperationDefinitionSchema = z
  .strictObject({
    schema: z.literal('acsp.operation-definition/0.2'),
    name: z.string().regex(EXTENSION_NAME_RE),
    namespace: z.string().regex(/^[a-z][a-z0-9]*(\.[a-z][a-z0-9]*)*$/),
    version: z.string().regex(/^[0-9]+(\.[0-9]+)*$/),
    status: z.enum(EXTENSION_STATUSES),
    description: z.string().min(1).max(2_000),
    input_schema: z.record(z.string(), z.unknown()),
    output: z.string().max(2_000),
    effects: z.array(z.strictObject({ operation: z.enum(EFFECT_OPERATIONS), payload: TemplateValue })).min(1).max(8),
    authority: z.array(z.string()).optional(),
    idempotency: z.strictObject({ request: z.literal('replay'), repeat: z.enum(['new_effect', 'refused']), note: z.string() }),
    security: z.array(z.string()).min(1),
  })
  .describe('acsp.operation-definition/0.2');

/** Registration and promotion state of a definition on this service. */
export const ExtensionRegistrationSchema = z
  .strictObject({
    schema: z.literal('acsp.extension-registration/0.2'),
    name: z.string().regex(EXTENSION_NAME_RE),
    version: z.string(),
    status: z.enum(EXTENSION_STATUSES),
    executable: z.boolean(),
    enableable: z.boolean(),
    registered_by: z.literal('service'),
    history: z
      .array(z.strictObject({ status: z.enum(EXTENSION_STATUSES), protocol: z.string(), note: z.string(), evidence: z.array(z.string()).optional() }))
      .min(1),
    next_status_requirements: z.array(z.strictObject({ id: z.string(), requirement: z.string() })),
  })
  .describe('acsp.extension-registration/0.2');

export const PUBLISHED_SCHEMAS = {
  'operation-envelope': OperationEnvelopeSchema,
  operation: OperationRecordSchema,
  'operation-result': OperationResultSchema,
  'continuation-reference': ContinuationReferenceSchema,
  continuation: ContinuationDocumentSchema,
  'operation-definition': OperationDefinitionSchema,
  'extension-registration': ExtensionRegistrationSchema,
} as const;
export type SchemaName = keyof typeof PUBLISHED_SCHEMAS;

export function jsonSchemaOf(name: SchemaName): Record<string, unknown> {
  const s = z.toJSONSchema(PUBLISHED_SCHEMAS[name], { io: 'output', unrepresentable: 'any' }) as Record<string, unknown>;
  return { $id: `urn:acsp:schema:${name}`, title: `ACSP/0.2 ${name}`, ...s };
}
