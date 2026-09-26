import { canonicalHash } from '../../src/continuity/canonical';
import type { Scenario } from '../scenario';
import { setup } from './lifecycle';

/**
 * The ACSP half of the ACSP × PURL composition bridge, with the PURL side
 * reduced to what ACSP actually sees: opaque URLs and JSON text. ACSP never
 * dereferences a ref, so this scenario needs no PURL server — the URLs use
 * the reserved `.invalid` TLD and would fail if anything fetched them.
 *
 * Sequence (the same one the bridge's agents perform over HTTP):
 *   owner: create → task TOK (refs = operand URLs) → delegate A → handoff task to A
 *   A: acknowledge → inspect → finding (refs = result URL) → checkpoint → handoff to B
 *   owner: delegate B
 *   B: acknowledge → verify checkpoint hash → validation annotation → finding → checkpoint → handoff back
 *   owner: acknowledge
 */
const PURL = 'http://purl.invalid';
const TASK = {
  schema: 'purl.compute.task/0.1',
  purl_instance: `${PURL}/.well-known/purl`,
  inputs: { A: `${PURL}/r/r_000001`, B: `${PURL}/r/r_000002` },
  steps: [
    { id: 'C', operation: 'XOR', operands: ['A', 'B'] },
    { id: 'D', operation: 'XOR', operands: ['C', 'B'] },
  ],
};
const pin = (id: string, version: number) => ({ href: `${PURL}/r/${id}`, resource: id, version, state_hash: `sha256:${'ab'.repeat(32)}` });

