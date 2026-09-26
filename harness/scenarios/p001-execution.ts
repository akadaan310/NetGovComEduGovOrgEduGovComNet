/**
 * Program 001 — executions, authority/security, GET-safety, proposals,
 * discover-new-operation, provenance.
 */
import { canonicalHash } from '../../src/continuity/canonical';
import type { Scenario } from '../scenario';
import { authorize, createIdentity, embodied, execution, MULTIPLY } from './p001-common';

const DIVIDE = { purpose: 'divide a by b', inputs: ['a', 'b'], operations: [{ id: 'q', operation: 'divide', arguments: ['a', 'b'] }] };

export const p001Executions: Scenario = {
  name: 'p001-executions',
  program: '001',
  description: 'Executions: record contents, determinism, recorded failures, replay, duplicate and invalid executions, composition, history.',
  async run(w, t) {
    const f = await createIdentity(w, t);
    const { rid } = f;
    const a = w.actor('a', { session: 'session-a', agent: 'claude' });
    const { embodimentId } = await embodied(t, f, a, { provider: 'anthropic', model_id: 'model-1' });
    await a.createScroll(rid, MULTIPLY);
    await a.createScroll(rid, DIVIDE);
    await a.createScroll(rid, { purpose: 'square', inputs: ['x'], operations: [{ id: 'sq', scroll: { scroll_id: 'SCR-001', version: 1 }, arguments: ['x', 'x'] }] });

    let first: any;
    await t.step('an execution record carries every dimension', async () => {
      const r = await a.execute(rid, { target: { scroll_id: 'SCR-001', version: 1 }, inputs: { a: 6, b: 7 } }, { key: 'exec-key-000001' });
      t.status(r, 200, 'execute SCR-001:v1 on {a:6,b:7}');
      first = execution(r);
      t.eq([first.execution_id, first.kind, first.status, first.outputs], ['EXE-001', 'scroll', 'completed', { s1: 42 }], 'EXE-001 completed with 42');
      t.eq(first.identity, rid, 'identity');
      t.eq([first.session.session_id, first.session.identity_assurance], ['session-a', 'capability'], 'session and assurance');
      t.eq([first.embodiment_id, first.model], [embodimentId, { provider: 'anthropic', model_id: 'model-1' }], 'embodiment and declared model');
      t.eq(first.scroll.ref, 'SCR-001:v1', 'explicit Scroll version');
      t.check(/^sha256:/.test(first.scroll.content_sha256), 'Scroll content hash recorded');
      t.eq(first.substrates_used.map((s: any) => s.substrate_id), ['deterministic-calculator'], 'substrate recorded with version and manifest hash');
      t.eq(first.operation_sequence, [{ path: 's1', substrate: first.substrates_used[0], operation: 'multiply', arguments: [6, 7], result: 42 }], 'operation sequence');
      t.check(first.started_at && first.completed_at && first.parent_checkpoint === 0 && first.event_version > 0, 'times, parent checkpoint, event version');
      const scroll = (await a.getJson(`/r/${rid}/scrolls/SCR-001?version=1`)).body.scroll;
      t.check(!('outputs' in scroll) && !('status' in scroll), 'the Scroll definition holds no results (definition ≠ execution ≠ result)');
    });

    await t.step('replay and duplicates', async () => {
      const again = await a.execute(rid, { target: { scroll_id: 'SCR-001', version: 1 }, inputs: { a: 6, b: 7 } }, { key: 'exec-key-000001' });
      t.eq([again.body.replayed, execution(again).execution_id], [true, 'EXE-001'], 'same key: replay of EXE-001');
      t.eq((await a.getJson(`/r/${rid}/executions`)).body.count, 1, 'no duplicate record');
      t.status(await a.execute(rid, { target: { scroll_id: 'SCR-001', version: 1 }, inputs: { a: 6, b: 8 } }, { key: 'exec-key-000001' }), 422, 'same key, different inputs', 'idempotency_key_reuse');
      const dup = await a.execute(rid, { target: { scroll_id: 'SCR-001', version: 1 }, inputs: { a: 6, b: 7 } });
      t.eq(execution(dup).execution_id, 'EXE-002', 'new key: a deliberate second execution is a new record');
      t.eq([execution(dup).outputs, execution(dup).operation_sequence], [first.outputs, first.operation_sequence], 'deterministic: identical outputs and step sequence');
      const tr = (await a.getJson(`/r/${rid}/transitions`)).body.transitions.filter((x: any) => x.operation === 'execute');
      t.eq(tr[1].observations, ['EXECUTION', 'REUSE', 'OPERATION_REPEATED'], 'observed as reuse with repeated inputs');
    });

    await t.step('invalid executions are refused and record nothing', async () => {
      const count = (await a.getJson(`/r/${rid}/executions`)).body.count;
      t.status(await a.execute(rid, { target: { scroll_id: 'SCR-001', version: 1 }, inputs: { a: 6 } }), 422, 'missing input', 'invalid_payload');
      t.status(await a.execute(rid, { target: { scroll_id: 'SCR-001', version: 1 }, inputs: { a: 6, b: 7, c: 1 } }), 422, 'extra input', 'invalid_payload');
      t.status(await a.execute(rid, { target: { scroll_id: 'SCR-001', version: 1 }, inputs: { a: 'six', b: 7 } }), 422, 'non-numeric input', 'invalid_payload');
      t.status(await a.execute(rid, { target: { scroll_id: 'SCR-001', version: 9 }, inputs: {} }), 404, 'nonexistent version', 'not_found');
      t.status(await a.execute(rid, { target: { alias: 'nothing' }, inputs: {} }), 404, 'nonexistent alias', 'not_found');
      t.status(await a.execute(rid, { target: { scroll_id: 'SCR-001' }, inputs: {} }), 422, 'target without a version (no implicit "latest")', 'invalid_payload');
      t.eq((await a.getJson(`/r/${rid}/executions`)).body.count, count, 'no records created');
    });

    await t.step('computational failures are recorded, not hidden', async () => {
      const r = await a.execute(rid, { target: { scroll_id: 'SCR-002', version: 1 }, inputs: { a: 1, b: 0 } });
      t.status(r, 200, 'the operation (recording) succeeds');
      t.eq([execution(r).status, execution(r).error.code, execution(r).outputs], ['failed', 'division_by_zero', null], 'the computation failed: division_by_zero');
      const ok = await a.execute(rid, { target: { scroll_id: 'SCR-002', version: 1 }, inputs: { a: 1, b: 4 } });
      t.eq(execution(ok).outputs, { q: 0.25 }, 'retry with other inputs completes');
      const tr = (await a.getJson(`/r/${rid}/transitions`)).body.transitions.filter((x: any) => x.operation === 'execute').slice(-2);
      t.eq(tr.map((x: any) => x.observations), [['EXECUTION', 'EXECUTION_FAILED'], ['EXECUTION', 'REUSE', 'RETRY']], 'observed as failure then retry');
    });

    await t.step('composition and substrate override', async () => {
      const r = await a.execute(rid, { target: { scroll_id: 'SCR-003', version: 1 }, inputs: { x: 12 } });
      t.eq(execution(r).outputs, { sq: 144 }, 'square(12) = 144 via SCR-001:v1');
      t.eq(execution(r).operation_sequence.map((s: any) => s.path), ['sq/s1', 'sq'], 'nested step path recorded');
      const q = await a.execute(rid, { target: { scroll_id: 'SCR-002', version: 1 }, inputs: { a: 1, b: 3 }, substrate_id: 'exact-rational-calculator' });
      t.eq([execution(q).outputs, execution(q).default_substrate.substrate_id], [{ q: '1/3' }, 'exact-rational-calculator'], 'same Scroll, exact substrate: 1/3');
      const qf = await a.execute(rid, { target: { scroll_id: 'SCR-002', version: 1 }, inputs: { a: 1, b: 3 } });
      t.eq(execution(qf).outputs, { q: 1 / 3 }, 'binary64 substrate: 0.333…');
      t.eq((await a.inspect(rid)).body.identity.current_substrate.substrate_id, 'deterministic-calculator', 'a per-execution override does not change the current substrate');
    });

    await t.step('history: list, page, retrieve; append-only', async () => {
      const all = (await a.getJson(`/r/${rid}/executions`)).body;
      t.eq(all.executions.map((x: any) => x.execution_id), all.executions.map((_: any, i: number) => `EXE-${String(i + 1).padStart(3, '0')}`), 'ordered, gapless ids');
      const page = (await a.getJson(`/r/${rid}/executions?after=1&limit=2`)).body;
      t.eq([page.executions.map((x: any) => x.execution_id), !!page.next], [['EXE-002', 'EXE-003'], true], 'pagination');
      t.eq((await a.getJson(`/r/${rid}/executions/EXE-001`)).body.execution.outputs, { s1: 42 }, 'retrieve one');
      if (w.env) {
        let refused = false;
        try {
          await w.env.db.query(`update executions set outputs = '{"s1":0}' where resource_id = $1`, [rid]);
        } catch {
          refused = true;
        }
        t.check(refused, 'the database refuses UPDATE on execution records');
      }
    });
  },
};

