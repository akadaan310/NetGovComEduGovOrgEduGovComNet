/** Loading persisted continuity state. Used by handlers, snapshots and representations. */
import type { Sql } from '../db/types';
import { PROTOCOL_VERSION } from '../protocol/constants';
import { AcspError } from '../protocol/errors';
import {
  handoffRecord,
  iso,
  proposalRecord,
  tokRecord,
  type AnnotationRow,
  type CapabilityRow,
  type CheckpointRow,
  type EventRow,
  type HandoffRow,
  type OperationRow,
  type ProposalRow,
  type ResourceRow,
  type TokRow,
} from './records';

export async function loadResource(sql: Sql, id: string, opts: { lock?: boolean } = {}): Promise<ResourceRow> {
  const { rows } = await sql.query<ResourceRow>(
    `select * from resources where id = $1${opts.lock ? ' for update' : ''}`,
    [id],
  );
  if (!rows[0]) throw new AcspError('not_found', `No continuity resource with id "${id}".`);
  return rows[0];
}

export const loadToks = async (sql: Sql, rid: string) =>
  (await sql.query<TokRow>('select * from toks where resource_id = $1 order by version, id', [rid])).rows;

export const loadAnnotations = async (sql: Sql, rid: string) =>
  (await sql.query<AnnotationRow>('select * from annotations where resource_id = $1 order by version, id', [rid])).rows;

export const loadHandoffs = async (sql: Sql, rid: string) =>
  (await sql.query<HandoffRow>('select * from handoffs where resource_id = $1 order by created_version, id', [rid])).rows;

export const loadProposals = async (sql: Sql, rid: string) =>
  (await sql.query<ProposalRow>('select * from proposals where resource_id = $1 order by created_version, id', [rid])).rows;

export const loadCapabilities = async (sql: Sql, rid: string) =>
  (await sql.query<CapabilityRow>('select * from capabilities where resource_id = $1 order by created_version, id', [rid]))
    .rows;

export async function loadCheckpoints(sql: Sql, rid: string): Promise<CheckpointRow[]> {
  return (
    await sql.query<CheckpointRow>(
      `select resource_id, number, version, label, note, snapshot_sha256, created_by_session_id, created_at
         from checkpoints where resource_id = $1 order by number`,
      [rid],
    )
  ).rows;
}

export async function loadCheckpoint(sql: Sql, rid: string, n: number): Promise<CheckpointRow> {
  const { rows } = await sql.query<CheckpointRow>('select * from checkpoints where resource_id = $1 and number = $2', [
    rid,
    n,
  ]);
  if (!rows[0]) throw new AcspError('not_found', `Resource ${rid} has no checkpoint ${n}.`);
  return rows[0];
}

export async function loadEvents(sql: Sql, rid: string, opts: { after?: number; upTo?: number; limit?: number } = {}) {
  const { rows } = await sql.query<EventRow>(
    `select * from events where resource_id = $1 and version > $2 and version <= $3 order by version limit $4`,
    [rid, opts.after ?? 0, opts.upTo ?? 2_147_483_647, opts.limit ?? 10_000],
  );
  return rows;
}

export async function loadRecentEvents(sql: Sql, rid: string, n: number) {
  const { rows } = await sql.query<EventRow>(
    'select * from events where resource_id = $1 order by version desc limit $2',
    [rid, n],
  );
  return rows.reverse();
}

export async function loadEvent(sql: Sql, rid: string, version: number): Promise<EventRow> {
  const { rows } = await sql.query<EventRow>('select * from events where resource_id = $1 and version = $2', [
    rid,
    version,
  ]);
  if (!rows[0]) throw new AcspError('not_found', `Resource ${rid} has no event at version ${version}.`);
  return rows[0];
}

export async function loadForks(sql: Sql, rid: string) {
  return (
    await sql.query<Pick<ResourceRow, 'id' | 'title' | 'owner_session_id' | 'parent_version' | 'parent_checkpoint' | 'created_at' | 'lifecycle'>>(
      `select id, title, owner_session_id, parent_version, parent_checkpoint, created_at, lifecycle
         from resources where parent_id = $1 order by created_at, id`,
      [rid],
    )
  ).rows;
}

/**
 * The externally persisted state at the resource's current version, as
 * captured by a checkpoint. Deterministic, so its canonical hash is
 * reproducible from the snapshot alone.
 */
