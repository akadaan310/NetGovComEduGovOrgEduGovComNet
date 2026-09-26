/**
 * exp-0003 agent. Each invocation is ONE independent session turn, run as its
 * own OS process:
 *
 *   tsx scripts/exp-0003/agent.ts a-start   <service-url> [--delegate session-b]
 *   tsx scripts/exp-0003/agent.ts b         <continuation-url>
 *   tsx scripts/exp-0003/agent.ts b-retry
 *   tsx scripts/exp-0003/agent.ts a-review  <continuation-url>
 *   tsx scripts/exp-0003/agent.ts c         <continuation-url>
 *
 * Inputs: argv, PRIVATE_DIR (this session's own directory), and — only when a
 * human explicitly handed one over — ACSP_CAPABILITY. Output: one JSON line on
 * stdout; the full HTTP transcript (secrets redacted) in PRIVATE_DIR.
 * Nothing else is shared between sessions.
 */
import { randomBytes } from 'node:crypto';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { canonicalHash } from '../../src/continuity/canonical';
import { causationChain, openContinuation, verifyLineage } from '../../harness/verify';

const [mode, arg, ...rest] = process.argv.slice(2);
const DIR = process.env.PRIVATE_DIR!;
const SESSION = { 'a-start': 'session-a', 'a-review': 'session-a', b: 'session-b', 'b-retry': 'session-b', c: 'session-c' }[mode] ?? 'unknown';
const CAP_RE = /acsp_cap_[0-9A-Z]{10}_[0-9A-Z]{32}/g;

const transcript: unknown[] = [];
let receivedSecret = false;
const redact = (v: unknown) => JSON.parse(JSON.stringify(v ?? null).replace(CAP_RE, '[REDACTED CAPABILITY]'));