export const p001Authority: Scenario = {
  name: 'p001-authority',
  program: '001',
  description: 'Security: spoofing, forged/expired/revoked/cross-resource capabilities, wrong scope, unauthorized Scroll/alias/checkpoint, authority does not leak across sessions.',
  needsClock: true,
  async run(w, t) {
    const f = await createIdentity(w, t, 'Agent X');
    const g = await createIdentity(w, t, 'Agent Y', {}, f.principal);
    const a = w.actor('a', { session: 'session-a' });
    const { capId } = await embodied(t, f, a, null);
    await a.createScroll(f.rid, MULTIPLY);
    const mallory = w.actor('mallory', { session: 'session-m', agent: 'agent-001' });

    await t.step('identity assertion is not authority', async () => {
      t.status(await mallory.execute(f.rid, { target: { scroll_id: 'SCR-001', version: 1 }, inputs: { a: 1, b: 2 } }), 401, 'claiming agent_id "agent-001" without a capability', 'authentication_required');
      t.status(await mallory.execute(f.rid, { target: { scroll_id: 'SCR-001', version: 1 }, inputs: { a: 1, b: 2 } }, { actor: { session_id: 'session-a', agent_id: 'agent-001' } }), 401, 'claiming session-a without a capability', 'authentication_required');
      t.status(await mallory.createScroll(f.rid, MULTIPLY), 401, 'unauthorized Scroll creation', 'authentication_required');
      t.status(await mallory.checkpoint(f.rid, { label: 'x' }), 401, 'unauthorized checkpoint', 'authentication_required');
      t.status(await mallory.embody(f.rid), 401, 'unauthorized embodiment', 'authentication_required');
    });

    await t.step('forged, cross-resource and wrong-scope capabilities', async () => {
      const tok = a.token(f.rid)!;
      t.status(await mallory.execute(f.rid, { target: { scroll_id: 'SCR-001', version: 1 }, inputs: { a: 1, b: 2 } }, { token: tok.slice(0, -4) + 'AAAA' }), 401, 'forged secret', 'invalid_capability');
      t.status(await a.execute(g.rid, { target: { scroll_id: 'SCR-001', version: 1 }, inputs: { a: 1, b: 2 } }, { token: tok }), 403, 'capability for identity X used on identity Y', 'capability_resource_mismatch');
      t.status(await a.execute(f.rid, { target: { scroll_id: 'SCR-001', version: 1 }, inputs: { a: 1, b: 2 } }, { actor: { session_id: 'session-z' } }), 403, 'capability used to claim another session', 'session_mismatch');
      const r = w.actor('reader', { session: 'session-r' });
      await authorize(t, f, r, ['read']);
      t.status(await r.embody(f.rid), 403, 'read-only capability cannot embody', 'insufficient_authority');
      const s = w.actor('scroller', { session: 'session-s' });
      await authorize(t, f, s, ['embody', 'scroll']);
      t.status(await s.checkpoint(f.rid, { label: 'x' }), 403, 'no checkpoint scope', 'insufficient_authority');
      t.status(await s.delegate(f.rid, { to: { session_id: 'x' }, scopes: ['execute'] }), 403, 'delegates cannot delegate', 'insufficient_authority');
      t.status(await s.setAlias(f.rid, { name: 'm', target: { scroll_id: 'SCR-001', version: 1 } }, { expected_version: await a.version(f.rid) }), 403, 'no alias scope', 'insufficient_authority');
    });

    await t.step('authority does not leak across sessions', async () => {
      const b = w.actor('b', { session: 'session-b' });
      await authorize(t, f, b);
      t.status(await a.release(f.rid, { embodiment_id: 'EMB-001', reason: 'session ends' }), 200, 'A releases');
      t.status(await b.embody(f.rid), 200, 'B embodies with its own capability');
      t.status(await a.execute(f.rid, { target: { scroll_id: 'SCR-001', version: 1 }, inputs: { a: 1, b: 2 } }), 403, 'A still holds an unrevoked capability but is no longer the embodiment', 'not_embodied');
      t.status(await f.principal.revoke(f.rid, { capability_id: capId, reason: 'session A terminated' }), 200, 'principal revokes A');
      t.status(await a.execute(f.rid, { target: { scroll_id: 'SCR-001', version: 1 }, inputs: { a: 1, b: 2 } }), 401, 'A after revocation', 'capability_revoked');
      t.status(await a.embody(f.rid), 401, 'A cannot re-embody after revocation', 'capability_revoked');
      t.status(await b.execute(f.rid, { target: { scroll_id: 'SCR-001', version: 1 }, inputs: { a: 1, b: 2 } }), 200, 'B is authorized');
    });

    await t.step('stale capability: expiry', async () => {
      const c = w.actor('c', { session: 'session-c' });
      await authorize(t, f, c, ['execute'], 60);
      w.clock!.advance(61_000);
      t.status(await c.execute(f.rid, { target: { scroll_id: 'SCR-001', version: 1 }, inputs: { a: 1, b: 2 } }), 401, 'expired capability', 'capability_expired');
    });

    await t.step('refused attempts left no trace in the trajectory', async () => {
      const ex = (await a.getJson(`/r/${f.rid}/executions`)).body.executions;
      t.eq(ex.map((x: any) => x.session.session_id), ['session-b'], 'the only execution is B\'s');
      const events = (await a.getJson(`/r/${f.rid}/events`)).body.events;
      t.check(events.every((e: any) => e.actor.session_id !== 'session-m'), 'mallory appears nowhere in the history');
    });
  },
};

