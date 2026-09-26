/**
 * Program 001 experiments.
 *
 *   A  p001-exp-a-kill-recover     session termination and recovery (PROGRAM-001.md)
 *   B  p001-exp-b-substrate-switch substrate change under one identity (PROGRAM-001-SUBSTRATE-SWITCH.md)
 *   F  p001-fresh-session          a fresh client given only a URL (M0, the ladder's bottom rung)
 *
 * Each falsification criterion is an assertion: if one fails, the scenario
 * (the experiment) fails. Measurements are recorded with t.measure and
 * reported as data.
 */
import { canonicalHash } from '../../src/continuity/canonical';
import { toQ } from '../../src/substrates/rational';
import { alternateJsonHref } from '../client';
import { M0Client } from '../clients/m0';
import type { Scenario } from '../scenario';
import { authorize, createIdentity, execution, MULTIPLY } from './p001-common';

export const p001ExpA: Scenario = {
  name: 'p001-exp-a-kill-recover',
  program: '001',
  description: 'EXPERIMENT A: identity → session A → Scroll → execute → alias → checkpoint → TERMINATE A → session B recovers from the checkpoint alone and continues.',
  async run(w, t) {
    let rid = '';
    let principal: Awaited<ReturnType<typeof createIdentity>>['principal'];
    const a = w.actor('session-a', { session: 'session-a', agent: 'agent-runtime-a' });
    const INPUTS = { a: 6, b: 7 };
    let capA = '';
    let tokenA = '';
    let recordA: any;
    let checkpointA: any;
    let identityUrl = '';

    await t.step('CREATE IDENTITY', async () => {
      const f = await createIdentity(w, t, 'Agent X', { description: 'Experiment A subject' });
      rid = f.rid;
      principal = f.principal;
      identityUrl = (await principal.inspect(rid)).body.resource.url;
    });

    await t.step('CREATE SESSION A (authorized by the principal) and embody', async () => {
      capA = await authorize(t, { rid, principal }, a);
      const e = await a.embody(rid, { model: { provider: 'provider-1', model_id: 'model-a' }, application: { application_id: 'app-a' } });
      t.status(e, 200, 'A embodies');
    });

    let contract: any;
    await t.step('DISCOVER SUBSTRATE', async () => {
      const subs = (await a.getJson((await a.inspect(rid)).body.links.substrates)).body.substrates;
      const available = subs.filter((s: any) => s.status === 'available');
      t.check(available.length >= 1, 'A discovers at least one available substrate');
      t.status(await a.setSubstrate(rid, 'deterministic-calculator'), 200, 'A selects deterministic-calculator');
    });

    await t.step('DISCOVER OPERATION', async () => {
      const m = (await a.getJson('/substrates/deterministic-calculator')).body.manifest;
      contract = m.operations.find((o: any) => o.name === 'multiply');
      t.check(contract?.arity === 2 && contract.determinism === 'deterministic', 'A discovers the multiply contract (arity 2, deterministic)');
    });

    await t.step('CREATE SCROLL', async () => {
      t.status(await a.createScroll(rid, MULTIPLY), 200, 'A commits SCR-001:v1');
    });

    await t.step('EXECUTE SCROLL', async () => {
      const r = await a.execute(rid, { target: { scroll_id: 'SCR-001', version: 1 }, inputs: INPUTS });
      recordA = execution(r);
      t.eq([recordA.status, recordA.outputs], ['completed', { s1: 42 }], 'A: 6 × 7 = 42');
    });

    await t.step('CREATE ALIAS', async () => {
      t.status(await a.setAlias(rid, { name: 'multiply', target: { scroll_id: 'SCR-001', version: 1 } }, { expected_version: await a.version(rid) }), 200, 'A binds "multiply" → SCR-001:v1');
    });

    await t.step('CHECKPOINT', async () => {
      const c = await a.checkpoint(rid, { label: 'session A: multiply established', note: 'before termination' });
      checkpointA = c.body.result.checkpoint;
      t.eq(checkpointA.number, 1, 'checkpoint 1');
    });

    await t.step('TERMINATE SESSION A', async () => {
      t.status(await a.release(rid, { embodiment_id: 'EMB-001', reason: 'session A terminated' }), 200, 'A releases its embodiment');
      t.status(await principal.revoke(rid, { capability_id: capA, reason: 'session A terminated' }), 200, 'principal revokes A\'s capability');
      tokenA = a.token(rid)!; // kept only to test for leaks below
      a.forget(); // A's process is gone: it retains nothing.
    });

    // Session B: a fresh actor. It is given the identity URL (and, out of band, its OWN capability).
    const b = w.actor('session-b', { session: 'session-b', agent: 'agent-runtime-b' });
    let before = 0;
    let after = 0;
    let doc: any;
    let snapshot: any;
    await t.step('CREATE SESSION B', async () => {
      await authorize(t, { rid, principal: principal! }, b);
      t.check(b.token(rid) !== undefined && b.session_id !== a.session_id, 'B holds its own session-bound capability; nothing of A');
      before = w.client.requests; // B's own requests start here
    });

    await t.step('RECOVER IDENTITY', async () => {
      const html = await b.openHtml(identityUrl);
      doc = (await b.getJson(alternateJsonHref(html.text)!, b.token(rid))).body;
      t.eq(doc.identity.agent_id, rid, 'B finds the same agent identity');
      t.eq(doc.identity.embodiment_status, 'unembodied', 'nobody embodies it after A terminated');
    });

    await t.step('READ CHECKPOINT', async () => {
      const cp = (await b.getJson(doc.identity.current_checkpoint.href)).body.checkpoint;
      snapshot = cp.snapshot;
      t.eq(cp.number, checkpointA.number, 'B reads checkpoint 1');
      t.eq(canonicalHash(cp.snapshot), checkpointA.sha256, 'B verifies the checkpoint hash that A obtained');
      t.eq(snapshot.identity.agent_id, rid, 'the snapshot names the identity');
      t.eq(snapshot.scrolls.map((s: any) => s.ref), ['SCR-001:v1'], 'the snapshot holds the Scroll lineage with content');
      t.eq(snapshot.executions.map((x: any) => [x.execution_id, x.session.session_id, x.outputs]), [['EXE-001', 'session-a', { s1: 42 }]], 'the snapshot holds A\'s execution history');
    });

    await t.step('EMBODY (session B)', async () => {
      t.status(await b.embody(rid, { model: { provider: 'provider-2', model_id: 'model-b' }, application: { application_id: 'app-b' } }), 200, 'B embodies the identity as itself');
    });

    let resolved = '';
    await t.step('RESOLVE ALIAS', async () => {
      const fromSnapshot = snapshot.aliases.find((x: any) => x.name === 'multiply').target.ref;
      const live = (await w.client.getJson(`/r/${rid}/aliases/multiply`)).body.alias.target.ref;
      resolved = live;
      t.eq([fromSnapshot, live], ['SCR-001:v1', 'SCR-001:v1'], 'the alias resolves identically from the checkpoint and live (no credential, no session)');
    });

    let recordB: any;
    await t.step('REUSE SCROLL', async () => {
      const r = await b.execute(rid, { target: { alias: 'multiply' }, inputs: INPUTS });
      recordB = execution(r);
      t.eq(recordB.scroll.ref, resolved, 'B executes the resolved version');
      t.eq([recordB.outputs, recordB.scroll.content_sha256], [recordA.outputs, recordA.scroll.content_sha256], 'B reproduces A\'s result on the same Scroll content');
      t.eq(recordB.operation_sequence, recordA.operation_sequence, 'identical operation sequence');
    });

    let recordB2: any;
    await t.step('EXECUTE AGAIN', async () => {
      recordB2 = execution(await b.execute(rid, { target: { alias: 'multiply' }, inputs: { a: 12, b: 12 } }));
      t.eq(recordB2.outputs, { s1: 144 }, 'B continues: 12 × 12 = 144');
    });

    let checkpointB: any;
    await t.step('CHECKPOINT', async () => {
      checkpointB = (await b.checkpoint(rid, { label: 'session B: continued' })).body.result.checkpoint;
      t.eq(checkpointB.number, 2, 'checkpoint 2');
      after = w.client.requests;
    });

    await t.step('falsification criteria and measurements', async () => {
      const ev = (await b.getJson(`/r/${rid}/events`)).body.events;
      const tr = (await b.getJson(`/r/${rid}/transitions`)).body.transitions;
      const ex = (await b.getJson(`/r/${rid}/executions`)).body.executions;
      const lastA = ev.filter((e: any) => e.actor.session_id === 'session-a').at(-1).version;
      const releaseV = ev.find((e: any) => e.operation === 'release').version;
      // Falsifiers (any false ⇒ H1 rejected for this run).
      t.check(doc.identity.agent_id === rid, 'NOT FALSIFIED: the identity was recovered');
      t.check(snapshot.scrolls[0].content_sha256 === recordA.scroll.content_sha256, 'NOT FALSIFIED: Scroll lineage was not lost');
      t.check(resolved === 'SCR-001:v1', 'NOT FALSIFIED: alias resolution did not depend on the terminated session');
      t.check(ex[0].session.session_id === 'session-a' && ex[0].embodiment_id === 'EMB-001' && ex[1].session.session_id === 'session-b' && ex[1].embodiment_id === 'EMB-002', 'NOT FALSIFIED: execution provenance is unambiguous');
      t.check(ev.filter((e: any) => e.version > releaseV).every((e: any) => e.actor.session_id !== 'session-a'), 'NOT FALSIFIED: B never had to act as session A');
      t.check(lastA <= releaseV, 'NOT FALSIFIED: session A performed nothing after its termination');
      t.status(await a.execute(rid, { target: { alias: 'multiply' }, inputs: INPUTS }, { token: tokenA }), 401, 'NOT FALSIFIED: no authority leaks to terminated A (its old capability is revoked)', 'capability_revoked');
      t.status(await b.execute(rid, { target: { alias: 'multiply' }, inputs: INPUTS }, { actor: { session_id: 'session-a' } }), 403, 'NOT FALSIFIED: B cannot act as A even if it tried', 'session_mismatch');
      const embB = tr.find((x: any) => x.operation === 'embody' && x.actor.session_id === 'session-b');
      t.measure('identity_recovered', doc.identity.agent_id === rid);
      t.measure('checkpoint_recovered', { number: checkpointA.number, sha256_verified: canonicalHash(snapshot) === checkpointA.sha256 });
      t.measure('scroll_recovered', { ref: snapshot.scrolls[0].ref, content_sha256_equal: snapshot.scrolls[0].content_sha256 === recordA.scroll.content_sha256 });
      t.measure('alias_resolved', { from_checkpoint: 'SCR-001:v1', live: resolved });
      t.measure('execution_reproduced', { a: recordA.outputs, b: recordB.outputs, equal: JSON.stringify(recordA.outputs) === JSON.stringify(recordB.outputs) });
      t.measure('provenance_preserved', ex.map((x: any) => ({ id: x.execution_id, session: x.session.session_id, embodiment: x.embodiment_id, model: x.model?.model_id })));
      t.measure('session_changed', { from: 'session-a', to: 'session-b', model_from: 'model-a', model_to: 'model-b' });
      t.measure('observations_on_recovery', embB.observations);
      t.measure('session_b_requests', after - before);
      t.measure('checkpoints', { a: checkpointA.sha256, b: checkpointB.sha256 });
    });

    await t.step('ARM 2: ungraceful termination (B vanishes without releasing); C recovers', async () => {
      b.forget();
      const c = w.actor('session-c', { session: 'session-c' });
      await authorize(t, { rid, principal: principal! }, c);
      t.status(await c.embody(rid), 409, 'C cannot embody while B\'s embodiment is still active', 'invalid_state');
      t.status(await principal!.release(rid, { embodiment_id: 'EMB-002', reason: 'session B lost (no release received)' }), 200, 'the principal terminates B\'s embodiment');
      t.status(await c.embody(rid), 200, 'C embodies');
      const r = execution(await c.execute(rid, { target: { alias: 'multiply' }, inputs: INPUTS }));
      t.eq(r.outputs, recordA.outputs, 'C reproduces the result as itself');
      const rel = (await c.getJson(`/r/${rid}/events`)).body.events.filter((e: any) => e.operation === 'release');
      t.eq(rel.map((e: any) => [e.actor.session_id, e.data.session_id, e.data.by_owner]), [['session-a', 'session-a', false], ['principal-alice', 'session-b', true]], 'the record distinguishes self-release from termination by the principal');
      t.measure('arm2_ungraceful_recovered', r.outputs);
      t.artifact('transitions', (await c.getJson(`/r/${rid}/transitions`)).body);
    });
  },
};

