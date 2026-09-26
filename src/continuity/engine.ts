/**
 * CONTINUITY LAYER — the operation engine.
 *
 * Every mutation follows the same path inside ONE transaction:
 *   parse envelope → registry lookup → payload schema → verify capability →
 *   resolve actor → lock resource → idempotency → authorize → lifecycle →
 *   expected_version → handler (emits events + updates projections) →
 *   store idempotency record → commit.
 * Nothing here knows about HTTP.
 */
import type { Sql } from '../db/types';
import { isUniqueViolation } from '../db/types';
import { PROTOCOL_VERSION, SUPPORTED_PROTOCOLS, type ActorKind } from '../protocol/constants';
import { EnvelopeSchema, OPERATIONS_BY_NAME, type OperationSpec } from '../protocol/operations';
import { EXECUTABLE_STATUSES, EXTENSIONS_BY_NAME, isExtensionName, type ExtensionDefinition } from '../protocol/extensions';
import { authorize, effectiveScopes, verifyCapability, type VerifiedCapability } from './authority';
import { canonicalHash } from './canonical';
import { crockford } from './ids';
import { runExtension } from './extensions';
import type { Env } from './env';
import { AcspError, fail } from '../protocol/errors';
import { HANDLERS } from './handlers';
import { eventRecord, operationRecord, type Assurance, type EventRecord, type EventRow, type OperationRecord, type OperationRow, type Participant, type ResourceRow } from './records';
import { buildOperationalState, findOperation, loadLatestOperation, loadResource } from './state';
import { formatIssue, validatePayload } from './validate';

export interface MutationInput {
  /** Target resource; null for `create`. */
  resourceId: string | null;
  body: unknown;
  /** Capability from the Authorization header, if any (a body `capability` field wins). */
  credential?: string | null;
}

export interface MutationResult {
  status: number;
  response: OperationResponse;
}

export interface OperationResponse {
  ok: true;
  protocol: string;
  operation: string;
  resource_id: string;
  version: number;
  events: EventRecord[];
  result: Record<string, unknown>;
  replayed: boolean;
  /** ACSP/0.2: the operation this request became (stable across idempotent replays). */
  operation_id: string;
  previous_version: number;
  operation_record: OperationRecord;
}

export interface Actor {
  session_id: string;
  agent_id: string | null;
  kind: ActorKind;
}

/** Per-request context handed to operation handlers. */
export class OpContext {
  readonly emitted: EventRecord[] = [];
  private dirty = false;
  /** Set while an extension's effects run: recorded on every event they emit. */
  extension: { name: string; version: string } | null = null;
  /** Set by resolve_proposal on accept. */
  proposalExecution: { proposal_id: string; proposer: Participant; operation_id: string | null } | null = null;

  constructor(
    readonly sql: Sql,
    readonly env: Env,
    public resource: ResourceRow,
    readonly actor: Actor,
    readonly assurance: Assurance,
    readonly cap: VerifiedCapability | null,
    readonly now: Date,
    private readonly requestHash: string,
    private readonly idempotencyKey: string,
    /** ACSP/0.2: the operation this request is; every event it emits carries this id. */
    readonly operationId: string,
  ) {}

  /** The actor as a participant record (for authorship). */
  get participant(): Participant {
    return { ...this.actor, identity_assurance: this.assurance };
  }

  /** Latest checkpoint number that exists right now. */
  get latestCheckpoint(): number {
    return this.resource.checkpoint_count - 1;
  }

  /** Allocate the next sequential number for a record family. */
  allocate(counter: 'tok_count' | 'annotation_count' | 'handoff_count' | 'proposal_count' | 'checkpoint_count'): number {
    this.resource[counter] += 1;
    this.dirty = true;
    // checkpoints are numbered from 0; the others from 1
    return counter === 'checkpoint_count' ? this.resource[counter] - 1 : this.resource[counter];
  }

  markDirty(): void {
    this.dirty = true;
  }

  /** Switch the target to a freshly inserted resource (create, fork). Its version starts at 0 in memory. */
  adopt(resource: ResourceRow): void {
    this.resource = resource;
    this.dirty = true;
  }