export const computationEnvelope: Scenario = {
  name: 'computation-envelope',
  description: 'A PURL computation task moves owner → A → B → owner: refs stay opaque, checkpoints re-hash, responsibility and authority stay separate.',
  async run(w, t) {
    const owner = w.actor('owner', { session: 'session-owner', kind: 'human' });
    const a = w.actor('a', { session: 'session-a', agent: 'agent-a' });
    const b = w.actor('b', { session: 'session-b', agent: 'agent-b' });
    const rid = await setup(t, owner, 'Computational task: C = XOR(A, B), then D = XOR(C, B)');
    const scopes = ['append', 'annotate', 'checkpoint', 'handoff'];

    await t.step('owner publishes the task with PURL operand URLs as refs', async () => {
      const res = await owner.append(rid, {
        type: 'task',
        title: 'Evaluate the PURL computation steps',
        content: JSON.stringify(TASK),
        refs: [{ url: TASK.inputs.A }, { url: TASK.inputs.B }],
      });
      t.status(res, 200, 'append task TOK');
      const tok = (await owner.inspect(rid)).body.knowledge.items[0];
      t.eq(tok.refs, [{ url: TASK.inputs.A }, { url: TASK.inputs.B }], 'refs stored verbatim');
      t.eq(JSON.parse(tok.content), TASK, 'task specification stored as exact JSON text');
    });

    await t.step('owner delegates to A and hands the task to A', async () => {
      const d = await owner.delegate(rid, { to: { session_id: 'session-a', agent_id: 'agent-a' }, scopes, label: 'compute step C' });
      t.status(d, 200, 'delegate to session-a');
      a.receive(rid, d.body.result.capability.token);
      t.status(await owner.handoff(rid, { tok_id: 'TOK-001', to: { session_id: 'session-a' }, note: JSON.stringify({ perform: ['C'] }) }), 200, 'handoff TOK-001 → session-a');
      t.status(await a.acknowledge(rid, { handoff_id: 'HO-001', decision: 'accept' }), 200, 'A accepts');
    });

    await t.step('A discovers its authority and the task', async () => {
      const d = (await a.inspect(rid)).body;
      t.eq(d.viewer.session_id, 'session-a', 'viewer is session-a');
      t.eq(d.viewer.is_owner, false, 'A is not the owner');
      t.eq([...d.viewer.scopes].sort(), ['annotate', 'append', 'checkpoint', 'handoff', 'read'], 'A sees exactly its delegated scopes (+read)');
      t.eq(d.authority.task_responsibility[0].responsible_session_id, 'session-a', 'A is responsible for TOK-001');
      t.eq(d.ownership.owner.session_id, 'session-owner', 'owner unchanged');
    });

    let cpA = 0;
    await t.step('A records its result and checkpoints', async () => {
      const result = { schema: 'purl.compute.result/0.1', step: 'C', operation: 'XOR', value: '1', purl: pin('r_000003', 4) };
      const res = await a.append(rid, {
        type: 'finding',
        title: 'C = XOR(A, B) = 1',
        content: JSON.stringify(result),
        stated_confidence: 'high',
        refs: [{ url: result.purl.href }, { tok: 'TOK-001' }],
      });
      t.status(res, 200, 'append finding TOK-002');
      const cp = await a.checkpoint(rid, { label: 'after step C' });
      t.status(cp, 200, 'checkpoint');
      cpA = cp.body.result.checkpoint.number;
      const doc = (await a.getJson(`/r/${rid}/checkpoints/${cpA}`)).body.checkpoint;
      t.eq(canonicalHash(doc.snapshot), doc.sha256, 'checkpoint hash recomputes from the served snapshot');
      const finding = doc.snapshot.knowledge.find((k: any) => k.id === 'TOK-002');
      t.eq(JSON.parse(finding.content).purl, result.purl, 'the checkpoint commits to the PURL pin text');
    });

    await t.step('A hands the task to B; B needs its own capability to accept', async () => {
      t.status(await a.handoff(rid, { tok_id: 'TOK-001', to: { session_id: 'session-b' }, note: JSON.stringify({ perform: ['D'] }) }), 200, 'handoff → session-b');
      t.status(await b.acknowledge(rid, { handoff_id: 'HO-002', decision: 'accept' }), 401, 'B without a capability cannot accept', 'authentication_required');
      const d = await owner.delegate(rid, { to: { session_id: 'session-b', agent_id: 'agent-b' }, scopes, label: 'compute step D' });
      b.receive(rid, d.body.result.capability.token);
      t.status(await a.acknowledge(rid, { handoff_id: 'HO-002', decision: 'accept' }), 403, 'A cannot accept a handoff addressed to B', 'insufficient_authority');
      t.status(await b.acknowledge(rid, { handoff_id: 'HO-002', decision: 'accept' }), 200, 'B accepts');
      const d2 = (await b.inspect(rid)).body;
      t.eq(d2.authority.task_responsibility[0].responsible_session_id, 'session-b', 'B is now responsible');
      t.status(await a.handoff(rid, { tok_id: 'TOK-001', to: { session_id: 'session-owner' } }), 403, 'A is no longer responsible', 'insufficient_authority');
    });

    await t.step('B verifies, validates, continues', async () => {
      t.status(await b.append(rid, { type: 'finding', title: 'spoof' }, { actor: { session_id: 'session-a' } }), 403, 'B cannot act as session-a', 'session_mismatch');
      const doc = (await b.getJson(`/r/${rid}/checkpoints/${cpA}`, b.token(rid))).body.checkpoint;
      t.eq(canonicalHash(doc.snapshot), doc.sha256, 'B re-derives A\'s checkpoint hash');
      const ann = await b.annotate(rid, {
        tok_id: 'TOK-002',
        kind: 'validation',
        content: 'Re-evaluated from pinned operands.',
        evidence: { method: 'purl.compute/0.1 replay and re-evaluation', reference: `${PURL}/r/r_000003`, result: 'value 1 reproduced' },
      });
      t.status(ann, 200, 'validation annotation');
      const res = await b.append(rid, {
        type: 'finding',
        title: 'D = XOR(C, B) = 0',
        content: JSON.stringify({ schema: 'purl.compute.result/0.1', step: 'D', operation: 'XOR', value: '0', purl: pin('r_000004', 4) }),
        refs: [{ url: `${PURL}/r/r_000004` }, { tok: 'TOK-002' }],
      });
      t.status(res, 200, 'append finding TOK-003');
      t.status(await b.checkpoint(rid, { label: 'after step D' }), 200, 'checkpoint');
      t.status(await b.handoff(rid, { tok_id: 'TOK-001', to: { session_id: 'session-owner' }, note: 'steps C and D done' }), 200, 'hand back to owner');
      t.status(await owner.acknowledge(rid, { handoff_id: 'HO-003', decision: 'accept' }), 200, 'owner accepts');
    });

    await t.step('provenance keeps the sessions distinct', async () => {
      const d = (await owner.inspect(rid)).body;
      t.eq(d.ownership.owner.session_id, 'session-owner', 'ownership never moved');
      const items = d.knowledge.items;
      t.eq(items.map((k: any) => [k.id, k.source.session_id, k.source.identity_assurance]), [
        ['TOK-001', 'session-owner', 'capability'],
        ['TOK-002', 'session-a', 'capability'],
        ['TOK-003', 'session-b', 'capability'],
      ], 'each TOK attributed to its own session');
      const v = items[1].annotations[0];
      t.eq([v.kind, v.source.session_id, v.source.identity_assurance], ['validation', 'session-b', 'capability'], 'validation attributed to B');
      const events = (await owner.getJson(`/r/${rid}/events`)).body.events;
      const byB = events.filter((e: any) => e.actor.session_id === 'session-b');
      t.check(byB.length >= 5 && byB.every((e: any) => e.identity_assurance === 'capability'), `all ${byB.length} events by B carry capability assurance`);
      t.eq(items[0].refs, [{ url: TASK.inputs.A }, { url: TASK.inputs.B }], 'operand URLs unchanged at the end');
    });
  },
};
