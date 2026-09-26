/**
 * ACSP/0.2 read representations for operational communication:
 * operation records, the operation feed, continuation references, the
 * operational state, proposal objects and the extension registry.
 *
 * All are plain JSON documents (HTML embeds them verbatim). None of them
 * carries a capability: links built here never include ?cap=, so a reference
 * copied from a page is safe to pass to another session.
 */
import type { Sql } from '../db/types';
import { z } from 'zod';
import { NOTICE } from '../protocol/bootstrap';
import { INVARIANTS_V02 } from '../protocol/constants';
import { AcspError } from '../protocol/errors';
import {
  ENABLEABLE_STATUSES,
  EXECUTABLE_STATUSES,
  EXTENSIONS,
  EXTENSIONS_BY_NAME,
  PROMOTION_REQUIREMENTS,
  type ExtensionDefinition,
} from '../protocol/extensions';
import { OperationDefinitionSchema } from '../protocol/schemas';
import { canonicalHash } from './canonical';
import { extensionAuthority } from './extensions';
import { checkpointRecord, iso, operationRecord, proposalRecord, type OperationRow, type ProposalRow, type ResourceRow } from './records';
import { protocolHeader, type Links, type ResourceDocument } from './representation';
import {
  buildOperationalState,
  findOperation,
  loadCheckpoints,
  loadConsequences,
  loadLatestOperation,
  loadOperation,
  loadOperationEvents,
  loadOperations,
} from './state';

export const OPERATION_NOTICE =
  'This is the record of an operation that was executed on an ACSP resource. It is persisted protocol state, ' +
  'not a message and not a conversation. Reading it grants no authority, and re-submitting it does not re-execute it.';

export const CONTINUATION_NOTICE =
  'This is a continuation reference: it identifies a persisted state of an ACSP resource from which another, ' +
  'independent session may continue. It does not identify you with the session that produced it, it transfers ' +
  'no memory and no identity, and it grants no authority. Your own authority is evaluated in "viewer".';

/** Plain links (never carrying ?cap=) for operation-level references. */
export function opLinks(l: Links, rid: string, opId: string | null) {
  const p = (s: string) => l.plain(`/r/${rid}${s}`);
  return {
    ...(opId ? { self: p(`/op/${opId}`), json: p(`/op/${opId}.json`), continue: p(`/continue/${opId}`) } : {}),
    resource: p(''),
    resource_json: p('.json'),
    operations: p('/op'),
    state: p('/state'),
    events: p('/events'),
    protocol: l.plain('/protocol'),
  };
}

export function compactOperation(o: OperationRow, l: Links) {
  return {
    operation_id: o.id,
    sequence: o.seq,
    operation_type: o.operation,
    actor: { session_id: o.actor.session_id, agent_id: o.actor.agent_id },
    identity_assurance: o.identity_assurance,
    capability_id: o.capability_id,
    on_behalf_of: o.on_behalf_of?.session_id ?? null,
    proposal_id: o.proposal_id,
    from_version: o.from_version,
    to_version: o.to_version,
    state_before: o.state_before,
    state_after: o.state_after,
    parent_operation_id: o.parent_operation_id,
    causation_id: o.causation_id,
    causation_source: o.causation_source,
    correlation_id: o.correlation_id,
    created_at: iso(o.created_at),
    href: l.plain(`/r/${o.resource_id}/op/${o.id}`),
  };
}

export async function operationDocument(sql: Sql, r: ResourceRow, l: Links, opId: string) {
  const o = await loadOperation(sql, r.id, opId);
  const events = await loadOperationEvents(sql, r.id, o.id);
  const ancestors: ReturnType<typeof compactOperation>[] = [];
  for (let c = o.causation_id ? await findOperation(sql, r.id, o.causation_id) : null; c && ancestors.length < 64; ) {
    ancestors.push(compactOperation(c, l));
    c = c.causation_id ? await findOperation(sql, r.id, c.causation_id) : null;
  }
  const parent = o.parent_operation_id ? await findOperation(sql, r.id, o.parent_operation_id) : null;
  const next = (await loadOperations(sql, r.id, { afterSeq: o.seq, limit: 1 }))[0] ?? null;
  const record = { ...operationRecord(o, events), links: opLinks(l, r.id, o.id) };
  return {
    protocol: protocolHeader(l),
    type: 'operation',
    notice: OPERATION_NOTICE,
    operation: record,
    lineage: {
      semantics:
        'causation: the operation this one responds to (why it exists). correlation: the workflow it belongs to. ' +
        'parent: the operation immediately before it on this resource (order). This is protocol provenance, not conversation history.',
      causation_chain: ancestors,
      consequences: (await loadConsequences(sql, r.id, o.id)).map((x) => compactOperation(x, l)),
      parent: parent ? compactOperation(parent, l) : null,
      next: next ? compactOperation(next, l) : null,
      correlation: l.plain(`/r/${r.id}/op?correlation_id=${encodeURIComponent(o.correlation_id)}`),
    },
    event_refs: events.map((e) => ({ version: e.version, operation: e.operation, href: l.plain(`/r/${r.id}/events/${e.version}`) })),
    links: record.links,
  };
}