  /** Append one immutable event; returns its version. */
  async emit(e: {
    operation: string;
    summary: string;
    data: Record<string, unknown>;
    on_behalf_of?: Participant | null;
    proposal_id?: string | null;
  }): Promise<number> {
    const version = this.resource.version + 1;
    const row: EventRow = {
      resource_id: this.resource.id,
      version,
      parent_version: version - 1,
      operation: e.operation,
      actor_session_id: this.actor.session_id,
      actor_agent_id: this.actor.agent_id,
      actor_kind: this.actor.kind,
      identity_assurance: this.assurance,
      capability_id: this.cap?.id ?? null,
      on_behalf_of: e.on_behalf_of ?? null,
      proposal_id: e.proposal_id ?? null,
      occurred_at: this.now,
      summary: e.summary,
      data: this.extension ? { ...e.data, extension: this.extension } : e.data,
      request_hash: this.requestHash,
      idempotency_key: this.idempotencyKey,
      operation_id: this.operationId,
    };
    await this.sql.query(
      `insert into events (resource_id, version, parent_version, operation, actor_session_id, actor_agent_id,
         actor_kind, identity_assurance, capability_id, on_behalf_of, proposal_id, occurred_at, summary, data,
         request_hash, idempotency_key, operation_id)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)`,
      [
        row.resource_id,
        row.version,
        row.parent_version,
        row.operation,
        row.actor_session_id,
        row.actor_agent_id,
        row.actor_kind,
        row.identity_assurance,
        row.capability_id,
        row.on_behalf_of ? JSON.stringify(row.on_behalf_of) : null,
        row.proposal_id,
        row.occurred_at,
        row.summary,
        JSON.stringify(row.data),
        row.request_hash,
        row.idempotency_key,
        row.operation_id,
      ],
    );
    this.resource.version = version;
    this.resource.updated_at = this.now;
    this.dirty = true;
    this.emitted.push(eventRecord(row));
    return version;
  }

  /** Persist the in-memory resource row (version, counters, metadata). */
  async flush(): Promise<void> {
    if (!this.dirty) return;
    const r = this.resource;
    await this.sql.query(
      `update resources set title=$2, description=$3, focus=$4, lifecycle=$5, accepts_proposals=$6, version=$7,
         checkpoint_count=$8, tok_count=$9, annotation_count=$10, handoff_count=$11, proposal_count=$12,
         updated_at=$13, closed_at=$14, enabled_extensions=$15
       where id=$1`,
      [
        r.id,
        r.title,
        r.description,
        r.focus,
        r.lifecycle,
        r.accepts_proposals,
        r.version,
        r.checkpoint_count,
        r.tok_count,
        r.annotation_count,
        r.handoff_count,
        r.proposal_count,
        r.updated_at,
        r.closed_at,
        r.enabled_extensions ?? [],
      ],
    );
  }
}

/** An executable operation: a core registry entry, or an extension definition wrapped as a spec. */
interface Resolved {
  spec: OperationSpec;
  extension: ExtensionDefinition | null;
}

export function extensionSpec(ext: ExtensionDefinition): OperationSpec {
  return {
    name: ext.name,
    family: 'write',
    mutation: true,
    purpose: ext.description,
    // The base check is "can read"; the interpreter then requires a capability that
    // satisfies every effect's core requirement (union of scopes).
    authority: { kind: 'read' },
    authority_text: 'A capability satisfying every effect\'s core authority; the extension must be enabled on the resource.',
    invocation: { method: 'POST', path: '/r/{id}/operations' },
    requires_expected_version: false,
    proposable: false,
    allowed_when_closed: false,
    payload: ext.input,
    input: 'See the extension definition (GET /extensions/{name}).',
    output: ext.output,
    side_effects: `Effects: ${ext.effects.map((e) => e.operation).join(' → ')}`,
    provenance: 'Each effect\'s event records extension { name, version }; one operation record.',
    failures: [],
  };
}

function resolveOperation(name: string, version: string | undefined): Resolved {
  const coreName = name.startsWith('core:') ? name.slice(5) : name;
  const core = OPERATIONS_BY_NAME[coreName];
  if (core) {
    if (!core.mutation) fail('unknown_operation', `"${name}" is a read operation; use GET.`);
    return { spec: core, extension: null };
  }
  if (isExtensionName(name)) {
    const ext = EXTENSIONS_BY_NAME[name];
    if (!ext) fail('unknown_operation', `"${name}" is not registered on this service (GET /extensions).`);
    if (!EXECUTABLE_STATUSES.includes(ext!.status)) {
      fail('operation_not_executable', `${name} is ${ext!.status}; only ${EXECUTABLE_STATUSES.join(', ')} extensions execute.`, { status: ext!.status });
    }
    if (version !== undefined && version !== ext!.version) {
      fail('operation_not_executable', `${name} version ${version} is not registered (current: ${ext!.version}).`, { registered_version: ext!.version });
    }
    return { spec: extensionSpec(ext!), extension: ext! };
  }
  return fail('unknown_operation', `"${name}" is not a mutating ${PROTOCOL_VERSION} operation.`, {
    mutating_operations: Object.values(OPERATIONS_BY_NAME)
      .filter((o) => o.mutation)
      .map((o) => o.name),
    extensions: '/extensions',
  });
}

