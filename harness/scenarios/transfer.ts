import type { Scenario } from '../scenario';
import { setup } from './lifecycle';

export const handoff: Scenario = {
  name: 'handoff',
  description: 'Task handoff is two-phase and moves responsibility only — never ownership or authority.',
  async run(w, t) {
    const a = w.actor('a', { session: 'session-a' });
    const b = w.actor('b', { session: 'session-b' });
    const c = w.actor('c', { session: 'session-c' });
    const rid = await setup(t, a, 'Handoff');
    await a.append(rid, { type: 'task', title: 'Profile the allocator' });
    await a.append(rid, { type: 'finding', title: 'Not a task' });

    await t.step('invalid handoffs are refused', async () => {
      t.status(await a.handoff(rid, { tok_id: 'TOK-002', to: { session_id: 'session-b' } }), 409, 'handoff a non-task', 'invalid_state');
      t.status(await a.handoff(rid, { tok_id: 'TOK-001', to: { session_id: 'session-a' } }), 409, 'handoff to current holder', 'invalid_state');
      t.status(await a.handoff(rid, { tok_id: 'TOK-099', to: { session_id: 'session-b' } }), 404, 'handoff unknown TOK', 'not_found');
    });

    await t.step('A offers the task to B; responsibility does not move yet', async () => {
      const res = await a.handoff(rid, { tok_id: 'TOK-001', to: { session_id: 'session-b' }, note: 'You have the profiler set up.' });
      t.status(res, 200, 'handoff');
      t.eq(res.body.result.handoff.status, 'pending', 'pending');
      const d = (await a.inspect(rid)).body;
      t.eq(d.authority.task_responsibility[0].responsible_session_id, 'session-a', 'still session-a until acknowledged');
      t.eq(d.authority.task_responsibility[0].pending_handoff, 'HO-001', 'pending handoff visible');
      t.status(await a.handoff(rid, { tok_id: 'TOK-001', to: { session_id: 'session-c' } }), 409, 'second concurrent handoff', 'invalid_state');
    });

    await t.step('handoff grants no authority; B needs a capability bound to session-b', async () => {
      t.status(await b.acknowledge(rid, { handoff_id: 'HO-001', decision: 'accept' }), 401, 'B acknowledges with no capability', 'authentication_required');
      const cc = await a.delegate(rid, { to: { session_id: 'session-c' }, scopes: ['read'] });
      c.receive(rid, cc.body.result.capability.token);
      t.status(await c.acknowledge(rid, { handoff_id: 'HO-001', decision: 'accept' }), 403, 'wrong session (C) acknowledges', 'insufficient_authority');
      const bc = await a.delegate(rid, { to: { session_id: 'session-b' }, scopes: ['read', 'handoff'] });
      b.receive(rid, bc.body.result.capability.token);
      const d = (await b.inspect(rid)).body;
      t.eq(d.operations.find((o: any) => o.name === 'acknowledge').permitted_for_viewer, true, 'B sees it may acknowledge');
      t.check(d.next_valid_actions.some((n: any) => n.action === 'acknowledge'), 'acknowledge suggested to B');
    });

    await t.step('B accepts: responsibility moves; ownership does not', async () => {
      const res = await b.acknowledge(rid, { handoff_id: 'HO-001', decision: 'accept', note: 'On it.' });
      t.status(res, 200, 'acknowledge accept');
      t.eq(res.body.result.handoff.status, 'accepted', 'accepted');
      const d = (await b.inspect(rid)).body;
      t.eq(d.authority.task_responsibility[0].responsible_session_id, 'session-b', 'B now responsible for the task');
      t.eq(d.ownership.owner.session_id, 'session-a', 'A still owns the resource');
      t.eq(d.viewer.scopes.includes('append'), false, 'B gained no append authority from the handoff');
      t.status(await b.acknowledge(rid, { handoff_id: 'HO-001', decision: 'accept' }), 409, 'acknowledge twice', 'invalid_state');
    });

    await t.step('the responsible session (with handoff scope) may hand the task on; others may not', async () => {
      const res = await b.handoff(rid, { tok_id: 'TOK-001', to: { session_id: 'session-c' } });
      t.status(res, 200, 'B (responsible) hands off to C');
      const decl = await c.acknowledge(rid, { handoff_id: 'HO-002', decision: 'decline', note: 'No capacity.' });
      t.status(decl, 200, 'C declines');
      const d = (await a.inspect(rid)).body;
      t.eq(d.authority.task_responsibility[0].responsible_session_id, 'session-b', 'declined: B remains responsible');
    });
  },
};

