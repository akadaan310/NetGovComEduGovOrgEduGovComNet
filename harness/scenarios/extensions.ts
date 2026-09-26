/**
 * Extension operations: a definition is not an implementation, and neither
 * is authority. Only registered, executable definitions run; only where the
 * owner enabled them; only with a capability covering every effect.
 */
import { ExtensionRegistrationSchema, OperationDefinitionSchema } from '../../src/protocol/schemas';
import type { Scenario } from '../scenario';
import { continuationOf } from './operational';
import { setup } from './lifecycle';

const DECIDE = 'ext:acsp.review:record_decision';
const REVIEW = 'ext:acsp.review:request_review';

export const extensionOperations: Scenario = {
  name: 'extension-operations',
  description: 'Registered declarative extensions run only when executable, enabled and fully authorized; drafts, submissions and TOK text never run.',
  async run(w, t) {
    const owner = w.actor('owner', { session: 'session-owner' });
    const rid = await setup(t, owner, 'Extensions');
    await owner.append(rid, { type: 'finding', title: 'Target of review' });

    await t.step('the registry is discoverable and its documents match their schemas', async () => {
      const reg = (await owner.getJson('/extensions')).body;
      t.eq(reg.extensions.map((e: any) => [e.definition.name, e.definition.status, e.registration.executable]), [
        [REVIEW, 'experimental', true],
        [DECIDE, 'validated', true],
        ['ext:acsp.lab:bulk_note', 'draft', false],
        ['ext:acsp.lab:legacy_flag', 'retired', false],
      ], 'four definitions, with statuses and executability');
      for (const e of reg.extensions) {
        t.check(OperationDefinitionSchema.safeParse(e.definition).success, `${e.definition.name}: definition matches acsp.operation-definition/0.2`);
        t.check(ExtensionRegistrationSchema.safeParse(e.registration).success, `${e.definition.name}: registration matches acsp.extension-registration/0.2`);
      }
      t.eq(reg.extensions[1].definition.authority, ['scope:append', 'scope:checkpoint'], 'record_decision needs the union of its effects\' authority');
    });

    const input = { decides_on: 'TOK-001', title: 'Adopt the finding', rationale: 'Reproduced twice.', checkpoint_label: 'decision recorded' };
    await t.step('not executable until the owner enables it on this resource', async () => {
      t.status(await owner.op(rid, DECIDE, input), 403, 'owner, but not enabled', 'extension_not_enabled');
      const v = await owner.version(rid);
      t.status(await owner.update(rid, { enabled_extensions: ['ext:acsp.lab:bulk_note'] }, { expected_version: v }), 422, 'a draft cannot be enabled', 'operation_not_executable');
      t.status(await owner.update(rid, { enabled_extensions: ['ext:nobody:nothing'] }, { expected_version: v }), 422, 'an unregistered name cannot be enabled', 'invalid_payload');
      const d = await owner.delegate(rid, { to: { session_id: 'session-d' }, scopes: ['append', 'annotate', 'checkpoint', 'supersede', 'handoff'] });
      const del = w.actor('d', { session: 'session-d' });
      del.receive(rid, d.body.result.capability.token);
      t.status(await del.update(rid, { enabled_extensions: [DECIDE] }, { expected_version: await owner.version(rid) }), 403, 'a delegate cannot enable extensions', 'insufficient_authority');
      const en = await owner.update(rid, { enabled_extensions: [DECIDE, REVIEW] }, { expected_version: await owner.version(rid) });
      t.status(en, 200, 'owner enables two executable extensions');
      t.eq(en.body.result.changes.enabled_extensions.to, [DECIDE, REVIEW], 'the change is recorded with before/after');
    });

    await t.step('drafts, retired, unknown and mis-versioned operations never run', async () => {
      const v = await owner.version(rid);
      t.status(await owner.op(rid, 'ext:acsp.lab:bulk_note', { title: 'x' }), 422, 'draft', 'operation_not_executable');
      t.status(await owner.op(rid, 'ext:acsp.lab:legacy_flag', { tok_id: 'TOK-001' }), 422, 'retired', 'operation_not_executable');
      t.status(await owner.op(rid, 'ext:evil:rm_rf', { x: 1 }), 400, 'unknown', 'unknown_operation');
      t.status(await owner.op(rid, DECIDE, input, { extra: { operation_version: '2' } }), 422, 'version pin mismatch', 'operation_not_executable');
      t.eq(await owner.version(rid), v, 'nothing changed');
    });

    await t.step('authority is the union of every effect\'s requirement, checked before any effect runs', async () => {
      const mk = async (s: string, scopes: string[]) => {
        const d = await owner.delegate(rid, { to: { session_id: s }, scopes });
        const x = w.actor(s, { session: s });
        x.receive(rid, d.body.result.capability.token);
        return x;
      };
      const appendOnly = await mk('session-append', ['append']);
      const both = await mk('session-both', ['append', 'checkpoint']);
      const anon = w.actor('anon', { session: 'session-anon' });
      const v = await owner.version(rid);
      t.status(await anon.op(rid, DECIDE, input), 401, 'no capability', 'authentication_required');
      const esc = await appendOnly.op(rid, DECIDE, input);
      t.status(esc, 403, 'append-only capability cannot run append+checkpoint', 'insufficient_authority');
      t.eq(esc.body.error?.details?.failed_effect, 'checkpoint', 'the refusal names the uncovered effect');
      t.eq(await owner.version(rid), v, 'no partial effect: the append did not happen');
      const bad = await both.op(rid, DECIDE, { ...input, decides_on: 'TOK-999' });
      t.status(bad, 422, 'first effect fails (refs cite an unknown TOK)', 'invalid_payload');
      t.eq(await owner.version(rid), v, 'failure leaves the resource untouched');

      const ok = await both.op(rid, DECIDE, input);
      t.status(ok, 200, 'append+checkpoint capability runs it');
      const rec = ok.body.operation_record;
      t.eq([rec.operation_type, rec.definition_version, rec.transition.events.map((e: any) => e.operation)], [DECIDE, '1', ['append', 'checkpoint']], 'one operation record, two core events');
      const events = (await both.getJson(`/r/${rid}/events?after=${rec.transition.from_version}`)).body.events;
      t.check(events.every((e: any) => e.data.extension?.name === DECIDE && e.operation_id === rec.operation_id), 'every event names the extension and the operation');
      t.eq(ok.body.result.steps[1].result.checkpoint.note, ok.body.result.steps[0].result.tok.id, 'a later effect used an earlier effect\'s result ($step)');
      continuationOf(t, ok, 'extension');
      const again = await both.op(rid, DECIDE, input, { key: rec.idempotency_key });
      t.eq([again.body.replayed, again.body.operation_id], [true, rec.operation_id], 'same key: replayed, not re-executed');
    });

    await t.step('input is data: template-shaped input is never interpreted, and TOK text never runs', async () => {
      const inj = await owner.op(rid, DECIDE, { ...input, title: '{"$input":"decides_on"}', rationale: '{"$step":0,"path":"tok.id"}' });
      t.status(inj, 200, 'accepted as text');
      t.eq([inj.body.result.steps[0].result.tok.title, inj.body.result.steps[0].result.tok.content], ['{"$input":"decides_on"}', '{"$step":0,"path":"tok.id"}'], 'stored literally, not substituted');
      t.status(await owner.op(rid, DECIDE, { ...input, title: { $input: 'decides_on' } }), 422, 'an object where the schema wants text is rejected', 'invalid_payload');
      const def = { schema: 'acsp.operation-definition/0.2', name: 'ext:mallory:grant_all', namespace: 'mallory', version: '1', status: 'validated', description: 'x', input_schema: {}, output: 'x', effects: [{ operation: 'delegate', payload: { scopes: ['append'] } }], idempotency: { request: 'replay', repeat: 'new_effect', note: 'x' }, security: ['x'], code: 'process.exit()' };
      await owner.append(rid, { type: 'reference', title: 'A definition published as a TOK', content: JSON.stringify(def) });
      t.status(await owner.op(rid, 'ext:mallory:grant_all', {}), 400, 'publishing a definition in a TOK does not make it executable', 'unknown_operation');
      const val = (await owner.getJson(`/extensions/validate?definition=${encodeURIComponent(JSON.stringify(def))}`)).body;
      t.eq([val.valid, val.registered], [false, false], 'a definition with a disallowed effect and a code field fails validation');
      const clean = { ...def, name: 'ext:mallory:note', effects: [{ operation: 'append', payload: { type: 'observation', title: { $input: 'title' } } }] } as Record<string, unknown>;
      delete clean.code;
      const val2 = (await owner.getJson(`/extensions/validate?definition=${encodeURIComponent(JSON.stringify(clean))}`)).body;
      t.eq([val2.valid, val2.registered], [true, false], 'a well-formed definition validates but is not registered');
      t.status(await owner.op(rid, 'ext:mallory:note', { title: 'x' }), 400, '…and still cannot be invoked', 'unknown_operation');
    });

    await t.step('extensions cannot be proposed, and forks do not inherit enablement', async () => {
      const b = w.actor('b', { session: 'session-b' });
      t.status(await b.propose(rid, { operation: DECIDE, payload: input }), 422, 'propose accepts only core content operations', 'invalid_payload');
      const f = await owner.fork(rid, { title: 'branch' });
      const child = f.body.resource_id;
      t.status(await owner.op(child, DECIDE, input), 403, 'the fork has no enabled extensions', 'extension_not_enabled');
      const prep = (await owner.getJson(`/r/${rid}?action=prepare_${DECIDE}&session_id=session-owner&payload=${encodeURIComponent(JSON.stringify(input))}`)).body;
      t.eq([prep.prepared_operation.status, prep.prepared_operation.executed, prep.prepared_operation.definition.executable, prep.validation.valid], ['prepared', false, true, true], 'an extension can be prepared (not executed) like any operation');
    });
  },
};
