import { canonicalHash } from '../../src/continuity/canonical';
import type { Scenario } from '../scenario';
import { setup } from './lifecycle';

export const supersession: Scenario = {
  name: 'supersession',
  description: 'H3 superseded by H4: both retained, lineage explicit, no silent overwrite.',
  async run(w, t) {
    const a = w.actor('a', { session: 'session-a' });
    const rid = await setup(t, a, 'Supersession');
    await a.append(rid, { type: 'hypothesis', title: 'H3: disk contention' });
    await a.append(rid, { type: 'hypothesis', title: 'H4: lock contention' });

    await t.step('supersede requires expected_version', async () => {
      t.status(await a.supersede(rid, { target: 'TOK-001', reason: 'x', by: 'TOK-002' }), 400, 'no expected_version', 'missing_expected_version');
    });

    await t.step('supersede H3 by existing H4', async () => {
      const v = await a.version(rid);
      const res = await a.supersede(rid, { target: 'TOK-001', reason: 'iostat shows idle disks', by: 'TOK-002' }, { expected_version: v });
      t.status(res, 200, 'supersede by existing');
      t.eq([res.body.result.superseded.status, res.body.result.superseded.superseded_by], ['superseded', 'TOK-002'], 'H3 marked superseded_by H4');
      t.eq(res.body.result.replacement.supersedes, 'TOK-001', 'H4 supersedes H3');
      const d = (await a.inspect(rid)).body;
      t.eq(d.knowledge.items.length, 2, 'H3 retained');
      t.eq(d.knowledge.items[0].title, 'H3: disk contention', 'H3 content unchanged');
    });

    await t.step('supersede with a new replacement; chains are preserved', async () => {
      const v = await a.version(rid);
      const res = await a.supersede(rid, { target: 'TOK-002', reason: 'narrowed', replacement: { type: 'hypothesis', title: 'H5: allocator lock', stated_confidence: 'medium' } }, { expected_version: v });
      t.status(res, 200, 'supersede with replacement');
      t.eq(res.body.result.replacement.id, 'TOK-003', 'replacement is TOK-003');
      const chain = (await a.inspect(rid)).body.knowledge.items.map((k: any) => [k.id, k.status, k.supersedes, k.superseded_by]);
      t.eq(chain, [['TOK-001', 'superseded', null, 'TOK-002'], ['TOK-002', 'superseded', 'TOK-001', 'TOK-003'], ['TOK-003', 'active', 'TOK-002', null]], 'lineage H3 → H4 → H5');
    });

    await t.step('invalid supersessions are refused', async () => {
      const v = await a.version(rid);
      t.status(await a.supersede(rid, { target: 'TOK-001', reason: 'x', by: 'TOK-003' }, { expected_version: v }), 409, 'supersede an already superseded TOK', 'invalid_state');
      t.status(await a.supersede(rid, { target: 'TOK-003', reason: 'x', by: 'TOK-003' }, { expected_version: v }), 409, 'supersede a TOK by itself', 'invalid_state');
      t.status(await a.supersede(rid, { target: 'TOK-003', reason: 'x' }, { expected_version: v }), 422, 'neither by nor replacement', 'invalid_payload');
    });
  },
};