export const proposals: Scenario = {
  name: 'proposals',
  description: 'Propose without authority; owner accepts or rejects; proposed vs performed stays distinct.',
  async run(w, t) {
    const a = w.actor('a', { session: 'session-a' });
    const p = w.actor('p', { session: 'session-p', agent: 'gpt-browser' });
    const rid = await setup(t, a, 'Proposals');
    await a.append(rid, { type: 'hypothesis', title: 'H1' });

    await t.step('invalid proposals are refused up front', async () => {
      t.status(await p.propose(rid, { operation: 'append', payload: { type: 'nonsense', title: 'x' } }), 422, 'inner payload invalid', 'invalid_payload');
      t.status(await p.propose(rid, { operation: 'delegate', payload: {} }), 422, 'non-proposable operation', 'invalid_payload');
    });

    await t.step('propose append, annotate, supersede', async () => {
      t.status(await p.propose(rid, { operation: 'append', payload: { type: 'observation', title: 'Seen in prod' } }), 200, 'P-001 append');
      t.status(await p.propose(rid, { operation: 'annotate', payload: { tok_id: 'TOK-001', kind: 'dispute', content: 'Counter-example exists.' } }), 200, 'P-002 annotate');
      t.status(await p.propose(rid, { operation: 'supersede', payload: { target: 'TOK-001', reason: 'refined', replacement: { type: 'hypothesis', title: 'H1′' } } }), 200, 'P-003 supersede');
      const d = (await p.inspect(rid)).body;
      t.eq(d.proposals.map((x: any) => [x.id, x.status, x.type]), [['P-001', 'pending', 'operation_intent'], ['P-002', 'pending', 'operation_intent'], ['P-003', 'pending', 'operation_intent']], 'three pending operation intents');
      t.eq(d.knowledge.items.length, 1, 'nothing performed yet');
    });

    await t.step('only the owner resolves; expected_version required', async () => {
      t.status(await p.resolveProposal(rid, { proposal_id: 'P-001', decision: 'accept' }, { expected_version: 1 }), 401, 'proposer resolves', 'authentication_required');
      t.status(await a.resolveProposal(rid, { proposal_id: 'P-001', decision: 'accept' }), 400, 'resolve without expected_version', 'missing_expected_version');
    });

    await t.step('accept, accept, reject', async () => {
      let v = await a.version(rid);
      const r1 = await a.resolveProposal(rid, { proposal_id: 'P-001', decision: 'accept' }, { expected_version: v });
      t.status(r1, 200, 'accept P-001');
      t.eq(r1.body.result.executed.tok.source.session_id, 'session-p', 'TOK authored by proposer');
      t.eq(r1.body.result.executed.tok.proposal_id, 'P-001', 'TOK links its proposal');
      v = r1.body.version;
      const r2 = await a.resolveProposal(rid, { proposal_id: 'P-002', decision: 'accept' }, { expected_version: v });
      t.eq(r2.body.result.executed.annotation.source.session_id, 'session-p', 'annotation authored by proposer');
      v = r2.body.version;
      const r3 = await a.resolveProposal(rid, { proposal_id: 'P-003', decision: 'reject', note: 'Premature.' }, { expected_version: v });
      t.status(r3, 200, 'reject P-003');
      t.eq(r3.body.events.length, 1, 'rejection emits one event, executes nothing');
      t.eq((await a.inspect(rid)).body.knowledge.items.find((k: any) => k.id === 'TOK-001').status, 'active', 'rejected supersession did not happen');
      t.status(await a.resolveProposal(rid, { proposal_id: 'P-003', decision: 'accept' }, { expected_version: r3.body.version }), 409, 're-resolve', 'invalid_state');
    });

    await t.step('owner can close proposals', async () => {
      const v = await a.version(rid);
      await a.update(rid, { accepts_proposals: false }, { expected_version: v });
      t.status(await p.propose(rid, { operation: 'append', payload: { type: 'question', title: 'x' } }), 403, 'propose when closed to proposals', 'proposals_closed');
    });
  },
};