async function http(method: 'GET' | 'POST', url: string, body?: unknown, token?: string | null) {
  const res = await fetch(url, {
    method,
    headers: { Accept: 'application/json', ...(body ? { 'Content-Type': 'application/json' } : {}), ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  const secretInResponse = CAP_RE.test(text);
  CAP_RE.lastIndex = 0;
  let json: any = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* non-JSON */
  }
  transcript.push({ method, url, authorization: token ? 'Bearer [REDACTED CAPABILITY]' : null, status: res.status, request: redact(body), response: redact(json ?? text.slice(0, 2000)), secret_in_response: secretInResponse });
  return { status: res.status, body: json, secretInResponse };
}
const get = (url: string, token?: string | null) => http('GET', url, undefined, token);
const key = () => `${SESSION}-${randomBytes(8).toString('hex')}`;
const envelope = (operation: string, payload: unknown, extra: Record<string, unknown> = {}) => ({
  protocol: 'ACSP/0.2',
  operation,
  actor: { session_id: SESSION, agent_id: `exp-0003-${mode}`, kind: 'agent' },
  idempotency_key: key(),
  payload,
  ...extra,
});
const post = (url: string, env: unknown, token?: string | null) => http('POST', url, env, token);
const priv = (name: string) => join(DIR, name);

async function aStart(service: string) {
  const delegateTo = rest[0] === '--delegate' ? rest[1] : null;
  const c = await post(`${service}/r`, envelope('create', { title: 'exp-0003: inter-session operational communication', focus: 'B continues from A\'s persisted state; C reconstructs why.' }));
  const rid = c.body.resource_id;
  writeFileSync(priv('owner-capability'), c.body.result.owner_capability.token, { mode: 0o600 }); // A's own secret
  const ops = `${service}/r/${rid}/operations`;
  const tok = c.body.result.owner_capability.token;
  const task = await post(ops, envelope('append', { type: 'task', title: 'Check the finding and add a counter-observation' }), tok);
  const finding = await post(ops, envelope('append', { type: 'finding', title: 'Queue depth predicts p99 latency', stated_confidence: 'medium' }, { causation_id: task.body.operation_id }), tok);
  const cp = await post(ops, envelope('checkpoint', { label: 'A stops here' }, { causation_id: finding.body.operation_id }), tok);
  let last = cp;
  let delegated: string | null = null;
  if (delegateTo) {
    last = await post(ops, envelope('delegate', { to: { session_id: delegateTo }, scopes: ['append'], label: 'exp-0003 delegation run' }, { causation_id: cp.body.operation_id }), tok);
    delegated = last.body.result.capability.token;
    // The human's out-of-band channel for the ONE explicit authority transfer.
    writeFileSync(priv('handover-for-human'), delegated!, { mode: 0o600 });
  }
  return {
    statuses: [c.status, task.status, finding.status, cp.status, ...(delegateTo ? [last.status] : [])],
    resource_id: rid,
    first_cited_operation: task.body.operation_id,
    operation_ids: [c.body.operation_id, task.body.operation_id, finding.body.operation_id, cp.body.operation_id, ...(delegateTo ? [last.body.operation_id] : [])],
    delegated: Boolean(delegated),
    continuation: last.body.continuation.href,
  };
}

async function sessionB(href: string) {
  const token = process.env.ACSP_CAPABILITY ?? null;
  const cont = await openContinuation((u) => get(u, token), href);
  const doc = cont.doc;
  const report = await verifyLineage((u) => get(u, token), doc.resource.url);
  const ops = `${doc.resource.url}/operations`;
  const authority = { authenticated: doc.viewer.authenticated, session_id: doc.viewer.session_id, scopes: doc.viewer.scopes, permitted: doc.how_to_continue.permitted_operations };
  const cite = { causation_id: doc.reference.operation_id, correlation_id: doc.reference.correlation_id };
  const out: Record<string, unknown> = { continuation_schema_valid: cont.schema_valid, verification: report, authority, reference: doc.reference, produced_by: doc.produced_by.executed_by.session_id };
  if (!token) {
    const tryAppend = await post(ops, envelope('append', { type: 'observation', title: 'Counter-observation: depth lags latency by 2 s' }, cite));
    out.append_without_capability = { status: tryAppend.status, code: tryAppend.body?.error?.code };
    const env = envelope('propose', { operation: 'append', payload: { type: 'observation', title: 'Counter-observation: depth lags latency by 2 s', refs: [{ tok: 'TOK-002' }] }, rationale: 'B has no capability; asking the owner to record this.' }, { ...cite, expected_version: doc.how_to_continue.expected_version });
    writeFileSync(priv('last-envelope.json'), JSON.stringify(env)); // B's own record, for its own retry
    const p = await post(ops, env);
    out.propose = { status: p.status, operation_id: p.body.operation_id, identity_assurance: p.body.operation_record?.identity_assurance, causation_id: p.body.operation_record?.lineage.causation_id, proposal_id: p.body.result?.proposal?.id };
    const tryResolve = await post(ops, envelope('resolve_proposal', { proposal_id: p.body.result.proposal.id, decision: 'accept' }, { expected_version: p.body.version }));
    out.resolve_without_capability = { status: tryResolve.status, code: tryResolve.body?.error?.code };
    out.continuation = p.body.continuation.href;
  } else {
    const a = await post(ops, envelope('append', { type: 'observation', title: 'Counter-observation under delegated authority', refs: [{ tok: 'TOK-002' }] }, cite), token);
    out.append = { status: a.status, operation_id: a.body.operation_id, identity_assurance: a.body.operation_record?.identity_assurance, capability_kind: a.body.operation_record?.authority.capability_kind, causation_id: a.body.operation_record?.lineage.causation_id };
    out.continuation = a.body.continuation.href;
  }
  return out;
}

async function sessionBRetry() {
  // A restarted B process re-sends its last request (as after a lost response).
  const env = JSON.parse(readFileSync(priv('last-envelope.json'), 'utf8'));
  const rid = /\/r\/([0-9A-Z]{12})/.exec(readFileSync(priv('last-resource'), 'utf8'))![1];
  const base = readFileSync(priv('last-resource'), 'utf8').trim();
  const r = await post(`${base}/operations`, env);
  const doc = await get(`${base}.json`);
  return { status: r.status, replayed: r.body.replayed, operation_id: r.body.operation_id, proposals: doc.body.proposals.length, resource_id: rid };
}

async function aReview(href: string) {
  const token = readFileSync(priv('owner-capability'), 'utf8').trim(); // A's own saved secret
  const cont = await openContinuation((u) => get(u, token), href);
  const doc = cont.doc;
  const report = await verifyLineage((u) => get(u, token), doc.resource.url);
  const opRec = (await get(`${doc.links.self}.json`, token)).body.operation;
  const pid = opRec.result.proposal.id;
  const prop = (await get(`${doc.resource.url}/proposals/${pid}.json`, token)).body;
  const hashOk = canonicalHash(prop.proposed_operation.payload) === prop.proposed_operation.payload_sha256;
  const res = await post(`${doc.resource.url}/operations`, envelope('resolve_proposal', { proposal_id: pid, decision: 'accept', note: 'Checked by session-a.' }, { expected_version: doc.current.version }), token);
  return {
    viewer_is_owner: doc.viewer.is_owner,
    verification: report,
    proposal: { id: pid, requested_by: prop.proposal.requested_by.session_id, payload_hash_ok: hashOk, proposed_in: prop.proposed_operation.proposed_in_operation },
    accept: { status: res.status, operation_id: res.body.operation_id, causation_id: res.body.operation_record?.lineage.causation_id, causation_source: res.body.operation_record?.lineage.causation_source, events: res.body.operation_record?.transition.events.length, on_behalf_of: res.body.operation_record?.on_behalf_of?.session_id },
    continuation: res.body.continuation.href,
  };
}

async function sessionC(href: string) {
  const cont = await openContinuation((u) => get(u, null), href);
  const doc = cont.doc;
  const report = await verifyLineage((u) => get(u, null), doc.resource.url);
  const chain = causationChain(report.graph, doc.reference.operation_id).map((id) => report.graph.find((g) => g.operation_id === id)!);
  // Try to use the reference as authority: re-submit the recorded final operation without a capability.
  const rec = (await get(`${doc.links.self}.json`)).body.operation;
  const before = doc.current.version;
  const replay = await post(`${doc.resource.url}/operations`, { protocol: rec.protocol_version, operation: rec.operation_type, actor: { session_id: rec.actor.session_id }, idempotency_key: rec.idempotency_key, expected_version: rec.expected_version ?? undefined, payload: rec.payload });
  const after = (await get(`${doc.resource.url}.json`)).body.state.version;
  return {
    continuation_schema_valid: cont.schema_valid,
    verification: report,
    causation_chain: chain.map((g) => ({ operation_type: g.operation_type, actor: g.actor, identity_assurance: g.identity_assurance, causation_source: g.causation_source })),
    chain_ids: chain.map((g) => g.operation_id),
    correlation_ids: [...new Set(chain.map((g) => g.correlation_id))],
    owner: (await get(`${doc.resource.url}.json`)).body.ownership.owner.session_id,
    replay_without_capability: { status: replay.status, code: replay.body?.error?.code, version_unchanged: before === after },
  };
}

async function main() {
  let out: Record<string, unknown>;
  if (mode === 'a-start') out = await aStart(arg);
  else if (mode === 'b') {
    writeFileSync(priv('last-resource'), /^(.*\/r\/[0-9A-Z]{12})/.exec(arg)![1]);
    out = await sessionB(arg);
  } else if (mode === 'b-retry') out = await sessionBRetry();
  else if (mode === 'a-review') out = await aReview(arg);
  else if (mode === 'c') out = await sessionC(arg);
  else throw new Error(`unknown mode ${mode}`);
  const n = existsSync(priv(`transcript-${mode}.json`)) ? 2 : 1;
  writeFileSync(priv(`transcript-${mode}${n > 1 ? `-${n}` : ''}.json`), JSON.stringify({ mode, session: SESSION, pid: process.pid, transcript }, null, 1));
  process.stdout.write(JSON.stringify({ mode, session: SESSION, pid: process.pid, received_capability_secret: receivedSecret || transcript.some((x: any) => x.secret_in_response), ...out }) + '\n');
}

main().catch((e) => {
  process.stdout.write(JSON.stringify({ mode, error: String(e?.stack ?? e) }) + '\n');
  process.exitCode = 1;
});
