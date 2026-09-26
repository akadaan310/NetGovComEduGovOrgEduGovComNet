/**
 * Independent verification of an ACSP resource's operational history, using
 * only what GET returns. Used by the harness scenarios and by the separate
 * agent processes of experiment exp-0003. It imports no engine code: only the
 * canonical-JSON hash (which any client can reimplement) and the published
 * schemas.
 */
import { canonicalHash } from '../src/continuity/canonical';
import { ContinuationDocumentSchema, OperationRecordSchema } from '../src/protocol/schemas';

export type Getter = (url: string) => Promise<{ status: number; body: any }>;

export interface LineageReport {
  resource_id: string;
  operations: number;
  chain_ok: boolean;
  versions_contiguous: boolean;
  state_matches_latest: boolean;
  checkpoints_ok: boolean;
  records_schema_valid: boolean;
  problems: string[];
  graph: { operation_id: string; sequence: number; operation_type: string; actor: string; identity_assurance: string; causation_id: string | null; causation_source: string | null; correlation_id: string; from_version: number; to_version: number }[];
}

/** Fetch every operation record (following `next`) and check the digest chain, versions, state and checkpoints. */
export async function verifyLineage(get: Getter, resourceUrl: string): Promise<LineageReport> {
  const problems: string[] = [];
  const base = resourceUrl.replace(/\.json$/, '');
  const list: any[] = [];
  for (let next: string | null = `${base}/op.json`; next; ) {
    const page = await get(next);
    if (page.status !== 200) throw new Error(`GET ${next} → ${page.status}`);
    list.push(...page.body.operations);
    next = page.body.next ? page.body.next.replace(/\/op\?/, '/op.json?') : null;
  }
  let chain = true;
  let contiguous = true;
  let schemaOk = true;
  for (let i = 0; i < list.length; i++) {
    const o = list[i];
    const full = await get(o.href + '.json');
    const parsed = OperationRecordSchema.safeParse(full.body.operation);
    if (!parsed.success) {
      schemaOk = false;
      problems.push(`${o.operation_id}: record does not match acsp.operation/0.2: ${parsed.error.issues[0]?.message}`);
    }
    if (i > 0) {
      const p = list[i - 1];
      if (o.state_before !== p.state_after) {
        chain = false;
        problems.push(`${o.operation_id}: state_before ≠ previous state_after`);
      }
      if (o.from_version !== p.to_version) {
        contiguous = false;
        problems.push(`${o.operation_id}: from_version ${o.from_version} ≠ previous to_version ${p.to_version}`);
      }
      if (o.parent_operation_id !== p.operation_id) {
        chain = false;
        problems.push(`${o.operation_id}: parent_operation_id ≠ previous operation`);
      }
    }
  }
  const state = await get(`${base}/state.json`);
  const recomputed = canonicalHash(state.body.state);
  const latest = list[list.length - 1];
  const stateOk = recomputed === state.body.sha256 && (!latest || latest.state_after === recomputed);
  if (!stateOk) problems.push(`state: recomputed ${recomputed}, served ${state.body.sha256}, latest state_after ${latest?.state_after}`);
  let cpOk = true;
  const cps = await get(`${base}/checkpoints.json`);
  for (const c of cps.body.checkpoints) {
    const one = await get(`${base}/checkpoints/${c.number}.json`);
    if (canonicalHash(one.body.checkpoint.snapshot) !== one.body.checkpoint.sha256) {
      cpOk = false;
      problems.push(`checkpoint ${c.number}: snapshot does not hash to its sha256`);
    }
  }
  return {
    resource_id: state.body.resource_id,
    operations: list.length,
    chain_ok: chain,
    versions_contiguous: contiguous,
    state_matches_latest: stateOk,
    checkpoints_ok: cpOk,
    records_schema_valid: schemaOk,
    problems,
    graph: list.map((o) => ({
      operation_id: o.operation_id,
      sequence: o.sequence,
      operation_type: o.operation_type,
      actor: o.actor.session_id,
      identity_assurance: o.identity_assurance,
      causation_id: o.causation_id,
      causation_source: o.causation_source,
      correlation_id: o.correlation_id,
      from_version: o.from_version,
      to_version: o.to_version,
    })),
  };
}

/** Follow causation_id back from `opId` to its root, using only the graph. */
export function causationChain(graph: LineageReport['graph'], opId: string): string[] {
  const byId = new Map(graph.map((g) => [g.operation_id, g]));
  const out: string[] = [];
  for (let cur = byId.get(opId); cur && out.length < 256; cur = cur.causation_id ? byId.get(cur.causation_id) : undefined) out.push(cur.operation_id);
  return out;
}

export async function openContinuation(get: Getter, href: string) {
  const res = await get(href.endsWith('.json') ? href : `${href}.json`);
  const parsed = ContinuationDocumentSchema.safeParse(res.body);
  return { status: res.status, doc: res.body, schema_valid: parsed.success, schema_issue: parsed.success ? null : parsed.error.issues[0] };
}