const MEAN3 = {
  purpose: 'arithmetic mean of three values',
  inputs: ['a', 'b', 'c'],
  symbols: { n: 3 },
  operations: [
    { id: 'ab', operation: 'add', arguments: ['a', 'b'] },
    { id: 'abc', operation: 'add', arguments: ['ab', 'c'] },
    { id: 'mean', operation: 'divide', arguments: ['abc', 'n'] },
  ],
};
const BATTERY = [
  { a: 1, b: 2, c: 3 },
  { a: 0.1, b: 0.2, c: 0.3 },
  { a: 1, b: 1, c: 1 },
  { a: 10, b: 0, c: 0 },
  { a: 1e16, b: 1, c: -1e16 },
  { a: 0.5, b: 0.25, c: 0.125 },
];

export const p001ExpB: Scenario = {
  name: 'p001-exp-b-substrate-switch',
  program: '001',
  description: 'EXPERIMENT B: one identity, one Scroll lineage, substrate X → checkpoint → substrate Y (with a session change); record what is preserved and what changes.',
  async run(w, t) {
    const f = await createIdentity(w, t, 'Agent S', { description: 'Experiment B subject' });
    const { rid, principal } = f;
    const a = w.actor('session-a', { session: 'session-a' });
    const b = w.actor('session-b', { session: 'session-b' });
    const onX: any[] = [];
    const onY: any[] = [];
    let cp: any;

    await t.step('Agent → substrate X (deterministic-calculator) → Scroll → executions → checkpoint', async () => {
      const capA = await authorize(t, f, a);
      await a.embody(rid, { model: { provider: 'provider-1', model_id: 'model-a' } });
      t.status(await a.setSubstrate(rid, 'deterministic-calculator'), 200, 'X attached');
      t.status(await a.createScroll(rid, MEAN3), 200, 'SCR-001 mean3');
      await a.setAlias(rid, { name: 'mean3', target: { scroll_id: 'SCR-001', version: 1 } }, { expected_version: await a.version(rid) });
      for (const inputs of BATTERY) onX.push(execution(await a.execute(rid, { target: { alias: 'mean3' }, inputs })));
      t.check(onX.every((x) => x.status === 'completed'), 'all executions on X completed');
      cp = (await a.checkpoint(rid, { label: 'on X' })).body.result.checkpoint;
      await a.release(rid, { embodiment_id: 'EMB-001', reason: 'switching' });
      await principal.revoke(rid, { capability_id: capA, reason: 'session A done' });
    });

    let snapshot: any;
    await t.step('substrate Y: a new session recovers the same identity and switches substrate', async () => {
      await authorize(t, f, b);
      const doc = (await b.inspect(rid)).body;
      snapshot = (await b.getJson(doc.identity.current_checkpoint.href)).body.checkpoint.snapshot;
      t.eq(canonicalHash(snapshot), cp.sha256, 'checkpoint verified');
      t.eq(snapshot.substrate_context.current.substrate_id, 'deterministic-calculator', 'the checkpoint records substrate X as the context');
      t.status(await b.embody(rid, { model: { provider: 'provider-2', model_id: 'model-b' } }), 200, 'B embodies');
      t.status(await b.setSubstrate(rid, 'exact-rational-calculator', { key: 'switch-to-y-0001' }), 200, 'X → Y');
      for (const inputs of BATTERY) onY.push(execution(await b.execute(rid, { target: { alias: 'mean3' }, inputs })));
      t.check(onY.every((x) => x.status === 'completed'), 'all executions on Y completed');
    });

    await t.step('what is preserved, what changes', async () => {
      const doc = (await b.inspect(rid)).body;
      const lineage = doc.scrolls.items[0].lineage;
      t.eq(doc.identity.agent_id, rid, 'PRESERVED: identity');
      t.eq(lineage.map((v: any) => v.content_sha256), [snapshot.scrolls[0].content_sha256], 'PRESERVED: Scroll lineage and content hash');
      t.eq(doc.aliases.items[0].target.ref, 'SCR-001:v1', 'PRESERVED: alias binding');
      t.check(onY.every((x) => x.scroll.content_sha256 === onX[0].scroll.content_sha256), 'PRESERVED: every execution on Y ran the same Scroll content');
      const hist = (await b.getJson(`/r/${rid}/executions`)).body.executions;
      t.eq(hist.slice(0, BATTERY.length).map((x: any) => x.outputs), onX.map((x) => x.outputs), 'PRESERVED: the X-era execution records are unchanged');
      t.eq([doc.identity.current_substrate.substrate_id, doc.identity.current_session.session_id], ['exact-rational-calculator', 'session-b'], 'CHANGED: substrate and session');
      const rows = BATTERY.map((inputs, i) => {
        const x = onX[i].outputs.mean as number;
        const y = onY[i].outputs.mean as string;
        const q = toQ(y)!;
        const yAsDouble = Number(q.n) / Number(q.d);
        return { inputs, on_x: x, on_y: y, y_as_nearest_double: yAsDouble, numerically_equal: x === yAsDouble, representation_changed: typeof x !== typeof y };
      });
      t.measure('preserved', ['agent_id', 'Scroll id/version/content_sha256', 'alias binding', 'execution history of the X era', 'principal and ownership']);
      t.measure('changed', ['session (A → B)', 'declared model (model-a → model-b)', 'substrate (deterministic-calculator → exact-rational-calculator)', 'output representation (JSON number → rational string)']);
      t.measure('outputs_by_substrate', rows);
      t.measure('inputs_where_values_diverge', rows.filter((r) => !r.numerically_equal).map((r) => r.inputs));
      const tr = (await b.getJson(`/r/${rid}/transitions`)).body.transitions.find((x: any) => x.operation === 'set_substrate' && x.actor.session_id === 'session-b');
      t.measure('substrate_change_observations', tr.observations);
      t.check(rows.some((r) => !r.numerically_equal), 'OBSERVED (not assumed): for some inputs the substrates disagree');
      t.check(rows.some((r) => r.numerically_equal), 'OBSERVED (not assumed): for other inputs they agree');
      t.artifact('transitions', (await b.getJson(`/r/${rid}/transitions`)).body);
    });
  },
};