export const p001GetSafety: Scenario = {
  name: 'p001-get-safety',
  program: '001',
  description: 'Every Program 001 GET — identity, substrates, Scrolls, aliases, executions, transitions, prepare intents — changes nothing.',
  async run(w, t) {
    const f = await createIdentity(w, t);
    const { rid } = f;
    const a = w.actor('a', { session: 'session-a' });
    await embodied(t, f, a, null);
    await a.createScroll(rid, MULTIPLY);
    await a.setAlias(rid, { name: 'multiply', target: { scroll_id: 'SCR-001', version: 1 } }, { expected_version: await a.version(rid) });
    await a.execute(rid, { target: { alias: 'multiply' }, inputs: { a: 2, b: 3 } });
    const tok = a.token(rid)!;
    const before = (await a.inspect(rid)).body;
    const crawler = w.actor('crawler', { session: 'crawler' });
    const ops = ['embody', 'release', 'set_substrate', 'announce', 'create_scroll', 'version_scroll', 'set_alias', 'execute', 'discover_new_operation'];
    const urls = [
      `/r/${rid}`, `/r/${rid}/identity`, `/r/${rid}/substrates`, `/r/${rid}/scrolls`, `/r/${rid}/scrolls/SCR-001`, `/r/${rid}/scrolls/SCR-001?version=1`,
      `/r/${rid}/aliases`, `/r/${rid}/aliases/multiply`, `/r/${rid}/executions`, `/r/${rid}/executions/EXE-001`, `/r/${rid}/transitions`,
      `/r/${rid}?action=identity`, `/r/${rid}?action=scrolls`, `/r/${rid}?action=executions`, '/substrates', '/substrates/deterministic-calculator',
      ...ops.map((op) => `/r/${rid}?action=prepare_${op}&session_id=crawler`),
      `/r/${rid}?action=prepare_execute&alias=multiply&payload=${encodeURIComponent(JSON.stringify({ inputs: { a: 5, b: 5 } }))}`,
      `/r/${rid}?action=prepare_execute&alias=multiply&cap=${tok}`,
      `/r/${rid}?action=prepare_propose&proposed_operation=execute&alias=multiply`,
      '/new?kind=agent_identity&title=x',
    ];
    await t.step(`a crawler opens ${urls.length} URLs (HTML, JSON, HEAD)`, async () => {
      for (const u of urls) {
        const html = await crawler.openHtml(u);
        const json = await crawler.getJson(u);
        const head = await w.client.request('HEAD', u);
        t.check(html.status === 200 && json.status === 200 && head.status === 200, `GET ${u.replace(/cap=[^&]+/, 'cap=…')} → 200`);
      }
    });
    await t.step('nothing changed', async () => {
      const after = (await a.inspect(rid)).body;
      t.eq(after.state.version, before.state.version, 'version unchanged');
      t.eq([after.executions.count, after.scrolls.version_count, after.aliases.items.length], [1, 1, 1], 'no execution, Scroll or alias created');
      t.eq(after.identity.current_embodiment.id, before.identity.current_embodiment.id, 'embodiment unchanged');
      t.eq(after.identity.current_substrate, before.identity.current_substrate, 'substrate unchanged');
      const prep = (await crawler.getJson(`/r/${rid}?action=prepare_execute&alias=multiply`)).body;
      t.check(prep.status.startsWith('prepared — NOT executed'), 'a prepared execution says it was not executed');
    });
  },
};

