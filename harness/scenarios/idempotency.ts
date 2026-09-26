/**
 * Idempotency, measured three ways (PROTOCOL.md §6.4):
 *   request — same key + same request → the original result, nothing re-executed
 *   repeat  — the same operation again under a NEW key → new effect, or refused
 *   event   — whether a repeat appends events
 * The registry declares `repeat` for every mutating operation; this scenario
 * performs each operation twice and checks the declaration against reality.
 */
import { canonicalJson } from '../../src/continuity/canonical';
import { OPERATIONS, SEMANTICS } from '../../src/protocol/operations';
import type { Actor } from '../actors';
import type { Scenario } from '../scenario';
import { setup } from './lifecycle';

async function counts(a: Actor, rid: string) {
  const doc = (await a.getJson(`/r/${rid}/op.json`)).body;
  return { version: doc.current_version as number, operations: doc.operations.length as number };
}

export const idempotencySemantics: Scenario = {
  name: 'idempotency-semantics',
  description: 'Request, repeat and event idempotency: replay never re-executes; each registry claim about repeats is checked.',
  needsClock: true,
  async run(w, t) {
    const owner = w.actor('owner', { session: 'session-owner' });
    const rid = await setup(t, owner, 'Idempotency');

    await t.step('same request twice → one operation, the same operation id, nothing re-executed', async () => {
      const env = owner.envelope('append', { type: 'finding', title: 'once' }, {}, 'fixed-key-0001');
      const first = await owner.op(rid, 'append', null, { raw: env });
      const before = await counts(owner, rid);
      const second = await owner.op(rid, 'append', null, { raw: env });
      t.status(second, 200, 'replay accepted');
      t.eq(second.body.replayed, true, 'marked replayed');
      t.eq(second.body.operation_id, first.body.operation_id, 'same operation id');
      t.eq(canonicalJson(second.body.operation_record), canonicalJson(first.body.operation_record), 'identical operation record (canonical JSON)');
      t.eq(await counts(owner, rid), before, 'no new operation, no new event');
    });

    await t.step('same request after a long delay (lost response, client retries) → still a replay', async () => {
      const env = owner.envelope('append', { type: 'finding', title: 'retried after timeout' }, {}, 'fixed-key-0002');
      const first = await owner.op(rid, 'append', null, { raw: env });
      w.clock!.advance(7 * 24 * 3600 * 1000);
      const retry = await owner.op(rid, 'append', null, { raw: env });
      t.eq([retry.body.replayed, retry.body.operation_id], [true, first.body.operation_id], 'replayed a week later: idempotency records do not expire in 0.2');
    });

    await t.step('same request from two sessions → two operations (idempotency is per credential scope)', async () => {
      const mk = async (s: string) => {
        const d = await owner.delegate(rid, { to: { session_id: s }, scopes: ['append'] });
        const x = w.actor(s, { session: s });
        x.receive(rid, d.body.result.capability.token);
        return x;
      };
      const s1 = await mk('session-one');
      const s2 = await mk('session-two');
      const r1 = await s1.append(rid, { type: 'observation', title: 'same content' }, { key: 'shared-key-0001' });
      const r2 = await s2.append(rid, { type: 'observation', title: 'same content' }, { key: 'shared-key-0001' });
      t.eq([r1.status, r2.status, r1.body.replayed, r2.body.replayed], [200, 200, false, false], 'both execute');
      t.check(r1.body.operation_id !== r2.body.operation_id, 'distinct operations, each attributed to its own session');
    });

    await t.step('same request with an expected_version that has since gone stale', async () => {
      const v = await owner.version(rid);
      const env = owner.envelope('append', { type: 'finding', title: 'at v' }, { expected_version: v }, 'fixed-key-0003');
      const first = await owner.op(rid, 'append', null, { raw: env });
      await owner.append(rid, { type: 'finding', title: 'moves the resource on' });
      const again = await owner.op(rid, 'append', null, { raw: env });
      t.eq([again.status, again.body.replayed, again.body.version], [200, true, first.body.version], 'same key: the original result, not stale_version');
      t.status(await owner.append(rid, { type: 'finding', title: 'at v' }, { expected_version: v }), 409, 'new key + stale expected_version is refused', 'stale_version');
    });

    await t.step('same key, different request → refused, nothing executed', async () => {
      const before = await counts(owner, rid);
      t.status(await owner.append(rid, { type: 'finding', title: 'different' }, { key: 'fixed-key-0001' }), 422, 'key reuse', 'idempotency_key_reuse');
      t.eq(await counts(owner, rid), before, 'no operation recorded');
    });

    await t.step('concurrent identical requests → exactly one execution', async () => {
      const env = owner.envelope('append', { type: 'finding', title: 'concurrent' }, {}, 'fixed-key-0004');
      const before = await counts(owner, rid);
      const [x, y] = await Promise.all([owner.op(rid, 'append', null, { raw: env }), owner.op(rid, 'append', null, { raw: env })]);
      t.eq([x.status, y.status], [200, 200], 'both answered');
      t.eq(x.body.operation_id, y.body.operation_id, 'one operation id');
      t.eq([x.body.replayed || y.body.replayed, x.body.replayed && y.body.replayed], [true, false], 'one executed, one replayed');
      const after = await counts(owner, rid);
      t.eq([after.operations - before.operations, after.version - before.version], [1, 1], 'one operation, one event');
    });

    await t.step('every mutating operation, repeated under a NEW key, behaves as the registry declares', async () => {
      const b = w.actor('b', { session: 'session-b' });
      const observed: Record<string, 'new_effect' | 'refused'> = {};
      const twice = async (name: string, run: () => Promise<{ status: number; body: any }>) => {
        const first = await run();
        t.check(first.status === 200 || first.status === 201, `${name}: first execution succeeds (${first.status}${first.body?.error ? ` ${first.body.error.code}` : ''})`);
        const before = await counts(owner, first.body.resource_id ?? rid);
        const second = await run();
        const after = await counts(owner, first.body.resource_id ?? rid);
        const refused = second.status >= 400;
        observed[name] = refused ? 'refused' : 'new_effect';
        if (refused) t.eq(after, before, `${name}: a refused repeat appends no event and no operation`);
        else t.check(second.body.operation_id !== first.body.operation_id && !second.body.replayed, `${name}: the repeat is a new operation`);
      };
      await twice('create', () => owner.create({ title: 'twin' }));
      await twice('append', () => owner.append(rid, { type: 'finding', title: 'dup' }));
      await twice('annotate', () => owner.annotate(rid, { tok_id: 'TOK-001', kind: 'comment', content: 'dup' }));
      await twice('checkpoint', () => owner.checkpoint(rid, { label: 'dup' }));
      await twice('fork', () => owner.fork(rid, { reason: 'dup' }));
      await twice('delegate', () => owner.delegate(rid, { to: { session_id: 'session-x' }, scopes: ['annotate'] }));
      await twice('propose', () => b.propose(rid, { operation: 'append', payload: { type: 'question', title: 'dup?' } }));
      const cap = (await owner.delegate(rid, { to: { session_id: 'session-y' }, scopes: ['read'] })).body.result.capability.id;
      await twice('revoke', () => owner.revoke(rid, { capability_id: cap }));
      await twice('update', async () => owner.update(rid, { focus: 'same focus' }, { expected_version: await owner.version(rid) }));
      await owner.append(rid, { type: 'hypothesis', title: 'to be superseded' });
      const target = `TOK-${String((await owner.inspect(rid)).body.knowledge.items.length).padStart(3, '0')}`;
      await twice('supersede', async () => owner.supersede(rid, { target, reason: 'dup', replacement: { type: 'hypothesis', title: 'newer' } }, { expected_version: await owner.version(rid) }));
      await owner.append(rid, { type: 'task', title: 'hand me' });
      const taskId = `TOK-${String((await owner.inspect(rid)).body.knowledge.items.length).padStart(3, '0')}`;
      const z = w.actor('z', { session: 'session-z' });
      z.receive(rid, (await owner.delegate(rid, { to: { session_id: 'session-z' }, scopes: ['read'] })).body.result.capability.token);
      await twice('handoff', () => owner.handoff(rid, { tok_id: taskId, to: { session_id: 'session-z' } }));
      const ho = (await owner.inspect(rid)).body.handoffs.find((h: any) => h.status === 'pending').id;
      await twice('acknowledge', () => z.acknowledge(rid, { handoff_id: ho, decision: 'accept' }));
      const pending = (await owner.inspect(rid)).body.proposals.find((p: any) => p.status === 'pending').id;
      await twice('resolve_proposal', async () => owner.resolveProposal(rid, { proposal_id: pending, decision: 'reject' }, { expected_version: await owner.version(rid) }));
      await twice('close', async () => owner.close(rid, { reason: 'done' }, { expected_version: await owner.version(rid) }));
      for (const o of OPERATIONS.filter((x) => x.mutation)) {
        t.eq(observed[o.name], SEMANTICS[o.name].idempotency?.repeat, `${o.name}: declared "${SEMANTICS[o.name].idempotency?.repeat}", observed "${observed[o.name]}"`);
      }
    });
  },
};