export const fork: Scenario = {
  name: 'fork',
  description: 'parent ├ child A └ child B: independent branches with ancestry; parent unmodified; no merge.',
  async run(w, t) {
    const owner = w.actor('owner', { session: 'session-root' });
    const ca = w.actor('ca', { session: 'session-ca' });
    const cb = w.actor('cb', { session: 'session-cb' });
    const rid = await setup(t, owner, 'Research R');
    await owner.append(rid, { type: 'finding', title: 'F1' });
    await owner.append(rid, { type: 'task', title: 'T1' });
    await owner.checkpoint(rid, { label: 'cp1' });
    await owner.append(rid, { type: 'finding', title: 'F2 (after cp1)' });
    const parentVersion = await owner.version(rid);

    const [childA, childB] = await t.step('two sessions fork independently', async () => {
      const fa = await ca.fork(rid, { title: 'Branch A', reason: 'explore GC' });
      t.status(fa, 201, 'fork A (current state)');
      t.eq(fa.body.result.lineage, { parent: rid, parent_version: parentVersion, parent_checkpoint: null }, 'lineage recorded');
      const fb = await cb.fork(rid, { title: 'Branch B', from_checkpoint: 1 });
      t.status(fb, 201, 'fork B (from checkpoint 1)');
      t.eq(fb.body.result.lineage.parent_checkpoint, 1, 'fork from checkpoint');
      t.eq(await owner.version(rid), parentVersion, 'parent version unchanged by forks');
      return [fa.body.resource_id, fb.body.resource_id];
    });

    await t.step('children are independent resources owned by the forking sessions', async () => {
      const a = (await ca.inspect(childA)).body;
      const b = (await cb.inspect(childB)).body;
      t.eq(a.ownership.owner.session_id, 'session-ca', 'A owned by session-ca');
      t.eq(b.ownership.owner.session_id, 'session-cb', 'B owned by session-cb');
      t.eq(a.knowledge.items.map((k: any) => k.id), ['TOK-001', 'TOK-002', 'TOK-003'], 'A copied the current knowledge');
      t.eq(b.knowledge.items.map((k: any) => k.id), ['TOK-001', 'TOK-002'], 'B copied knowledge as of checkpoint 1');
      t.eq(a.knowledge.items[0].source.session_id, 'session-root', 'copied TOKs keep their original source');
      t.eq(a.knowledge.items[0].origin.resource_id, rid, 'copied TOKs carry origin');
      t.eq(a.authority.task_responsibility[0].responsible_session_id, 'session-ca', 'branch owner responsible for copied tasks');
      t.eq(a.resource.lineage.parent.id, rid, 'child knows its parent');
      t.eq(a.provenance.created.operation, 'fork', 'child history begins with fork');
    });

    await t.step('branches diverge without affecting each other or the parent', async () => {
      t.status(await ca.append(childA, { type: 'finding', title: 'A-only' }), 200, 'append in A');
      t.eq((await ca.append(childA, { type: 'finding', title: 'A-only 2' })).body.result.tok.id, 'TOK-005', 'A continues numbering');
      t.status(await cb.append(childB, { type: 'finding', title: 'B-only' }), 200, 'append in B');
      t.eq((await cb.inspect(childB)).body.knowledge.items.map((k: any) => k.title).includes('A-only'), false, 'B does not see A');
      t.eq((await owner.inspect(rid)).body.knowledge.items.length, 3, 'parent unchanged');
      t.status(await ca.append(rid, { type: 'finding', title: 'x' }, { token: ca.token(childA) }), 403, 'child owner has no authority on parent', 'capability_resource_mismatch');
      t.status(await owner.append(childA, { type: 'finding', title: 'x' }, { token: owner.token(rid) }), 403, 'parent owner has no authority on child', 'capability_resource_mismatch');
    });

    await t.step('parent lists its forks; grandchildren retain ancestry', async () => {
      const d = (await owner.inspect(rid)).body;
      t.eq(d.resource.lineage.forks.map((f: any) => f.id).sort(), [childA, childB].sort(), 'parent lists both forks');
      const g = await ca.fork(childA, { title: 'Grandchild' });
      const exp = (await ca.getJson(`/r/${g.body.resource_id}/explorer`)).body;
      t.eq(exp.ancestry.map((x: any) => x.id), [rid, childA], 'explorer shows ancestry root → child');
      t.check(!d.operations.some((o: any) => o.name === 'merge'), 'no merge operation exists');
    });
  },
};

export const provenanceHistory: Scenario = {
  name: 'provenance-history',
  description: 'Every version has exactly one event with full provenance; history cannot be rewritten.',
  needsDatabase: true,
  async run(w, t) {
    const a = w.actor('a', { session: 'session-a', agent: 'agent-a' });
    const b = w.actor('b', { session: 'session-b', agent: 'agent-b' });
    const rid = await setup(t, a, 'Provenance');
    await a.append(rid, { type: 'observation', title: 'o1' });
    const d = await a.delegate(rid, { to: { session_id: 'session-b' }, scopes: ['append', 'checkpoint'] });
    b.receive(rid, d.body.result.capability.token);
    await b.append(rid, { type: 'finding', title: 'f1' });
    await b.checkpoint(rid, { label: 'b-cp' });
    await b.propose(rid, { operation: 'append', payload: { type: 'question', title: 'q' } }, { token: null });

    await t.step('events chain version by version with complete provenance', async () => {
      const events = (await a.getJson(`/r/${rid}/events`)).body.events;
      const v = await a.version(rid);
      t.eq(events.length, v, 'one event per version');
      t.check(events.every((e: any, i: number) => e.version === i + 1 && e.parent_version === i && e.resulting_version === i + 1), 'parent/resulting versions chain');
      const required = ['actor', 'identity_assurance', 'operation', 'resource_id', 'occurred_at', 'parent_version', 'resulting_version', 'summary', 'request_hash', 'idempotency_key'];
      t.check(events.every((e: any) => required.every((k) => e[k] !== undefined && e[k] !== null) && e.actor.session_id), 'every event has actor, session, operation, resource, timestamp, versions');
      t.eq(events.map((e: any) => [e.operation, e.actor.session_id, e.identity_assurance]), [
        ['create', 'session-a', 'asserted'],
        ['append', 'session-a', 'capability'],
        ['delegate', 'session-a', 'capability'],
        ['append', 'session-b', 'capability'],
        ['checkpoint', 'session-b', 'capability'],
        ['propose', 'session-b', 'asserted'],
      ], 'who did what, with which assurance');
      t.check(events.slice(1).every((e: any, i: number) => e.occurred_at > events[i].occurred_at), 'timestamps strictly increase');
      const one = (await a.getJson(`/r/${rid}/events/4`)).body.event;
      t.eq(one.capability_id, d.body.result.capability.id, 'event names the capability that authorised it');
    });

    await t.step('the database refuses to rewrite history', async () => {
      const db = w.env!.db;
      const upd = await db.query(`update events set summary = 'rewritten' where resource_id = $1 and version = 2`, [rid]).then(() => 'ok', (e) => String(e.message));
      t.check(upd.includes('append-only'), `UPDATE events rejected (${upd})`);
      const del = await db.query(`delete from events where resource_id = $1`, [rid]).then(() => 'ok', (e) => String(e.message));
      t.check(del.includes('append-only'), 'DELETE events rejected');
      const cpu = await db.query(`update checkpoints set label = 'x' where resource_id = $1`, [rid]).then(() => 'ok', (e) => String(e.message));
      t.check(cpu.includes('append-only'), 'UPDATE checkpoints rejected');
      const dup = await db.query(
        `insert into events (resource_id, version, parent_version, operation, actor_session_id, actor_kind, identity_assurance, occurred_at, summary, data)
         values ($1, 2, 1, 'forged', 'x', 'agent', 'asserted', now(), 'x', '{}')`, [rid]).then(() => 'ok', (e) => String(e.code));
      t.eq(dup, '23505', 'duplicate version rejected by primary key');
      const gap = await db.query(
        `insert into events (resource_id, version, parent_version, operation, actor_session_id, actor_kind, identity_assurance, occurred_at, summary, data)
         values ($1, 99, 7, 'forged', 'x', 'agent', 'asserted', now(), 'x', '{}')`, [rid]).then(() => 'ok', (e) => String(e.code));
      t.eq(gap, '23514', 'parent_version ≠ version-1 rejected by check constraint');
    });
  },
};