export const p001Proposals: Scenario = {
  name: 'p001-proposals',
  program: '001',
  description: 'Propose ≠ commit: a session without authority proposes execute/create_scroll; only the principal\'s acceptance commits; concurrent resolution.',
  async run(w, t) {
    const f = await createIdentity(w, t);
    const { rid, principal } = f;
    const a = w.actor('a', { session: 'session-a' });
    await embodied(t, f, a, null);
    await a.createScroll(rid, MULTIPLY);
    const outsider = w.actor('outsider', { session: 'session-o', agent: 'small-model' });

    await t.step('propose without authority: nothing is committed', async () => {
      const p = await outsider.propose(rid, { operation: 'execute', payload: { target: { scroll_id: 'SCR-001', version: 1 }, inputs: { a: 3, b: 4 } }, rationale: 'check 3×4' });
      t.status(p, 200, 'outsider proposes execute (identity asserted)');
      t.eq([p.body.result.proposal.status, p.body.result.notice], ['pending', 'Proposed, not performed. The owner decides whether to execute it.'], 'pending, explicitly not performed');
      t.eq((await a.getJson(`/r/${rid}/executions`)).body.count, 0, 'no execution exists');
      t.status(await outsider.propose(rid, { operation: 'execute', payload: { target: { scroll_id: 'SCR-001', version: 1 } , inputs: 'x' } }), 422, 'the inner payload is validated at proposal time', 'invalid_payload');
      t.status(await outsider.propose(rid, { operation: 'create_scroll', payload: { scroll: { purpose: 'x', operations: [] } } }), 422, 'malformed proposed Scroll', 'invalid_payload');
    });

    await t.step('the principal accepts: committed with provenance kept apart', async () => {
      const r = await principal.resolveProposal(rid, { proposal_id: 'P-001', decision: 'accept' }, { expected_version: await principal.version(rid) });
      t.status(r, 200, 'principal accepts P-001');
      const x = r.body.result.executed.execution;
      t.eq([x.status, x.outputs, x.session.session_id, x.embodiment_id, x.on_behalf_of.session_id, x.proposal_id], ['completed', { s1: 12 }, 'principal-alice', null, 'session-o', 'P-001'], 'executed by the principal on behalf of the proposer, not by an embodiment');
      t.eq(r.body.events.map((e: any) => e.operation), ['resolve_proposal', 'execute'], 'two events');
    });

    await t.step('a proposed Scroll keeps the proposer as author', async () => {
      await outsider.propose(rid, { operation: 'create_scroll', payload: { scroll: { purpose: 'add', inputs: ['a', 'b'], operations: [{ operation: 'add', arguments: ['a', 'b'] }] } } });
      const r = await principal.resolveProposal(rid, { proposal_id: 'P-002', decision: 'accept' }, { expected_version: await principal.version(rid) });
      const s = r.body.result.executed.scroll;
      t.eq([s.scroll_id, s.created_by.session_id, s.recorded_by.session_id, s.proposal_id], ['SCR-002', 'session-o', 'principal-alice', 'P-002'], 'source = proposer, recorded_by = principal');
    });

    await t.step('concurrent resolution of one proposal: exactly one wins', async () => {
      await outsider.propose(rid, { operation: 'execute', payload: { target: { scroll_id: 'SCR-001', version: 1 }, inputs: { a: 1, b: 1 } } });
      const v = await principal.version(rid);
      const rs = await Promise.all(Array.from({ length: 4 }, () => principal.resolveProposal(rid, { proposal_id: 'P-003', decision: 'accept' }, { expected_version: v })));
      t.eq(rs.filter((r) => r.status === 200).length, 1, 'one acceptance');
      t.eq((await a.getJson(`/r/${rid}/executions`)).body.count, 2, 'one execution resulted');
    });

    await t.step('proposals must fit the resource kind', async () => {
      const cid = (await principal.create({ title: 'Plain' })).body.resource_id;
      t.status(await outsider.propose(cid, { operation: 'create_scroll', payload: { scroll: MULTIPLY } }), 422, 'create_scroll proposed on a plain resource', 'invalid_payload');
    });
  },
};