function parseEnvelope(body: unknown) {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    fail('malformed_request', 'The request body must be a JSON object (the ACSP operation envelope).');
  }
  const parsed = EnvelopeSchema.safeParse(body);
  if (!parsed.success) {
    fail('malformed_request', 'The operation envelope is invalid.', { issues: parsed.error.issues.map(formatIssue) });
  }
  const env = parsed.data!;
  if (!(SUPPORTED_PROTOCOLS as readonly string[]).includes(env.protocol)) {
    fail('unsupported_protocol', `This server speaks ${PROTOCOL_VERSION} and accepts envelopes declaring ${SUPPORTED_PROTOCOLS.join(' or ')}; the request declared "${env.protocol}".`);
  }
  const { spec, extension } = resolveOperation(env.operation, env.operation_version);
  return { env, spec, extension };
}

/** Secrets never enter the idempotency store; replays get the response with tokens redacted. */
function redactSecrets<T>(value: T): T {
  if (Array.isArray(value)) return value.map(redactSecrets) as T;
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      if (k === 'token' && typeof v === 'string') {
        out.token = null;
        out.token_redacted = true;
      } else out[k] = redactSecrets(v);
    }
    return out as T;
  }
  return value;
}

export async function executeMutation(env: Env, input: MutationInput): Promise<MutationResult> {
  const { env: envelope, spec, extension } = parseEnvelope(input.body);

  const isCollectionOp = spec.name === 'create';
  if (isCollectionOp && input.resourceId) {
    fail('malformed_request', '"create" is performed with POST /r, not on an existing resource.');
  }
  if (!isCollectionOp && !input.resourceId) {
    fail('malformed_request', `"${spec.name}" must be POSTed to /r/{id}/operations.`);
  }
  const payload = validatePayload(spec, envelope.payload);
  if (spec.requires_expected_version && envelope.expected_version === undefined) {
    fail('missing_expected_version', `"${spec.name}" requires expected_version (the version you last inspected).`);
  }
  if (isCollectionOp && env.config.createKey && envelope.create_key !== env.config.createKey) {
    fail('invalid_create_key', 'This server requires a valid create_key to create resources.');
  }

  const credential = isCollectionOp ? null : (envelope.capability ?? input.credential ?? null);

  // A concurrent identical request (or an id collision) surfaces as a unique
  // violation; retrying lets the idempotency lookup return the stored result.
  for (let attempt = 0; ; attempt++) {
    try {
      return await env.db.tx((sql) => run(sql, env, spec, extension, envelope, payload, credential, input.resourceId));
    } catch (err) {
      if (attempt < 2 && isUniqueViolation(err)) continue;
      throw err;
    }
  }
}