export const checkpointResume: Scenario = {
  name: 'checkpoint-resume',
  description: 'Resume from checkpoint N: verifiable snapshot + diff since N reconstruct the state.',
  async run(w, t) {
    const a = w.actor('a', { session: 'session-a' });
    const rid = await setup(t, a, 'Checkpoints');
    for (let i = 1; i <= 3; i++) await a.append(rid, { type: 'observation', title: `obs ${i}` });
    await a.checkpoint(rid, { label: 'three observations' });
    await a.annotate(rid, { tok_id: 'TOK-001', kind: 'validation', content: 'Re-measured', evidence: { method: 'rerun benchmark', result: 'matches ±2%' } });
    let v = await a.version(rid);
    await a.supersede(rid, { target: 'TOK-002', reason: 'bad sensor', replacement: { type: 'observation', title: 'obs 2 (corrected)' } }, { expected_version: v });
    await a.append(rid, { type: 'decision', title: 'Proceed with obs 1 and 2′' });
    v = await a.version(rid);

    await t.step('checkpoint snapshot is self-verifying and frozen', async () => {
      const cp = (await a.getJson(`/r/${rid}/checkpoints/1`)).body.checkpoint;
      t.eq(canonicalHash(cp.snapshot), cp.sha256, 'sha256 recomputes from the snapshot');
      t.eq(cp.snapshot.knowledge.map((k: any) => [k.id, k.status]), [['TOK-001', 'active'], ['TOK-002', 'active'], ['TOK-003', 'active']], 'snapshot shows state at the checkpoint (TOK-002 not yet superseded)');
      t.eq(cp.snapshot.resource.version, cp.version, 'snapshot version = checkpoint version');
    });

    await t.step('diff since checkpoint contains exactly the later changes', async () => {
      const d = (await a.getJson(`/r/${rid}/diff?since_checkpoint=1`)).body;
      t.eq(d.events.map((e: any) => e.operation), ['annotate', 'supersede', 'append'], 'later events');
      t.eq(d.knowledge_added.map((k: any) => k.id), ['TOK-004', 'TOK-005'], 'added TOKs');
      t.eq(d.knowledge_superseded.map((s: any) => s.target), ['TOK-002'], 'superseded TOKs');
      t.eq(d.to, v, 'up to the current version');
      const r = await a.getJson(`/r/${rid}/diff?from=3&to=2`);
      t.status(r, 400, 'inverted bounds', 'malformed_request');
      t.status(await a.getJson(`/r/${rid}/diff?since_checkpoint=9`), 404, 'unknown checkpoint', 'not_found');
    });

    await t.step('validation annotations stay claims, not verdicts', async () => {
      const tok = (await a.getJson(`/r/${rid}/knowledge/TOK-001`)).body.tok;
      t.eq(tok.stated_confidence, 'unclassified', 'TOK confidence untouched by validation');
      t.check(tok.annotations[0].note.includes('has not verified'), 'validation labelled as annotator\'s claim');
      t.status(await a.annotate(rid, { tok_id: 'TOK-001', kind: 'validation', content: 'trust me' }), 422, 'validation without evidence', 'invalid_payload');
    });
  },
};