export async function buildSnapshot(sql: Sql, resource: ResourceRow) {
  // Sequential on purpose: `sql` may be a single transaction connection.
  const toks = await loadToks(sql, resource.id);
  const annotations = await loadAnnotations(sql, resource.id);
  const handoffs = await loadHandoffs(sql, resource.id);
  return {
    protocol: PROTOCOL_VERSION,
    resource: {
      id: resource.id,
      version: resource.version,
      title: resource.title,
      description: resource.description,
      focus: resource.focus,
      lifecycle: resource.lifecycle,
      owner: { session_id: resource.owner_session_id, agent_id: resource.owner_agent_id, human: resource.owner_human },
      parent: resource.parent_id
        ? { id: resource.parent_id, version: resource.parent_version, checkpoint: resource.parent_checkpoint }
        : null,
      created_at: iso(resource.created_at),
    },
    knowledge: toks.map((t) => tokRecord(t, annotations)),
    handoffs: handoffs.map(handoffRecord),
  };
}
export type Snapshot = Awaited<ReturnType<typeof buildSnapshot>>;


// ── ACSP/0.2: operations and the operational state ─────────────────────────

export async function loadOperations(sql: Sql, rid: string, opts: { afterSeq?: number; limit?: number; correlationId?: string } = {}) {
  const { rows } = await sql.query<OperationRow>(
    `select * from operations where resource_id = $1 and seq > $2 and ($4::text is null or correlation_id = $4)
      order by seq limit $3`,
    [rid, opts.afterSeq ?? 0, opts.limit ?? 10_000, opts.correlationId ?? null],
  );
  return rows;
}

export async function loadOperation(sql: Sql, rid: string, id: string): Promise<OperationRow> {
  const { rows } = await sql.query<OperationRow>('select * from operations where resource_id = $1 and id = $2', [rid, id]);
  if (!rows[0]) throw new AcspError('not_found', `Resource ${rid} has no operation ${id}.`);
  return rows[0];
}

export async function findOperation(sql: Sql, rid: string, id: string): Promise<OperationRow | null> {
  const { rows } = await sql.query<OperationRow>('select * from operations where resource_id = $1 and id = $2', [rid, id]);
  return rows[0] ?? null;
}

export async function loadLatestOperation(sql: Sql, rid: string): Promise<OperationRow | null> {
  const { rows } = await sql.query<OperationRow>('select * from operations where resource_id = $1 order by seq desc limit 1', [rid]);
  return rows[0] ?? null;
}

/** Operations whose causation_id is `id` (the operations that respond to it). */
export async function loadConsequences(sql: Sql, rid: string, id: string) {
  const { rows } = await sql.query<OperationRow>('select * from operations where resource_id = $1 and causation_id = $2 order by seq', [rid, id]);
  return rows;
}

export async function loadOperationEvents(sql: Sql, rid: string, opId: string) {
  const { rows } = await sql.query<EventRow>('select * from events where resource_id = $1 and operation_id = $2 order by version', [rid, opId]);
  return rows;
}

/**
 * The OPERATIONAL STATE of a resource at its current version: everything an
 * operation can change — metadata, knowledge (with annotations), handoffs,
 * proposals, capabilities (public fields only) and checkpoint boundaries.
 * Deterministic and time-independent (no "status as of now"), so anyone who
 * GETs /r/{id}/state can recompute its SHA-256. Each operation record carries
 * the digest before and after it.
 */
export async function buildOperationalState(sql: Sql, resource: ResourceRow) {
  const snapshot = await buildSnapshot(sql, resource);
  const proposals = (await loadProposals(sql, resource.id)).map(proposalRecord);
  const capabilities = (await loadCapabilities(sql, resource.id)).map((c) => ({
    id: c.id,
    kind: c.kind,
    session_id: c.session_id,
    agent_id: c.agent_id,
    scopes: c.scopes,
    created_version: c.created_version,
    expires_at: iso(c.expires_at),
    revoked_at: iso(c.revoked_at),
    revoked_version: c.revoked_version,
  }));
  const checkpoints = (await loadCheckpoints(sql, resource.id)).map((c) => ({ number: c.number, version: c.version, label: c.label, sha256: c.snapshot_sha256 }));
  return {
    schema: 'acsp.operational-state/0.2',
    resource: {
      ...snapshot.resource,
      visibility: resource.visibility,
      accepts_proposals: resource.accepts_proposals,
      enabled_extensions: [...(resource.enabled_extensions ?? [])].sort(),
    },
    knowledge: snapshot.knowledge,
    handoffs: snapshot.handoffs,
    proposals,
    capabilities,
    checkpoints,
  };
}
export type OperationalState = Awaited<ReturnType<typeof buildOperationalState>>;