export const p001Discover: Scenario = {
  name: 'p001-discover',
  program: '001',
  description: 'discover-new-operation: inspect substrates and schemas, compose a candidate, test it, record the observation, optionally propose; persistence still needs authority.',
  async run(w, t) {
    const f = await createIdentity(w, t);
    const { rid, principal } = f;
    const a = w.actor('a', { session: 'session-a' });
    await embodied(t, f, a, null);
    await a.createScroll(rid, MULTIPLY);

    let candidate: any;
    await t.step('compose a candidate only from discovered contracts', async () => {
      const reg = (await a.getJson((await a.inspect(rid)).body.links.substrate_registry)).body;
      const calc = reg.substrates.find((s: any) => s.substrate_id === (reg.substrates.find((x: any) => x.status === 'available')).substrate_id);
      const ops = new Map<string, any>(calc.operations.map((o: any) => [o.name, o]));
      t.check(ops.get('multiply')?.arity === 2 && ops.get('add')?.arity === 2, 'multiply and add discovered with arity 2');
      // f(x, y) = x·x + y, reusing the identity's own SCR-001 for the product.
      candidate = {
        purpose: 'square x, then add y',
        inputs: ['x', 'y'],
        operations: [
          { id: 'sq', scroll: { scroll_id: 'SCR-001', version: 1 }, arguments: ['x', 'x'] },
          { id: 'sum', operation: 'add', arguments: ['sq', 'y'] },
        ],
      };
    });

    await t.step('test the candidate: trials are recorded, no Scroll is created', async () => {
      const r = await a.discover(rid, { candidate, trials: [{ inputs: { x: 3, y: 1 } }, { inputs: { x: -2, y: 0.5 } }] });
      t.status(r, 200, 'discover_new_operation');
      t.eq(r.body.result.trials.map((x: any) => [x.kind, x.status, x.outputs]), [['trial', 'completed', { sum: 10 }], ['trial', 'completed', { sum: 4.5 }]], 'two trial executions');
      t.eq(r.body.result.candidate_sha256, canonicalHash(r.body.result.candidate), 'candidate hash is recomputable');
      t.eq(r.body.result.proposal, null, 'nothing proposed');
      t.eq((await a.getJson(`/r/${rid}/scrolls`)).body.scrolls.length, 1, 'still one Scroll');
      const tr = (await a.getJson(`/r/${rid}/transitions`)).body.transitions.at(-1);
      t.eq(tr.observations, ['DISCOVERY_TRIAL', 'OPERATION_SELECTED', 'OPERATION_ORDERED', 'COMPOSITION'], 'observed as a trial of an ordered composition');
      t.status(await a.discover(rid, { candidate: { ...candidate, operations: [{ operation: 'teleport', arguments: ['x', 'y'] }] }, trials: [{ inputs: { x: 1, y: 1 } }] }), 422, 'invalid candidate', 'invalid_payload');
      t.status(await a.discover(rid, { candidate, trials: [{ inputs: { x: 1 } }] }), 422, 'trial inputs must match', 'invalid_payload');
    });

    await t.step('propose the candidate; the principal decides persistence', async () => {
      const r = await a.discover(rid, { candidate, trials: [{ inputs: { x: 5, y: 0 } }], propose: true, rationale: 'recurring pattern' });
      t.eq([r.body.result.proposal?.id, r.body.result.proposal?.operation, r.body.events.map((e: any) => e.operation)], ['P-001', 'create_scroll', ['discover_new_operation', 'propose']], 'observation, then a pending proposal');
      t.eq((await a.getJson(`/r/${rid}/scrolls`)).body.scrolls.length, 1, 'a proposal is not a Scroll');
      const acc = await principal.resolveProposal(rid, { proposal_id: 'P-001', decision: 'accept' }, { expected_version: await principal.version(rid) });
      t.eq(acc.body.result.executed.scroll.ref, 'SCR-002:v1', 'accepted → SCR-002 committed');
      const b = w.actor('b', { session: 'session-b' });
      await authorize(t, f, b, ['execute']);
      t.status(await b.discover(rid, { candidate, trials: [{ inputs: { x: 1, y: 1 } }] }), 403, 'not the embodiment', 'not_embodied');
    });
  },
};

