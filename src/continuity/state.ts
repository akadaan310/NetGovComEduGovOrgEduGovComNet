/** Loading persisted continuity state. Used by handlers, snapshots and representations. */
import type { Sql } from '../db/types';
import { PROTOCOL_VERSION } from '../protocol/constants';
import { AcspError } from '../protocol/errors';
import { getSubstrate, substrateRef } from '../substrates/registry';
import {
  aliasRecord,
  capabilityRecord,
  embodimentRecord,
  executionRecord,
  handoffRecord,
  iso,
  scrollVersionRecord,
  tokRecord,
  type AliasBindingRow,
  type AnnotationRow,
  type EmbodimentRow,
  type ExecutionRow,
  type ScrollRow,
  type CapabilityRow,
  type CheckpointRow,
  type EventRow,
  type HandoffRow,
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

// ── Program 001 ──

export const loadEmbodiments = async (sql: Sql, rid: string) =>
  (await sql.query<EmbodimentRow>('select * from embodiments where resource_id = $1 order by attached_version, id', [rid])).rows;

export const loadScrolls = async (sql: Sql, rid: string) =>
  (await sql.query<ScrollRow>('select * from scrolls where resource_id = $1 order by scroll_id, version', [rid])).rows;

export const loadAliasBindings = async (sql: Sql, rid: string) =>
  (await sql.query<AliasBindingRow>('select * from alias_bindings where resource_id = $1 order by name, binding', [rid])).rows;

export async function loadExecutions(sql: Sql, rid: string, opts: { after?: number; limit?: number; recent?: number } = {}) {
  if (opts.recent !== undefined) {
    const { rows } = await sql.query<ExecutionRow>('select * from executions where resource_id = $1 order by number desc limit $2', [rid, opts.recent]);
    return rows.reverse();
  }
  const { rows } = await sql.query<ExecutionRow>(
    'select * from executions where resource_id = $1 and number > $2 order by number limit $3',
    [rid, opts.after ?? 0, opts.limit ?? 100_000],
  );
  return rows;
}

/** Group alias binding rows (ordered by name, binding) into alias records. */
export function groupAliases(rows: AliasBindingRow[]) {
  const by = new Map<string, AliasBindingRow[]>();
  for (const r of rows) by.set(r.name, [...(by.get(r.name) ?? []), r]);
  return Array.from(by.values()).map(aliasRecord);
}

/**
 * Program 001 state of an agent identity, as captured in its checkpoints: everything a later,
 * independent session needs to continue — identity, embodiments, Scroll versions with content,
 * aliases with history, execution history, authority (without secrets) and substrate context.
 */
async function identitySnapshot(sql: Sql, resource: ResourceRow, now: Date) {
  const embodiments = await loadEmbodiments(sql, resource.id);
  const scrolls = await loadScrolls(sql, resource.id);
  const aliases = groupAliases(await loadAliasBindings(sql, resource.id));
  const executions = await loadExecutions(sql, resource.id);
  const caps = await sql.query<CapabilityRow>(
    'select * from capabilities where resource_id = $1 order by created_version, id',
    [resource.id],
  );
  const active = embodiments.find((e) => e.status === 'active') ?? null;
  const current = resource.current_substrate_id ? getSubstrate(resource.current_substrate_id) : undefined;
  const used = new Map<string, unknown>();
  for (const x of executions) for (const st of executionRecord(x).substrates_used) used.set(st.substrate_id, st);
  return {
    identity: {
      agent_id: resource.id,
      display_name: resource.title,
      description: resource.description,
      owner_principal: resource.owner_human,
      also_known_as: resource.also_known_as,
      current_embodiment: active ? embodimentRecord(active) : null,
      current_substrate: current ? substrateRef(current) : null,
    },
    embodiments: embodiments.map(embodimentRecord),
    scrolls: scrolls.map((s) => scrollVersionRecord(s, { aliases: aliases.filter((a) => a.target.ref === `${s.scroll_id}:v${s.version}`).map((a) => a.name) })),
    aliases,
    executions: executions.map(executionRecord),
    authority: {
      owner: { session_id: resource.owner_session_id, human: resource.owner_human },
      capabilities: caps.rows.map((c) => capabilityRecord(c, now)),
    },
    substrate_context: { current: current ? substrateRef(current) : null, used: Array.from(used.values()) },
  };
}

/**
 * The externally persisted state at the resource's current version, as
 * captured by a checkpoint. Deterministic, so its canonical hash is
 * reproducible from the snapshot alone. Agent identities add their
 * Program 001 state; other resources' snapshots are unchanged.
 */
export async function buildSnapshot(sql: Sql, resource: ResourceRow, now: Date = resource.updated_at) {
  // Sequential on purpose: `sql` may be a single transaction connection.
  const toks = await loadToks(sql, resource.id);
  const annotations = await loadAnnotations(sql, resource.id);
  const handoffs = await loadHandoffs(sql, resource.id);
  const program001 = resource.kind === 'agent_identity' ? { kind: resource.kind, ...(await identitySnapshot(sql, resource, now)) } : {};
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
    ...program001,
  };
}
export type Snapshot = Awaited<ReturnType<typeof buildSnapshot>>;