export const p001FreshSession: Scenario = {
  name: 'p001-fresh-session',
  program: '001',
  description: 'A fresh deterministic client (M0) given only a URL discovers protocol, identity, state, authority, substrates, Scrolls and operations; proposes without authority, commits with it.',
  async run(w, t) {
    const f = await createIdentity(w, t, 'Agent F');
    const { rid, principal } = f;
    const a = w.actor('session-a', { session: 'session-a' });
    const capA = await authorize(t, f, a);
    await a.embody(rid);
    await a.setSubstrate(rid, 'deterministic-calculator');
    await a.createScroll(rid, MULTIPLY);
    await a.setAlias(rid, { name: 'multiply', target: { scroll_id: 'SCR-001', version: 1 } }, { expected_version: await a.version(rid) });
    await a.execute(rid, { target: { alias: 'multiply' }, inputs: { a: 2, b: 21 } });
    await a.checkpoint(rid, { label: 'handover' });
    await a.release(rid, { embodiment_id: 'EMB-001', reason: 'done' });
    await principal.revoke(rid, { capability_id: capA, reason: 'done' });
    const url = (await principal.inspect(rid)).body.resource.url;
    const task = { alias: 'multiply', inputs: { a: 3, b: 5 } };

    await t.step('M0 without any capability: read → understand → propose; never claim a commit', async () => {
      const v = await principal.version(rid);
      const r = await new M0Client(w.client, 'session-m0-readonly').run(url, task);
      t.check(Object.values(r.discovered).every(Boolean), `discovered: ${JSON.stringify(r.discovered)}`);
      t.eq(r.agent_id, rid, 'identity discovered');
      t.eq(r.alias_resolution, { alias: 'multiply', ref: 'SCR-001:v1' }, 'alias resolved');
      t.check(r.may.includes('propose') && !r.may.includes('execute') && !r.may.includes('embody'), 'knows it may propose but not execute or embody');
      t.eq(r.actions.map((x) => [x.operation, x.claim]), [['propose', 'PROPOSED']], 'its only action is a proposal, reported as PROPOSED');
      t.eq(r.outputs, null, 'it reports no result');
      t.eq((await principal.getJson(`/r/${rid}/executions`)).body.count, 1, 'no execution happened');
      t.eq(await principal.version(rid), v + 1, 'exactly one event: the proposal');
      t.measure('m0_readonly', { requests: r.requests, failures: r.failures, discovered: r.discovered, may: r.may, claims: r.actions.map((x) => x.claim) });
    });

    await t.step('M0 with a delegated capability: read → embody → execute → commit → checkpoint', async () => {
      const d = await principal.delegate(rid, { to: { session_id: 'session-m0' }, scopes: ['embody', 'execute', 'checkpoint'] });
      const r = await new M0Client(w.client, 'session-m0', d.body.result.capability.token).run(url, task);
      t.check(Object.values(r.discovered).every(Boolean), 'discovered everything again');
      t.eq(r.actions.map((x) => [x.operation, x.status, x.claim]), [['embody', 200, 'PERFORMED'], ['execute', 200, 'PERFORMED'], ['checkpoint', 200, 'PERFORMED']], 'embody, execute, checkpoint — performed');
      t.eq(r.outputs, { s1: 15 }, '3 × 5 = 15');
      t.check(r.checkpoint !== null && r.recovered_checkpoint?.number === 1, 'it recovered from checkpoint 1 and produced a new checkpoint');
      const x = (await principal.getJson(`/r/${rid}/executions`)).body.executions.at(-1);
      t.eq([x.session.session_id, x.via_alias.name], ['session-m0', 'multiply'], 'the execution is attributed to M0\'s own session, via the alias');
      t.measure('m0_delegated', { requests: r.requests, failures: r.failures, may: r.may, claims: r.actions.map((x) => x.claim), outputs: r.outputs, checkpoint: r.checkpoint });
    });
  },
};