export const p001Provenance: Scenario = {
  name: 'p001-provenance',
  program: '001',
  description: 'Every transition is attributable; the transition export is contiguous and deterministic; tampering with a snapshot or history is detected or refused.',
  needsDatabase: true,
  async run(w, t) {
    const f = await createIdentity(w, t);
    const { rid } = f;
    const a = w.actor('a', { session: 'session-a' });
    await embodied(t, f, a, { provider: 'p', model_id: 'm' });
    await a.createScroll(rid, MULTIPLY);
    await a.announce(rid, { kind: 'artifact', statement: 'SCR-001 multiplies', refs: [{ scroll: { scroll_id: 'SCR-001', version: 1 } }] });
    await a.execute(rid, { target: { scroll_id: 'SCR-001', version: 1 }, inputs: { a: 2, b: 2 } });
    await a.checkpoint(rid, { label: 'c1' });

    await t.step('transition export', async () => {
      const x1 = (await a.getJson(`/r/${rid}/transitions`)).body;
      const x2 = (await a.getJson(`/r/${rid}/transitions`)).body;
      t.eq(x1.format, 'acsp-transition-history/1', 'format');
      t.eq(x1.transitions.map((x: any) => x.t), Array.from({ length: x1.transition_count }, (_, i) => i + 1), 'logical time is contiguous 1..n');
      t.check(x1.transitions.every((x: any) => x.from_version === x.t - 1 && x.actor.session_id && x.identity_assurance), 'every transition has a parent version, an actor and an assurance level');
      t.eq(x1.deterministic_sha256, x2.deterministic_sha256, 'deterministic hash is stable across reads');
      const { occurred_at: _o, ...rest } = x1.transitions[0];
      t.check(!('occurred_at' in rest), 'wall-clock time is separable from the deterministic part');
      const ex = x1.transitions.find((x: any) => x.operation === 'execute');
      t.eq([ex.embodiment.session_id, ex.substrate_after, ex.scroll, ex.execution.status], ['session-a', 'deterministic-calculator', 'SCR-001:v1', 'completed'], 'execution transition carries embodiment, substrate, Scroll and outcome');
      t.check(x1.transitions.find((x: any) => x.operation === 'announce').observations.includes('ANNOUNCEMENT'), 'announcement observed');
      const doc = (await a.inspect(rid)).body;
      t.eq(doc.announcements[0].statement, 'SCR-001 multiplies', 'announcement listed on the identity');
    });

    await t.step('snapshot verification detects tampering', async () => {
      const cp = (await a.getJson(`/r/${rid}/checkpoints/1`)).body.checkpoint;
      t.eq(canonicalHash(cp.snapshot), cp.sha256, 'client recomputes the checkpoint hash');
      const forged = structuredClone(cp.snapshot);
      forged.executions[0].outputs = { s1: 5 };
      t.check(canonicalHash(forged) !== cp.sha256, 'an altered execution result no longer matches the hash');
    });

    await t.step('history cannot be rewritten', async () => {
      for (const [table, sql] of [
        ['events', `update events set actor_session_id = 'mallory' where resource_id = $1`],
        ['checkpoints', `delete from checkpoints where resource_id = $1`],
        ['scrolls', `delete from scrolls where resource_id = $1`],
        ['executions', `delete from executions where resource_id = $1`],
      ]) {
        let refused = false;
        try {
          await w.env!.db.query(sql, [rid]);
        } catch {
          refused = true;
        }
        t.check(refused, `${table}: the database refuses the rewrite`);
      }
    });
  },
};
