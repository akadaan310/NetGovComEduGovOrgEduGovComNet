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
import { PROTOCOL_VERSION, type ActorKind } from '../protocol/constants';
import { appliesTo, EnvelopeSchema, OPERATIONS_BY_NAME, type OperationSpec } from '../protocol/operations';
import { authorize, verifyCapability, type VerifiedCapability } from './authority';
import { canonicalHash } from './canonical';
import type { Env } from './env';
import { AcspError, fail } from '../protocol/errors';
import { HANDLERS } from './handlers';
import { eventRecord, type Assurance, type EventRecord, type EventRow, type Participant, type ResourceRow } from './records';
import { loadResource } from './state';
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
  allocate(
    counter:
      | 'tok_count'
      | 'annotation_count'
      | 'handoff_count'
      | 'proposal_count'
      | 'checkpoint_count'
      | 'scroll_count'
      | 'execution_count'
      | 'embodiment_count',
  ): number {
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
      data: e.data,
      request_hash: this.requestHash,
      idempotency_key: this.idempotencyKey,
    };
    await this.sql.query(
      `insert into events (resource_id, version, parent_version, operation, actor_session_id, actor_agent_id,
         actor_kind, identity_assurance, capability_id, on_behalf_of, proposal_id, occurred_at, summary, data,
         request_hash, idempotency_key)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)`,
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
         updated_at=$13, closed_at=$14, also_known_as=$15, current_substrate_id=$16, scroll_count=$17,
         execution_count=$18, embodiment_count=$19
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
        JSON.stringify(r.also_known_as ?? []),
        r.current_substrate_id ?? null,
        r.scroll_count ?? 0,
        r.execution_count ?? 0,
        r.embodiment_count ?? 0,
      ],
    );
  }
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
  if (env.protocol !== PROTOCOL_VERSION) {
    fail('unsupported_protocol', `This server speaks ${PROTOCOL_VERSION}; the request declared "${env.protocol}".`);
  }
  const spec = OPERATIONS_BY_NAME[env.operation];
  if (!spec || !spec.mutation) {
    fail('unknown_operation', `"${env.operation}" is not a mutating ${PROTOCOL_VERSION} operation.`, {
      mutating_operations: Object.values(OPERATIONS_BY_NAME)
        .filter((o) => o.mutation)
        .map((o) => o.name),
    });
  }
  return { env, spec: spec! };
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
  const { env: envelope, spec } = parseEnvelope(input.body);

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
      return await env.db.tx((sql) => run(sql, env, spec, envelope, payload, credential, input.resourceId));
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

  // 5. Authorize, then check resource kind, lifecycle and version.
  const decision = authorize(spec, resourceId ? resource : null, cap);
  if (!decision.ok) throw decision.error;
  if (resourceId && !appliesTo(spec, resource.kind)) {
    fail('invalid_state', `"${spec.name}" does not apply to a resource of kind "${resource.kind}" (applies to: ${(spec.applies_to ?? []).join(', ')}).`);
  }
  if (resourceId && resource.lifecycle === 'closed' && !spec.allowed_when_closed) {
    fail('resource_closed', `Resource ${resource.id} is closed; it can be read and forked but not changed.`);
  }
  if (resourceId && envelope.expected_version !== undefined && envelope.expected_version !== resource.version) {
    fail('stale_version', `Resource ${resource.id} is at version ${resource.version}, not ${envelope.expected_version}. Re-inspect and retry.`, {
      expected: envelope.expected_version,
      current: resource.version,
    });
  }

  // 6. Execute.
  const ctx = new OpContext(sql, env, resource, actor, assurance, cap, now, requestHash, envelope.idempotency_key);
  const handler = HANDLERS[spec.name as keyof typeof HANDLERS];
  if (!handler) throw new AcspError('internal_error', `No handler registered for "${spec.name}".`);
  const result = await handler(ctx, payload as never);
  await ctx.flush();

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
  };

  // 7. Record for idempotent replay — with secrets redacted.
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