export async function operationListDocument(sql: Sql, r: ResourceRow, l: Links, q: { after?: number; limit: number; correlationId?: string }) {
  const ops = await loadOperations(sql, r.id, { afterSeq: q.after ?? 0, limit: q.limit, correlationId: q.correlationId });
  const { rows } = await sql.query<{ n: number }>('select count(*)::int as n from events where resource_id = $1 and operation_id is null', [r.id]);
  const last = ops[ops.length - 1];
  const latest = await loadLatestOperation(sql, r.id);
  return {
    protocol: protocolHeader(l),
    type: 'operation_record_list',
    notice: OPERATION_NOTICE,
    resource_id: r.id,
    current_version: r.version,
    semantics:
      'Every accepted mutation request is one operation, in sequence order. Each record carries the operational-state ' +
      'digest before and after it: state_before of each operation equals state_after of the previous one, and the ' +
      'latest state_after equals the SHA-256 of GET /r/{id}/state. Poll with ?after=<sequence> to follow changes.',
    after: q.after ?? 0,
    correlation_id: q.correlationId ?? null,
    operations: ops.map((o) => compactOperation(o, l)),
    next: last && latest && last.seq < latest.seq ? l.plain(`/r/${r.id}/op?after=${last.seq}&limit=${q.limit}`) : null,
    legacy_events_without_operation: rows[0].n,
    links: opLinks(l, r.id, null),
  };
}

export async function stateDocument(sql: Sql, r: ResourceRow, l: Links) {
  const state = await buildOperationalState(sql, r);
  const latest = await loadLatestOperation(sql, r.id);
  return {
    protocol: protocolHeader(l),
    type: 'operational_state',
    notice: NOTICE,
    resource_id: r.id,
    version: r.version,
    sha256: canonicalHash(state),
    latest_operation: latest ? { operation_id: latest.id, state_after: latest.state_after, href: l.plain(`/r/${r.id}/op/${latest.id}`) } : null,
    verification: 'sha256 = "sha256:" + hex(SHA-256(canonical JSON of "state")), canonical JSON = keys sorted, no whitespace. It must equal latest_operation.state_after.',
    state,
    links: opLinks(l, r.id, null),
  };
}

/**
 * The continuation document. `doc` is the full resource document evaluated
 * for the READER (its viewer section and permitted operations are the
 * reader's own, never the producer's).
 */
