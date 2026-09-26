/**
 * ACSP/0.2 operational communication: independent sessions continue work
 * through persisted operations and continuation references, never through
 * shared memory, transcripts or transferred authority.
 */
import { canonicalHash } from '../../src/continuity/canonical';
import { PROTOCOL_VERSION } from '../../src/protocol/constants';
import { OperationResultSchema } from '../../src/protocol/schemas';
import type { AcspClient } from '../client';
import type { Scenario, T } from '../scenario';
import { causationChain, openContinuation, verifyLineage, type Getter } from '../verify';

export const getter = (client: AcspClient, token?: string | null): Getter => (u) => client.getJson(u, token);

/** Assert a mutation response is a valid acsp.operation-result/0.2 and return its continuation href. */
export function continuationOf(t: T, res: { status: number; body: any }, label: string): string {
  const parsed = OperationResultSchema.safeParse(res.body);
  t.check(parsed.success, `${label}: response matches acsp.operation-result/0.2${parsed.success ? '' : ` — ${JSON.stringify(parsed.error.issues[0])}`}`);
  const href: string = res.body?.continuation?.href ?? '';
  t.check(href.includes('/continue/op-') && !href.includes('cap='), `${label}: continuation reference present and carries no capability`);
  return href;
}

export const interSessionHandoff: Scenario = {
  name: 'inter-session-operation-handoff',
  description: 'A operates and stops; B receives only a continuation URL, verifies, determines it has no authority, proposes; A accepts; C reconstructs the lineage.',
  async run(w, t) {
    // Each "session" is a separate Actor holding only what it was explicitly given.
    // What crosses between them is a URL string — nothing else.
    let hrefFromA = '';
    let ownerTokenKeptByA = '';
    let rid = '';

    await t.step('Session A creates a resource, publishes a task and a finding, checkpoints, and stops', async () => {
      const a = w.actor('a', { session: 'session-a', agent: 'agent-a' });
      const c = await a.create({ title: 'Inter-session operation handoff', focus: 'Can B continue from A\'s state without A\'s conversation?' });
      t.status(c, 201, 'create');
      rid = c.body.resource_id;
      ownerTokenKeptByA = c.body.result.owner_capability.token; // A's own secret: never passed on
      const task = await a.append(rid, { type: 'task', title: 'Review the finding and add a counter-check' });
      t.status(task, 200, 'append task');
      const f = await a.append(rid, { type: 'finding', title: 'Queue depth predicts latency', stated_confidence: 'medium' }, { extra: { causation_id: task.body.operation_id } });
      t.status(f, 200, 'append finding citing the task operation');
      const cp = await a.checkpoint(rid, { label: 'A stops here' }, { extra: { causation_id: f.body.operation_id } });
      t.status(cp, 200, 'checkpoint');
      hrefFromA = continuationOf(t, cp, 'A checkpoint');
      t.eq(cp.body.operation_record.lineage.correlation_id, task.body.operation_record.lineage.correlation_id, 'the correlation id is inherited along the causation chain');
      a.forget(); // Session A ends: it loses every capability it held.
    });

    let hrefFromB = '';
    await t.step('Session B receives ONLY the URL, resolves it and verifies the persisted history', async () => {
      const b = w.actor('b', { session: 'session-b', agent: 'agent-b' });
      const get = getter(w.client, null);
      const cont = await openContinuation(get, hrefFromA);
      t.status({ status: cont.status, body: cont.doc }, 200, 'GET continuation (JSON)');
      t.check(cont.schema_valid, `continuation matches acsp.continuation/0.2${cont.schema_issue ? ` — ${JSON.stringify(cont.schema_issue)}` : ''}`);
      t.eq(cont.doc.reference.resource_id, rid, 'the reference resolves to the resource');
      t.eq(cont.doc.produced_by.executed_by.session_id, 'session-a', 'the producer is session-a — attributed, not B');
      t.eq(cont.doc.current.moved_since_reference, false, 'nothing happened since the reference');
      const html = await w.client.getHtml(hrefFromA);
      t.check(html.text.includes('CONTINUATION REFERENCE') && html.text.includes('acsp-document'), 'the same URL opens as a human-readable page with the JSON embedded');
      const report = await verifyLineage(get, cont.doc.resource.url);
      t.check(report.chain_ok && report.versions_contiguous, `operation chain is contiguous (${report.operations} operations)`);
      t.check(report.state_matches_latest, 'B recomputes the current state digest and it equals the latest operation\'s state_after');
      t.check(report.checkpoints_ok, 'every checkpoint hash recomputes from its snapshot');
      t.check(report.records_schema_valid, 'every operation record matches acsp.operation/0.2');
      t.eq(report.problems, [], 'no verification problems');

      // Authority is B's own, evaluated when B reads: none.
      t.eq(cont.doc.viewer.authenticated, false, 'B presents no capability');
      t.check(!cont.doc.how_to_continue.permitted_operations.includes('append'), 'append is NOT permitted for B');
      t.check(cont.doc.how_to_continue.permitted_operations.includes('propose'), 'propose is permitted for B');
      const refused = await b.append(rid, { type: 'finding', title: 'Counter-check' }, { extra: { causation_id: cont.doc.reference.operation_id } });
      t.status(refused, 401, 'holding the URL does not let B append', 'authentication_required');

      const p = await b.propose(
        rid,
        { operation: 'append', payload: { type: 'finding', title: 'Counter-check: queue depth lags latency by 2 s', refs: [{ tok: 'TOK-002' }] }, rationale: 'B cannot append; asking the owner.' },
        { extra: { causation_id: cont.doc.reference.operation_id }, expected_version: cont.doc.how_to_continue.expected_version },
      );
      t.status(p, 200, 'B proposes, citing A\'s operation as causation');
      t.eq(p.body.operation_record.identity_assurance, 'asserted', 'B\'s identity is recorded as asserted (no capability)');
      t.eq(p.body.operation_record.lineage.causation_id, cont.doc.reference.operation_id, 'causation recorded');
      hrefFromB = continuationOf(t, p, 'B propose');
    });

    let finalHref = '';
    await t.step('Session A (a new process with only its own saved capability) receives B\'s URL and accepts', async () => {
      const a2 = w.actor('a2', { session: 'session-a', agent: 'agent-a', keyPrefix: 'session-a-process-2' });
      a2.receive(rid, ownerTokenKeptByA);
      const cont = await openContinuation(getter(w.client, ownerTokenKeptByA), hrefFromB);
      t.eq(cont.doc.viewer.is_owner, true, 'A\'s own capability makes A the owner viewer');
      t.check(cont.doc.how_to_continue.permitted_operations.includes('resolve_proposal'), 'resolve_proposal is permitted for A');
      const pid = cont.doc.produced_by.operation_type === 'propose' ? 'P-001' : '';
      const prop = await w.client.getJson(`/r/${rid}/proposals/${pid}`);
      t.status(prop, 200, 'GET the proposal object');
      t.eq(prop.body.proposed_operation.payload_sha256, canonicalHash(prop.body.proposed_operation.payload), 'the proposal\'s payload hash recomputes');
      t.eq(prop.body.proposed_operation.proposed_in_operation, cont.doc.reference.operation_id, 'the proposal names the operation that created it');
      const res = await a2.resolveProposal(rid, { proposal_id: pid, decision: 'accept', note: 'accepted' }, { expected_version: cont.doc.current.version });
      t.status(res, 200, 'accept');
      t.eq(res.body.operation_record.lineage.causation_id, cont.doc.reference.operation_id, 'causation derived from the proposal (no citation needed)');
      t.eq(res.body.operation_record.lineage.causation_source, 'derived', 'marked as server-derived');
      t.eq(res.body.operation_record.transition.events.length, 2, 'one operation, two events (resolve + executed append)');
      t.eq(res.body.operation_record.on_behalf_of.session_id, 'session-b', 'executed on behalf of session-b');
      finalHref = continuationOf(t, res, 'A accept');
    });

    await t.step('Session C (no capability, no transcript) reconstructs the complete lineage from the final URL', async () => {
      const get = getter(w.client, null);
      const cont = await openContinuation(get, finalHref);
      const report = await verifyLineage(get, cont.doc.resource.url);
      t.check(report.chain_ok && report.versions_contiguous && report.state_matches_latest && report.checkpoints_ok && report.records_schema_valid, 'C verifies the whole history');
      const chain = causationChain(report.graph, cont.doc.reference.operation_id).map((id) => report.graph.find((g) => g.operation_id === id)!);
      t.eq(chain.map((g) => `${g.operation_type}:${g.actor}`), ['resolve_proposal:session-a', 'propose:session-b', 'checkpoint:session-a', 'append:session-a', 'append:session-a'], 'why this state exists: accept ← propose ← checkpoint ← finding ← task');
      t.eq(new Set(chain.map((g) => g.correlation_id)).size, 1, 'one workflow (correlation id) end to end');
      const doc = (await w.client.getJson(`/r/${rid}`)).body;
      t.eq(doc.ownership.owner.session_id, 'session-a', 'ownership never moved');
      const tok = doc.knowledge.items.find((k: any) => k.title.startsWith('Counter-check'));
      t.eq([tok.source.session_id, tok.source.identity_assurance, tok.recorded_by.session_id], ['session-b', 'asserted', 'session-a'], 'B is the source, A recorded it; B\'s identity is only asserted');
      const all = JSON.stringify([cont.doc, report]);
      t.check(!all.includes('acsp_cap_'), 'no capability secret appears anywhere C can read');
    });

    await t.step('Variant: explicit delegation lets B act directly — authority moves only by delegate', async () => {
      // A restarted session must not reuse its key sequence under the same capability: the server would
      // (correctly) refuse the colliding key with idempotency_key_reuse. Fresh key prefix per process.
      const owner = w.actor('a3', { session: 'session-a', keyPrefix: 'session-a-process-3' });
      owner.receive(rid, ownerTokenKeptByA);
      const d = await owner.delegate(rid, { to: { session_id: 'session-b' }, scopes: ['append'] });
      t.status(d, 200, 'owner delegates [append] to session-b');
      const b = w.actor('b2', { session: 'session-b', agent: 'agent-b' });
      b.receive(rid, d.body.result.capability.token);
      const cont = await openContinuation(getter(w.client, d.body.result.capability.token), d.body.continuation.href);
      t.check(cont.doc.how_to_continue.permitted_operations.includes('append'), 'after delegate, append is permitted for B');
      const res = await b.append(rid, { type: 'observation', title: 'Direct contribution under delegated authority' }, { extra: { causation_id: cont.doc.reference.operation_id } });
      t.status(res, 200, 'B appends');
      t.eq([res.body.operation_record.identity_assurance, res.body.operation_record.authority.capability_kind], ['capability', 'delegation'], 'identity proven by a delegated capability');
      t.eq(res.body.protocol, PROTOCOL_VERSION, 'response protocol');
    });
  },
};