async function run(
  sql: Sql,
  env: Env,
  spec: OperationSpec,
  extension: ExtensionDefinition | null,
  envelope: ReturnType<typeof parseEnvelope>['env'],
  payload: Record<string, unknown>,
  credential: string | null,
  resourceId: string | null,
): Promise<MutationResult> {
  const now = env.clock.now();

  // 1. Authenticate.
  const cap = credential ? await verifyCapability(sql, credential, now) : null;
  if (cap && resourceId && cap.resource_id !== resourceId) {
    fail('capability_resource_mismatch', `Capability ${cap.id} belongs to resource ${cap.resource_id}, not ${resourceId}.`);
  }

  // 2. Resolve the actor. A capability fixes the session; without one it is asserted.
  let actor: Actor;
  let assurance: Assurance;
  if (cap) {
    const claimed = envelope.actor?.session_id;
    if (claimed && claimed !== cap.session_id) {
      fail('session_mismatch', `Capability ${cap.id} is bound to session "${cap.session_id}", not "${claimed}".`);
    }
    actor = { session_id: cap.session_id, agent_id: envelope.actor?.agent_id ?? cap.agent_id, kind: envelope.actor?.kind ?? 'agent' };
    assurance = 'capability';
  } else {
    if (!envelope.actor?.session_id) {
      fail('malformed_request', 'actor.session_id is required when no capability is presented.');
    }
    actor = { session_id: envelope.actor!.session_id!, agent_id: envelope.actor!.agent_id ?? null, kind: envelope.actor!.kind };
    assurance = 'asserted';
  }

  // 3. Lock the target resource: serialises writers per resource.
  const resource: ResourceRow = resourceId
    ? await loadResource(sql, resourceId, { lock: true })
    : placeholderResource();

  // 4. Idempotency.
  const requestHash = canonicalHash({
    resource_id: resourceId,
    operation: spec.name,
    actor,
    payload: envelope.payload ?? {},
    expected_version: envelope.expected_version ?? null,
    // ACSP/0.2 fields are part of the request identity only when sent, so 0.1 request hashes are unchanged.
    causation_id: envelope.causation_id,
    correlation_id: envelope.correlation_id,
    operation_version: envelope.operation_version,
  });
  const scope = `${resourceId ?? 'new'}|${cap ? cap.id : `asserted:${actor.session_id}`}`;
  const prior = (
    await sql.query<{ request_hash: string; status_code: number; response: OperationResponse }>(
      'select request_hash, status_code, response from idempotency where scope = $1 and key = $2',
      [scope, envelope.idempotency_key],
    )
  ).rows[0];
  if (prior) {
    if (prior.request_hash !== requestHash) {
      fail('idempotency_key_reuse', `idempotency_key "${envelope.idempotency_key}" was already used for a different request.`);
    }
    return { status: prior.status_code, response: { ...prior.response, replayed: true } };
  }

  // 5. Authorize, then check lifecycle and version.
  const decision = authorize(spec, resourceId ? resource : null, cap);
  if (!decision.ok) throw decision.error;
  if (resourceId && resource.lifecycle === 'closed' && !spec.allowed_when_closed) {
    fail('resource_closed', `Resource ${resource.id} is closed; it can be read and forked but not changed.`);
  }
  if (resourceId && envelope.expected_version !== undefined && envelope.expected_version !== resource.version) {
    fail('stale_version', `Resource ${resource.id} is at version ${resource.version}, not ${envelope.expected_version}. Re-inspect and retry.`, {
      expected: envelope.expected_version,
      current: resource.version,
    });
  }

  // 6. Operation identity and lineage (ACSP/0.2).
  const operationId = `op-${crockford(env.random, 16)}`;
  const fromVersion = resourceId ? resource.version : 0;
  const lineageResource = resourceId; // for fork this is the PARENT: a fork's causation cites a parent operation
  let causation: OperationRow | null = null;
  if (envelope.causation_id) {
    causation = lineageResource ? await findOperation(sql, lineageResource, envelope.causation_id) : null;
    if (!causation) {
      fail('invalid_reference', `causation_id ${envelope.causation_id} is not an operation of ${lineageResource ? `resource ${lineageResource}` : 'any resource (create has none)'}.`);
    }
  }
  const previous = resourceId && spec.name !== 'fork' ? await loadLatestOperation(sql, resourceId) : null;
  const stateBefore = resourceId && spec.name !== 'fork' ? canonicalHash(await buildOperationalState(sql, resource)) : null;

  // 7. Execute.
  const ctx = new OpContext(sql, env, resource, actor, assurance, cap, now, requestHash, envelope.idempotency_key, operationId);
  let result: Record<string, unknown>;
  if (extension) result = await runExtension(ctx, extension, payload);
  else {
    const handler = HANDLERS[spec.name as keyof typeof HANDLERS];
    if (!handler) throw new AcspError('internal_error', `No handler registered for "${spec.name}".`);
    result = await handler(ctx, payload as never);
  }
  await ctx.flush();

  // 8. Derived causation when the actor gave none: accepting a proposal responds to the
  // proposal; acknowledging a handoff responds to the handoff.
  let causationId = causation?.id ?? null;
  let causationSource: 'actor' | 'derived' | null = causation ? 'actor' : null;
  if (!causationId) {
    const derived = await derivedCausation(sql, ctx, spec.name, payload);
    if (derived) {
      causationId = derived.id;
      causationSource = 'derived';
      causation = derived;
    }
  }
  const correlationId = envelope.correlation_id ?? causation?.correlation_id ?? operationId;
  const stateAfter = canonicalHash(await buildOperationalState(sql, ctx.resource));
  const redacted = redactSecrets(result);
  const opRow: OperationRow = {
    resource_id: ctx.resource.id,
    id: operationId,
    seq: (previous?.seq ?? 0) + 1,
    operation: spec.name,
    definition_version: extension ? extension.version : 'core@ACSP/0.1',
    protocol: envelope.protocol,
    actor: { session_id: actor.session_id, agent_id: actor.agent_id, kind: actor.kind },
    identity_assurance: assurance,
    capability_id: cap?.id ?? null,
    authority: { via: cap ? 'capability' : 'none', capability_id: cap?.id ?? null, capability_kind: cap?.kind ?? null, scopes: effectiveScopes(cap) },
    requested_by: ctx.participant,
    on_behalf_of: ctx.proposalExecution?.proposer ?? null,
    proposal_id: ctx.proposalExecution?.proposal_id ?? null,
    expected_version: envelope.expected_version ?? null,
    from_version: spec.name === 'fork' ? 0 : fromVersion,
    to_version: ctx.resource.version,
    state_before: stateBefore,
    state_after: stateAfter,
    parent_operation_id: previous?.id ?? null,
    causation_id: causationId,
    causation_source: causationSource,
    correlation_id: correlationId,
    request_hash: requestHash,
    idempotency_key: envelope.idempotency_key,
    payload: (envelope.payload ?? {}) as Record<string, unknown>,
    result: redacted,
    created_at: now,
  };
  await sql.query(
    `insert into operations (resource_id, id, seq, operation, definition_version, protocol, actor, identity_assurance,
       capability_id, authority, requested_by, on_behalf_of, proposal_id, expected_version, from_version, to_version,
       state_before, state_after, parent_operation_id, causation_id, causation_source, correlation_id, request_hash,
       idempotency_key, payload, result, created_at)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27)`,
    [
      opRow.resource_id, opRow.id, opRow.seq, opRow.operation, opRow.definition_version, opRow.protocol,
      JSON.stringify(opRow.actor), opRow.identity_assurance, opRow.capability_id, JSON.stringify(opRow.authority),
      JSON.stringify(opRow.requested_by), opRow.on_behalf_of ? JSON.stringify(opRow.on_behalf_of) : null, opRow.proposal_id,
      opRow.expected_version, opRow.from_version, opRow.to_version, opRow.state_before, opRow.state_after,
      opRow.parent_operation_id, opRow.causation_id, opRow.causation_source, opRow.correlation_id, opRow.request_hash,
      opRow.idempotency_key, JSON.stringify(opRow.payload), JSON.stringify(opRow.result), opRow.created_at,
    ],
  );

  const status = spec.name === 'create' || spec.name === 'fork' ? 201 : 200;
  const response: OperationResponse = {
    ok: true,
    protocol: PROTOCOL_VERSION,
    operation: spec.name,
    resource_id: ctx.resource.id,
    version: ctx.resource.version,
    events: ctx.emitted,
    result,
    replayed: false,
    operation_id: operationId,
    previous_version: opRow.from_version,
    operation_record: operationRecord(opRow, ctx.emitted),
  };

  // 9. Record for idempotent replay — with secrets redacted.
  await sql.query(
    'insert into idempotency (scope, key, request_hash, status_code, response, created_at) values ($1,$2,$3,$4,$5,$6)',
    [scope, envelope.idempotency_key, requestHash, status, JSON.stringify(redactSecrets(response)), now],
  );
  return { status, response };
}

/** Stand-in target for `create`, replaced by the handler via ctx.adopt(). */
function placeholderResource(): ResourceRow {
  return { id: '', version: 0 } as ResourceRow;
}

/** Server-derived causation for operations that respond to an earlier operation by construction. */
async function derivedCausation(sql: Sql, ctx: OpContext, name: string, payload: Record<string, unknown>): Promise<OperationRow | null> {
  const rid = ctx.resource.id;
  if (name === 'resolve_proposal') {
    const { rows } = await sql.query<{ operation_id: string | null }>('select operation_id from proposals where resource_id = $1 and id = $2', [rid, payload.proposal_id]);
    return rows[0]?.operation_id ? findOperation(sql, rid, rows[0].operation_id) : null;
  }
  if (name === 'acknowledge') {
    const { rows } = await sql.query<{ operation_id: string | null }>(
      `select e.operation_id from handoffs h join events e on e.resource_id = h.resource_id and e.version = h.created_version
        where h.resource_id = $1 and h.id = $2`,
      [rid, payload.handoff_id],
    );
    return rows[0]?.operation_id ? findOperation(sql, rid, rows[0].operation_id) : null;
  }
  return null;
}
