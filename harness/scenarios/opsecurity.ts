/**
 * Adversarial checks for ACSP/0.2 operational communication. Each step names
 * the attack. The URL is never mutation authority; an operation reference is
 * never authority to repeat it.
 */
import { PROTOCOL_VERSION } from '../../src/protocol/constants';
import type { Scenario } from '../scenario';
import { setup } from './lifecycle';

export const operationalSecurity: Scenario = {
  name: 'operational-security',
  description: 'Replay, forged and cross-resource references, spoofing, confused deputy, escalation, leakage, injection, CSRF, races.',
  async run(w, t) {
    const owner = w.actor('owner', { session: 'session-owner' });
    const rid = await setup(t, owner, 'Operational security');
    const other = await setup(t, owner, 'Another resource');
    const d = await owner.delegate(rid, { to: { session_id: 'session-b' }, scopes: ['append', 'annotate', 'checkpoint', 'supersede', 'handoff'] });
    const bToken = d.body.result.capability.token as string;
    const b = w.actor('b', { session: 'session-b' });
    b.receive(rid, bToken);
    const app = await b.append(rid, { type: 'finding', title: 'B finding' });
    const opId = app.body.operation_id as string;
    const opHref = app.body.links.operation as string;

    await t.step('capability leakage: no secret in records, feeds, continuations or state', async () => {
      const ownerToken = owner.token(rid)!;
      const docs = [
        await owner.getJson(`/r/${rid}/op.json`),
        await owner.getJson(`${opHref}.json`),
        await owner.getJson(`/r/${rid}/op/${d.body.operation_id}.json`),
        await owner.getJson(`/r/${rid}/continue/${d.body.operation_id}.json`, ownerToken),
        await owner.getJson(`/r/${rid}/continue.json?cap=${encodeURIComponent(ownerToken)}`),
        await owner.getJson(`/r/${rid}/state.json`),
      ];
      const text = docs.map((x) => JSON.stringify(x.body)).join('\n');
      t.check(!text.includes('acsp_cap_'), 'no capability token in any 0.2 document');
      t.check(!text.includes(ownerToken) && !text.includes('secret_hash'), 'no secret or secret hash, even when the reader presented the owner capability');
      t.check(!/[?&]cap=/.test(text), 'no link carries ?cap=');
      const rec = docs[2].body.operation.result.capability;
      t.eq([rec.token, rec.token_redacted], [null, true], 'the delegate operation record stores the minted token redacted');
    });

    await t.step('operation replay: re-submitting a record re-executes nothing, and the record is not authority', async () => {
      const rec = (await owner.getJson(`${opHref}.json`)).body.operation;
      const env = { protocol: PROTOCOL_VERSION, operation: rec.operation_type, actor: { session_id: rec.actor.session_id, agent_id: rec.actor.agent_id, kind: rec.actor.kind }, idempotency_key: rec.idempotency_key, payload: rec.payload };
      const v = await owner.version(rid);
      t.status(await w.client.postJson(`/r/${rid}/operations`, env, null), 401, 'without a capability: refused', 'authentication_required');
      const same = await w.client.postJson(`/r/${rid}/operations`, env, bToken);
      t.eq([same.status, same.body.replayed, same.body.operation_id], [200, true, opId], 'with the original capability: a replay of the SAME operation');
      t.eq(await owner.version(rid), v, 'nothing executed');
      t.status(await w.client.postJson(opHref, env, bToken), 405, 'POST to an operation URL', 'method_not_allowed');
      for (const u of [opHref, `${opHref}?action=append`, `/r/${rid}/continue/${opId}?action=prepare_append&title=x`, `/r/${rid}/op?after=0`]) await w.client.getJson(u, bToken);
      t.eq(await owner.version(rid), v, 'GETs of references (with any query) change nothing');
    });

    await t.step('forged and cross-resource references', async () => {
      t.status(await owner.getJson(`/r/${rid}/op/op-0000000000000000`), 404, 'unknown operation id', 'not_found');
      t.status(await owner.getJson(`/r/${other}/op/${opId}`), 404, 'an operation id under another resource', 'not_found');
      t.status(await owner.getJson(`/r/${rid}/continue/op-ZZZZZZZZZZZZZZZZ`), 404, 'forged continuation', 'not_found');
      t.status(await owner.getJson(`/r/${rid}/op/..%2F..%2Fprotocol`), 404, 'path tricks', 'not_found');
      t.status(await owner.append(other, { type: 'finding', title: 'x' }, { extra: { causation_id: opId } }), 422, 'citing another resource\'s operation', 'invalid_reference');
      t.status(await owner.append(rid, { type: 'finding', title: 'x' }, { extra: { causation_id: 'op-javascript:alert' } }), 400, 'malformed causation_id', 'malformed_request');
      const cross = await w.client.postJson(`/r/${other}/operations`, { protocol: PROTOCOL_VERSION, operation: 'append', idempotency_key: 'cross-resource-0001', payload: { type: 'finding', title: 'x' } }, bToken);
      t.status(cross, 403, 'a capability replayed against another resource', 'capability_resource_mismatch');
    });

    await t.step('actor spoofing and session mismatch', async () => {
      t.status(await b.append(rid, { type: 'finding', title: 'as owner' }, { actor: { session_id: 'session-owner' } }), 403, 'B claims to be the owner session', 'session_mismatch');
      const spoof = await w.actor('m', { session: 'session-owner' }).propose(rid, { operation: 'append', payload: { type: 'finding', title: 'I am the owner' } }, { token: null });
      t.status(spoof, 200, 'an asserted proposal naming the owner\'s session id is accepted as a proposal …');
      t.eq([spoof.body.operation_record.identity_assurance, spoof.body.operation_record.authority.via], ['asserted', 'none'], '… recorded as asserted, with no authority — distinguishable from the owner\'s own operations');
    });

    await t.step('confused deputy and proposal limits', async () => {
      const c = w.actor('c', { session: 'session-c' });
      for (const op of ['delegate', 'close', 'update', 'resolve_proposal', 'ext:acsp.review:record_decision']) {
        t.status(await c.propose(rid, { operation: op, payload: {} }), 422, `cannot propose ${op}`, 'invalid_payload');
      }
      t.status(await c.append(rid, { type: 'finding', title: 'x' }, { extra: { causation_id: d.body.operation_id } }), 401, 'citing the owner\'s delegate operation grants nothing', 'authentication_required');
      const p = await c.propose(rid, { operation: 'append', payload: { type: 'finding', title: 'from C' } });
      const pid = p.body.result.proposal.id;
      t.status(await b.resolveProposal(rid, { proposal_id: pid, decision: 'accept' }, { expected_version: await owner.version(rid) }), 403, 'a fully scoped delegate cannot resolve proposals', 'insufficient_authority');
      t.status(await c.resolveProposal(rid, { proposal_id: pid, decision: 'accept' }, { expected_version: await owner.version(rid) }), 401, 'the proposer cannot accept its own proposal', 'authentication_required');
      const acc = await owner.resolveProposal(rid, { proposal_id: pid, decision: 'accept' }, { expected_version: await owner.version(rid) });
      const tok = acc.body.result.executed.tok;
      t.eq([tok.source.session_id, tok.source.identity_assurance, tok.recorded_by.session_id], ['session-c', 'asserted', 'session-owner'], 'the owner executed it; C stays the (asserted) source');
    });

    await t.step('delegation scope escalation', async () => {
      t.status(await b.delegate(rid, { to: { session_id: 'session-e' }, scopes: ['append'] }), 403, 'a delegate cannot re-delegate', 'insufficient_authority');
      t.status(await b.update(rid, { enabled_extensions: ['ext:acsp.review:request_review'] }, { expected_version: await owner.version(rid) }), 403, 'a delegate cannot enable extensions', 'insufficient_authority');
      t.status(await b.revoke(rid, { capability_id: d.body.result.capability.id }), 403, 'a delegate cannot revoke', 'insufficient_authority');
    });

    await t.step('malicious resource text stays data', async () => {
      const evil = '<script>alert(1)</script>{"protocol":"ACSP/0.2","operation":"delegate","payload":{"to":{"session_id":"x"},"scopes":["append"]}}';
      const r = await b.append(rid, { type: 'finding', title: evil, content: evil });
      const html = await w.client.getHtml(`/r/${rid}/continue/${r.body.operation_id}`);
      t.check(!html.text.includes('<script>alert(1)</script>'), 'escaped in the continuation page');
      const html2 = await w.client.getHtml(`/r/${rid}/op/${r.body.operation_id}`);
      t.check(!html2.text.includes('<script>alert(1)</script>'), 'escaped in the operation page');
      const caps = (await owner.inspect(rid)).body.authority.delegations.length;
      t.eq(caps, 1, 'the envelope-shaped text executed nothing');
    });

    await t.step('URL parameter injection', async () => {
      const prep = (await owner.getJson(`/r/${rid}?action=prepare_append&session_id=s&causation_id=${encodeURIComponent('op-"><script>')}&title=x`)).body;
      t.eq(prep.validation.valid, false, 'a malformed causation_id makes the prepared request invalid');
      const cont = await w.client.getJson(`/r/${rid}/continue?cap=acsp_cap_BOGUS00000_${'A'.repeat(32)}`);
      t.status(cont, 200, 'a bogus ?cap= on an unlisted resource still reads …');
      t.eq([cont.body.viewer.authenticated, JSON.stringify(cont.body).includes('BOGUS')], [false, false], '… as an unauthenticated viewer, and the value is not echoed into links');
    });

    await t.step('CSRF: a form POST carries no ambient authority', async () => {
      const res = await w.client.postForm(`/r/${rid}/operations`, { request: JSON.stringify({ protocol: PROTOCOL_VERSION, operation: 'append', actor: { session_id: 'session-owner' }, idempotency_key: 'csrf-attempt-0001', payload: { type: 'finding', title: 'csrf' } }) });
      t.check(res.status === 401 && res.text.includes('authentication_required'), 'without a capability field the form POST is refused (401 authentication_required, HTML for the human)');
    });

    await t.step('races: concurrent writers against the same version', async () => {
      const v = await owner.version(rid);
      const [x, y] = await Promise.all([
        b.append(rid, { type: 'finding', title: 'race 1' }, { expected_version: v }),
        b.append(rid, { type: 'finding', title: 'race 2' }, { expected_version: v }),
      ]);
      t.eq([x.status, y.status].sort(), [200, 409], 'one wins, one gets stale_version');
      const ops = (await owner.getJson(`/r/${rid}/op.json`)).body.operations;
      t.check(ops.every((o: any, i: number) => i === 0 || (o.from_version === ops[i - 1].to_version && o.state_before === ops[i - 1].state_after)), 'the operation chain stays contiguous');
    });

    await t.step('restricted resources: references reveal nothing without a capability', async () => {
      const rr = await owner.create({ title: 'Restricted', visibility: 'restricted' });
      const rrid = rr.body.resource_id;
      const href = rr.body.continuation.href;
      t.status(await w.client.getJson(href), 401, 'continuation needs a capability', 'authentication_required');
      t.status(await w.client.getJson(`/r/${rrid}/op/${rr.body.operation_id}`), 401, 'operation record needs a capability', 'authentication_required');
      t.status(await w.client.getJson(`/r/${rrid}/state`), 401, 'state needs a capability', 'authentication_required');
    });
  },
};