export async function continuationDocument(sql: Sql, r: ResourceRow, l: Links, opId: string | null, doc: ResourceDocument) {
  const o = opId ? await loadOperation(sql, r.id, opId) : await loadLatestOperation(sql, r.id);
  const refVersion = o ? o.to_version : r.version;
  const since = o ? await loadOperations(sql, r.id, { afterSeq: o.seq, limit: 51 }) : [];
  const checkpoints = await loadCheckpoints(sql, r.id);
  const cpAtRef = [...checkpoints].reverse().find((c) => c.version <= refVersion) ?? null;
  const href = o ? l.plain(`/r/${r.id}/continue/${o.id}`) : l.plain(`/r/${r.id}/continue`);
  const reference = {
    schema: 'acsp.continuation-reference/0.2' as const,
    href,
    resource_id: r.id,
    operation_id: o?.id ?? null,
    version: refVersion,
    state_sha256: o?.state_after ?? null,
    correlation_id: o?.correlation_id ?? null,
  };
  const permitted = doc.operations.filter((x) => x.permitted_for_viewer && x.mutation).map((x) => x.name);
  // Links in a continuation never carry a capability; prepare links carry the citation.
  const sanitize = (h: string) => {
    const u = new URL(h);
    u.searchParams.delete('cap');
    if (o && u.searchParams.get('action')?.startsWith('prepare_')) {
      u.searchParams.set('causation_id', o.id);
      u.searchParams.set('correlation_id', o.correlation_id);
    }
    return u.toString();
  };
  return {
    protocol: protocolHeader(l),
    type: 'continuation' as const,
    schema: 'acsp.continuation/0.2' as const,
    notice: CONTINUATION_NOTICE,
    invariants: [...INVARIANTS_V02],
    reference,
    produced_by: o ? { ...compactOperation(o, l), executed_by: o.actor, authority: o.authority } : null,
    resource: {
      id: r.id,
      url: l.plain(`/r/${r.id}`),
      json: l.plain(`/r/${r.id}.json`),
      title: r.title,
      owner: { session_id: r.owner_session_id, agent_id: r.owner_agent_id },
      lifecycle: r.lifecycle,
      visibility: r.visibility,
      accepts_proposals: r.accepts_proposals,
      checkpoint_at_reference: cpAtRef ? { ...checkpointRecord(cpAtRef), href: l.plain(`/r/${r.id}/checkpoints/${cpAtRef.number}`) } : null,
    },
    current: {
      version: r.version,
      moved_since_reference: r.version !== refVersion,
      operations_since: since.slice(0, 50).map((x) => compactOperation(x, l)),
      operations_since_truncated: since.length > 50,
      diff: l.plain(`/r/${r.id}/diff?from=${refVersion}`),
      state: l.plain(`/r/${r.id}/state`),
    },
    viewer: doc.viewer,
    how_to_continue: {
      principle: 'Decide from "viewer" what YOU may do. Act under your own session_id. Cite this reference; do not claim to be its producer.',
      cite: o ? { causation_id: o.id, correlation_id: o.correlation_id } : null,
      expected_version: r.version,
      permitted_operations: permitted,
      next_valid_actions: doc.next_valid_actions.map((a) => ({ ...a, href: sanitize(a.href) })),
      envelope_template: {
        protocol: 'ACSP/0.2',
        operation: '<one of permitted_operations>',
        actor: { session_id: '<your own session id>', agent_id: '<optional>', kind: 'agent' },
        expected_version: r.version,
        idempotency_key: '<unique, 8-128 chars>',
        ...(o ? { causation_id: o.id, correlation_id: o.correlation_id } : {}),
        payload: {},
      },
      execute: { method: 'POST', href: l.plain(`/r/${r.id}/operations`), authorization: 'Authorization: Bearer <YOUR capability>, only if you were given one' },
    },
    verification: {
      steps: [
        `GET ${l.plain(`/r/${r.id}/op`)} and check, for each operation in sequence, that state_before equals the previous state_after and from_version equals the previous to_version.`,
        o ? `Check that the operation ${o.id} has to_version ${o.to_version} and state_after ${o.state_after}.` : 'This resource has no operation records (created before ACSP/0.2); use events and checkpoints.',
        `GET ${l.plain(`/r/${r.id}/state`)} and recompute sha256 of its "state"; it must equal the latest operation's state_after.`,
        'Checkpoints: recompute each checkpoint\'s sha256 from its snapshot (GET /r/{id}/checkpoints/{n}).',
      ],
      trust: 'These digests are computed and served by this ACSP service. They show internal consistency of the history it serves; they are not signatures and do not prove the service is honest.',
    },
    links: opLinks(l, r.id, o?.id ?? null),
  };
}
export type ContinuationDocument = Awaited<ReturnType<typeof continuationDocument>>;

export async function proposalDocument(sql: Sql, r: ResourceRow, l: Links, proposalId: string) {
  const { rows } = await sql.query<ProposalRow>('select * from proposals where resource_id = $1 and id = $2', [r.id, proposalId]);
  const p = rows[0];
  if (!p) throw new AcspError('not_found', `Resource ${r.id} has no proposal ${proposalId}.`);
  let resolution: ReturnType<typeof compactOperation> | null = null;
  if (p.resolved_version) {
    const { rows: ev } = await sql.query<{ operation_id: string | null }>('select operation_id from events where resource_id = $1 and version = $2', [r.id, p.resolved_version]);
    const op = ev[0]?.operation_id ? await findOperation(sql, r.id, ev[0].operation_id) : null;
    if (op) resolution = compactOperation(op, l);
  }
  const record = proposalRecord(p);
  return {
    protocol: protocolHeader(l),
    type: 'proposal',
    notice: 'A proposal is an operation someone asked to have performed. It is stored, not executed. Only the owner can accept (execute) or reject it.',
    proposal: record,
    proposed_operation: {
      schema: 'acsp.proposed-operation/0.2',
      operation: p.operation,
      payload: p.payload,
      payload_sha256: p.payload_sha256 ?? canonicalHash(p.payload),
      binding: 'On acceptance exactly this payload is executed; its hash is recorded at proposal time and checked before execution.',
      requested_by: record.requested_by,
      base_version: p.base_version ?? null,
      proposed_in_operation: p.operation_id ?? null,
    },
    resolution,
    how_to_resolve:
      p.status === 'pending'
        ? {
            who: 'the owner capability only',
            accept: l.plain(`/r/${r.id}?action=prepare_resolve_proposal&proposal_id=${p.id}&decision=accept${p.operation_id ? `&causation_id=${p.operation_id}` : ''}`),
            reject: l.plain(`/r/${r.id}?action=prepare_resolve_proposal&proposal_id=${p.id}&decision=reject${p.operation_id ? `&causation_id=${p.operation_id}` : ''}`),
          }
        : null,
    links: { ...opLinks(l, r.id, null), ...(p.operation_id ? { proposed_in: l.plain(`/r/${r.id}/op/${p.operation_id}`) } : {}) },
  };
}

