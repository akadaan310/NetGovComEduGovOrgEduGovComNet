import type { Scenario } from '../scenario';
import { setup } from './lifecycle';

export const authorityMatrix: Scenario = {
  name: 'authority-matrix',
  description: 'read ≠ write, write ≠ ownership, ownership ≠ universal authority; only the owner delegates.',
  async run(w, t) {
    const a = w.actor('a', { session: 'session-a' });
    const reader = w.actor('reader', { session: 'session-r' });
    const writer = w.actor('writer', { session: 'session-w' });
    const stranger = w.actor('stranger', { session: 'session-s' });
    const rid = await setup(t, a, 'Authority');
    await a.append(rid, { type: 'task', title: 'Owned by A' });

    await t.step('owner delegates read-only and append capabilities', async () => {
      const r = await a.delegate(rid, { to: { session_id: 'session-r' }, scopes: ['read'] });
      t.status(r, 200, 'delegate [read]');
      reader.receive(rid, r.body.result.capability.token);
      const wr = await a.delegate(rid, { to: { session_id: 'session-w' }, scopes: ['append'] });
      writer.receive(rid, wr.body.result.capability.token);
    });

    await t.step('read ≠ write', async () => {
      t.status(await reader.inspect(rid), 200, 'reader reads');
      t.status(await reader.append(rid, { type: 'finding', title: 'x' }), 403, 'reader appends', 'insufficient_authority');
    });

    await t.step('write ≠ ownership', async () => {
      t.status(await writer.append(rid, { type: 'finding', title: 'Writer finding' }), 200, 'writer appends');
      t.status(await writer.annotate(rid, { tok_id: 'TOK-001', kind: 'comment', content: 'x' }), 403, 'writer annotates (scope missing)', 'insufficient_authority');
      t.status(await writer.checkpoint(rid, { label: 'x' }), 403, 'writer checkpoints', 'insufficient_authority');
      const v = await writer.version(rid);
      t.status(await writer.update(rid, { title: 'Mine now' }, { expected_version: v }), 403, 'writer updates metadata', 'insufficient_authority');
      t.status(await writer.delegate(rid, { to: { session_id: 'session-x' }, scopes: ['append'] }), 403, 'writer delegates (non-owner cannot delegate)', 'insufficient_authority');
      t.status(await writer.close(rid, { reason: 'x' }, { expected_version: v }), 403, 'writer closes', 'insufficient_authority');
      t.status(await writer.handoff(rid, { tok_id: 'TOK-001', to: { session_id: 'session-w' } }), 403, 'writer hands off A\'s task', 'insufficient_authority');
    });

    await t.step('no capability: can read, propose, fork — nothing else', async () => {
      t.status(await stranger.inspect(rid), 200, 'stranger reads (unlisted)');
      t.status(await stranger.append(rid, { type: 'finding', title: 'x' }), 401, 'stranger appends', 'authentication_required');
      t.status(await stranger.delegate(rid, { to: { session_id: 'session-s' }, scopes: ['append'] }), 401, 'stranger delegates to itself', 'authentication_required');
      t.status(await stranger.propose(rid, { operation: 'append', payload: { type: 'question', title: 'May I?' } }), 200, 'stranger proposes');
      t.status(await stranger.fork(rid, {}), 201, 'stranger forks');
    });

    await t.step('ownership ≠ universal authority', async () => {
      const ho = await a.handoff(rid, { tok_id: 'TOK-001', to: { session_id: 'session-w' } });
      t.status(ho, 200, 'owner hands off its task to session-w');
      t.status(await a.acknowledge(rid, { handoff_id: 'HO-001', decision: 'accept' }), 403, 'owner acknowledges on session-w\'s behalf', 'insufficient_authority');
      const other = await setup(t, stranger, 'Stranger resource');
      t.status(await a.append(other, { type: 'finding', title: 'x' }, { token: a.token(rid) }), 403, 'owner capability used on another resource', 'capability_resource_mismatch');
      const revokeOwn = await a.revoke(rid, { capability_id: (await a.inspect(rid)).body.authority.owner_capability.id });
      t.status(revokeOwn, 409, 'owner revokes its own owner capability', 'invalid_state');
      t.check(!(await a.inspect(rid)).body.operations.some((o: any) => ['delete', 'rewrite', 'edit_event'].includes(o.name)), 'no operation exists to rewrite history');
    });

    await t.step('revocation takes effect immediately', async () => {
      const capId = (await a.inspect(rid)).body.authority.delegations.find((d: any) => d.session_id === 'session-w').id;
      t.status(await a.revoke(rid, { capability_id: capId, reason: 'done' }), 200, 'owner revokes writer');
      t.status(await writer.append(rid, { type: 'finding', title: 'after revoke' }), 401, 'revoked capability', 'capability_revoked');
      t.status(await a.revoke(rid, { capability_id: capId }), 409, 'revoke twice', 'invalid_state');
    });
  },
};