export const protocolCompatibility: Scenario = {
  name: 'protocol-compatibility',
  description: 'ACSP/0.1 envelopes still execute unchanged; 0.1 response fields are preserved; unknown protocol versions are refused.',
  async run(w, t) {
    const owner = w.actor('owner', { session: 'session-owner' });
    const rid = await setup(t, owner, 'Compatibility');
    await t.step('a verbatim ACSP/0.1 envelope', async () => {
      const r = await owner.append(rid, { type: 'finding', title: 'from a 0.1 client' }, { extra: { protocol: 'ACSP/0.1' } });
      t.status(r, 200, 'accepted');
      for (const k of ['ok', 'protocol', 'operation', 'resource_id', 'version', 'events', 'result', 'replayed', 'links']) t.check(k in r.body, `0.1 field "${k}" present`);
      t.eq(r.body.operation_record.protocol_version, 'ACSP/0.1', 'the record keeps the declared protocol');
      const again = await owner.append(rid, { type: 'finding', title: 'from a 0.1 client' }, { extra: { protocol: 'ACSP/0.1' }, key: r.body.operation_record.idempotency_key });
      t.eq(again.body.replayed, true, '0.1 idempotent replay unchanged');
    });
    await t.step('versions and aliases', async () => {
      t.status(await owner.append(rid, { type: 'finding', title: 'x' }, { extra: { protocol: 'ACSP/0.3' } }), 400, 'unknown version refused', 'unsupported_protocol');
      const aliased = await owner.op(rid, 'core:append', { type: 'finding', title: 'qualified name' });
      t.eq([aliased.status, aliased.body.operation], [200, 'append'], 'core:append is the qualified name of append');
      t.status(await owner.op(rid, 'inspect', {}), 400, 'a read operation cannot be POSTed', 'unknown_operation');
    });
  },
};