// ── extension registry ─────────────────────────────────────────────────────

export function definitionOf(ext: ExtensionDefinition) {
  return {
    schema: 'acsp.operation-definition/0.2' as const,
    name: ext.name,
    namespace: ext.namespace,
    version: ext.version,
    status: ext.status,
    description: ext.description,
    input_schema: z.toJSONSchema(ext.input, { io: 'input', unrepresentable: 'any' }) as Record<string, unknown>,
    output: ext.output,
    effects: ext.effects,
    authority: extensionAuthority(ext),
    idempotency: ext.idempotency,
    security: ext.security,
  };
}

export function registrationOf(ext: ExtensionDefinition) {
  const next = { draft: 'experimental', experimental: 'validated', validated: 'promoted' } as const;
  const target = next[ext.status as keyof typeof next];
  return {
    schema: 'acsp.extension-registration/0.2' as const,
    name: ext.name,
    version: ext.version,
    status: ext.status,
    executable: EXECUTABLE_STATUSES.includes(ext.status),
    enableable: ENABLEABLE_STATUSES.includes(ext.status),
    registered_by: 'service' as const,
    history: ext.history,
    next_status_requirements: target ? PROMOTION_REQUIREMENTS[target] : [],
  };
}

export function extensionsDocument(l: Links) {
  return {
    protocol: protocolHeader(l),
    type: 'extension_registry',
    notice:
      'Extension operations are declarative compositions of core operations, registered by this service. A definition ' +
      'is never executed because someone submitted or published it; only definitions registered here run, only in an ' +
      'executable status, only on resources whose owner enabled them, and only with authority covering every effect.',
    namespaces: 'core:<name> for protocol operations; ext:<namespace>:<name> for extensions (namespace: lowercase, dot-separated).',
    statuses: { lifecycle: ['draft', 'experimental', 'validated', 'promoted', 'deprecated', 'retired'], executable: EXECUTABLE_STATUSES, enableable: ENABLEABLE_STATUSES },
    promotion_requirements: PROMOTION_REQUIREMENTS,
    extensions: EXTENSIONS.map((e) => ({ definition: definitionOf(e), registration: registrationOf(e), href: l.plain(`/extensions/${e.name}`) })),
    links: { validate: l.plain('/extensions/validate?definition={json}'), protocol: l.plain('/protocol'), schemas: l.plain('/schemas') },
  };
}

export function extensionDocument(l: Links, name: string) {
  const ext = EXTENSIONS_BY_NAME[name];
  if (!ext) throw new AcspError('not_found', `No extension "${name}" is registered on this service.`);
  return { protocol: protocolHeader(l), type: 'extension', definition: definitionOf(ext), registration: registrationOf(ext), links: { registry: l.plain('/extensions') } };
}

/** Validate a submitted definition (GET, no side effects). It is never registered or executed. */
export function validateDefinitionDocument(l: Links, raw: string | null) {
  let parsed: unknown = null;
  const issues: { path: string; message: string }[] = [];
  try {
    parsed = raw ? JSON.parse(raw) : null;
  } catch {
    issues.push({ path: '', message: 'definition is not JSON' });
  }
  if (parsed !== null) {
    const r = OperationDefinitionSchema.safeParse(parsed);
    if (!r.success) issues.push(...r.error.issues.map((i) => ({ path: i.path.map(String).join('.'), message: i.message })));
  } else if (!issues.length) issues.push({ path: '', message: 'pass the definition as ?definition=<JSON>' });
  const name = (parsed as { name?: string } | null)?.name;
  return {
    protocol: protocolHeader(l),
    type: 'definition_validation',
    status: 'validated only — NOT registered, NOT executable. Opening this changed nothing.',
    valid: issues.length === 0,
    issues,
    registered: typeof name === 'string' && name in EXTENSIONS_BY_NAME,
    how_definitions_become_executable:
      'A definition becomes executable only when the service operator adds it to the reviewed registry (src/protocol/extensions.ts) ' +
      'and it passes the promotion requirements for its status. Submitting, publishing or linking a definition never makes it run.',
    links: { registry: l.plain('/extensions') },
  };
}
