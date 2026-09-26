/**
 * Program 001 — identity, substrates, Scrolls and aliases.
 */
import { canonicalHash } from '../../src/continuity/canonical';
import { embeddedDocument } from '../client';
import type { Scenario } from '../scenario';
import { authorize, createIdentity, embodied, MULTIPLY } from './p001-common';

export const p001Identity: Scenario = {
  name: 'p001-identity',
  program: '001',
  description: 'Agent identity: create, retrieve, lifecycle; identity ≠ principal ≠ ownership ≠ session ≠ model ≠ substrate ≠ capability.',
  async run(w, t) {
    const f = await createIdentity(w, t, 'Agent X', { description: 'Program 001 subject', also_known_as: ['research-bot'] });
    const { rid, principal } = f;
    const a = w.actor('a', { session: 'session-a', agent: 'claude' });
    const b = w.actor('b', { session: 'session-b', agent: 'gpt' });

    await t.step('create and retrieve', async () => {
      const d = (await principal.inspect(rid)).body;
      t.eq(d.type, 'agent_identity', 'document type is agent_identity');
      t.eq(d.identity.agent_id, rid, 'agent_id is the resource id');
      t.eq([d.identity.status, d.identity.embodiment_status], ['active', 'unembodied'], 'active and unembodied');
      t.eq(d.identity.owner_principal, 'alice', 'human principal recorded');
      t.eq(d.identity.also_known_as, ['research-bot'], 'identity aliases (also_known_as)');
      t.eq(d.ownership.owner.session_id, 'principal-alice', 'the principal session owns the resource');
      t.check(d.identity.current_checkpoint?.number === 0, 'genesis checkpoint exists');
      t.check(d.identity_bootstrap?.steps?.length > 0, 'identity bootstrap present');
      const dims = Object.keys(d.identity.dimensions);
      t.eq(dims, ['agent_identity', 'human_principal', 'resource_ownership', 'session', 'model', 'application', 'substrate', 'capability', 'software_label'], 'all dimensions are listed separately');
      const idDoc = (await principal.getJson(`/r/${rid}/identity`)).body;
      t.eq([idDoc.type, idDoc.identity.agent_id], ['identity', rid], 'GET /identity');
      const html = await principal.openHtml(`/r/${rid}`);
      t.check(html.text.includes('<h1>AGENT IDENTITY</h1>') && embeddedDocument(html.text)?.identity?.agent_id === rid, 'HTML page renders and embeds the identity');
    });

    await t.step('continuity resources are unchanged (backward compatibility)', async () => {
      const cr = await principal.create({ title: 'Plain resource' });
      const cid = cr.body.resource_id;
      const d = (await principal.inspect(cid)).body;
      t.check(d.type === 'continuity_resource' && d.identity === undefined && d.scrolls === undefined, 'plain resources have no Program 001 sections');
      t.check(!d.operations.some((o: any) => o.name === 'execute'), 'identity operations are not offered on plain resources');
      t.status(await principal.op(cid, 'embody', {}), 409, 'embody on a plain resource', 'invalid_state');
      t.status(await principal.getJson(`/r/${cid}/identity`), 404, 'GET /identity on a plain resource', 'not_found');
      t.status(await principal.create({ title: 'x', also_known_as: ['y'] }), 422, 'also_known_as on a plain resource', 'invalid_payload');
      t.status(await principal.fork(rid, {}), 409, 'fork is not defined for agent identities', 'invalid_state');
    });

    await t.step('the principal authorizes but is not the agent', async () => {
      t.status(await principal.embody(rid), 403, 'owner capability cannot embody', 'insufficient_authority');
      t.status(await principal.createScroll(rid, MULTIPLY), 403, 'owner cannot act as the identity without embodiment', 'not_embodied');
    });

    let emb1 = '';
    await t.step('session A embodies with model m1', async () => {
      emb1 = (await embodied(t, f, a, { provider: 'anthropic', model_id: 'model-1' })).embodimentId;
      const d = (await a.inspect(rid)).body;
      t.eq(d.identity.current_session, { session_id: 'session-a' }, 'current session A');
      t.eq(d.identity.current_model, { provider: 'anthropic', model_id: 'model-1' }, 'current model m1 (declared)');
      t.eq(d.identity.agent_id, rid, 'agent_id unchanged');
      t.eq(d.viewer.embodied, true, 'viewer A is the embodiment');
      t.check(d.operations.find((o: any) => o.name === 'execute')?.permitted_for_viewer === true, 'A may execute');
    });

    await t.step('a capability is not embodiment; only one embodiment at a time', async () => {
      await authorize(t, f, b);
      t.status(await b.embody(rid), 409, 'B cannot embody while A does', 'invalid_state');
      t.status(await b.createScroll(rid, MULTIPLY), 403, 'B holds scope "scroll" but is not embodied', 'not_embodied');
      const d = (await b.inspect(rid)).body;
      t.eq([d.viewer.embodied, d.operations.find((o: any) => o.name === 'create_scroll').permitted_for_viewer], [false, false], 'B\'s document says so');
      t.status(await b.release(rid, { embodiment_id: emb1, reason: 'hostile' }), 403, 'B cannot release A\'s embodiment', 'insufficient_authority');
    });

    await t.step('session and model change; identity does not', async () => {
      t.status(await a.release(rid, { embodiment_id: emb1, reason: 'session ending' }), 200, 'A releases');
      t.status(await a.release(rid, { embodiment_id: emb1, reason: 'again' }), 409, 'double release', 'invalid_state');
      const e = await b.embody(rid, { model: { provider: 'openai', model_id: 'model-2' }, application: { application_id: 'chatgpt' } });
      t.status(e, 200, 'B embodies with model m2 in application chatgpt');
      const d = (await b.inspect(rid)).body;
      t.eq(d.identity.agent_id, rid, 'same agent_id after session change');
      t.eq(d.identity.current_model, { provider: 'openai', model_id: 'model-2' }, 'model changed');
      t.eq(d.identity.embodiments.map((x: any) => [x.id, x.session.session_id, x.status]), [['EMB-001', 'session-a', 'released'], ['EMB-002', 'session-b', 'active']], 'embodiment history');
      t.eq(d.identity.current_substrate.substrate_id, 'deterministic-calculator', 'substrate X (selected by A) persists across the session change');
      t.status(await b.setSubstrate(rid, 'exact-rational-calculator'), 200, 'substrate X → Y');
      const after = (await b.inspect(rid)).body;
      t.eq([after.identity.agent_id, after.identity.current_substrate.substrate_id], [rid, 'exact-rational-calculator'], 'same identity on a different substrate');
      const creates = (await b.getJson(`/r/${rid}/events`)).body.events.filter((x: any) => x.operation === 'create');
      t.eq(creates.length, 1, 'exactly one identity creation in the whole history');
      const tr = (await b.getJson(`/r/${rid}/transitions`)).body.transitions;
      const embodyB = tr.find((x: any) => x.operation === 'embody' && x.actor.session_id === 'session-b');
      t.eq(embodyB.observations, ['EMBODIMENT_ATTACHED', 'SESSION_CHANGED', 'MODEL_CHANGED', 'RECOVERY'], 'observations on the second embodiment');
    });

    await t.step('owner updates identity aliases; owner retires the identity', async () => {
      const v = await principal.version(rid);
      const u = await principal.update(rid, { also_known_as: ['research-bot', 'rb'] }, { expected_version: v });
      t.eq(u.body.result?.changes?.also_known_as?.to, ['research-bot', 'rb'], 'also_known_as change recorded with before/after');
      const v2 = await principal.version(rid);
      t.status(await principal.close(rid, { reason: 'experiment over' }, { expected_version: v2 }), 200, 'principal closes (retires) the identity');
      const d = (await principal.inspect(rid)).body;
      t.eq([d.identity.status, d.identity.embodiment_status], ['retired', 'unembodied'], 'retired; the embodiment was released');
      t.status(await b.createScroll(rid, MULTIPLY), 409, 'no mutation after retirement', 'resource_closed');
      t.status(await b.getJson(`/r/${rid}/identity`), 200, 'still readable');
    });
  },
};

export const p001Substrates: Scenario = {
  name: 'p001-substrates',
  program: '001',
  description: 'Substrate registry: discovery, machine-readable manifests and operation contracts, availability, selection failures.',
  async run(w, t) {
    const c = w.actor('crawler', { session: 'crawler' });
    await t.step('GET /substrates: every manifest is machine-readable', async () => {
      const r = (await c.getJson('/substrates')).body;
      t.eq(r.type, 'substrate_registry', 'registry document');
      t.eq(r.substrates.map((s: any) => [s.substrate_id, s.status]), [['deterministic-calculator', 'available'], ['exact-rational-calculator', 'available'], ['model-session', 'unavailable']], 'three substrates with status');
      for (const s of r.substrates) {
        t.check(s.kind && s.version && s.execution_mode && s.provenance?.implementation && /^sha256:/.test(s.manifest_sha256) && Array.isArray(s.capabilities), `${s.substrate_id}: manifest fields`);
        for (const o of s.operations) {
          t.check(
            o.name && o.description && o.input_schema && o.output_schema && o.required_authority && o.side_effects && o.determinism === 'deterministic' && o.arity === 2 && o.failure_modes.length,
            `${s.substrate_id}.${o.name}: complete operation contract`,
          );
        }
      }
      const calc = r.substrates[0];
      t.eq(calc.capabilities, ['add', 'subtract', 'multiply', 'divide', 'power', 'modulo'], 'calculator operation set');
      const one = (await c.getJson('/substrates/deterministic-calculator')).body;
      t.eq(one.manifest_sha256, calc.manifest_sha256, 'single manifest has the same hash');
      t.status(await c.getJson('/substrates/no-such-thing'), 404, 'unknown substrate', 'not_found');
      const html = await c.openHtml('/substrates');
      t.check(html.status === 200 && embeddedDocument(html.text)?.substrates?.length === 3, 'HTML registry embeds the same document');
      const proto = (await c.getJson('/protocol')).body;
      t.check(proto.program_001?.scroll_schema && proto.program_001?.observation_vocabulary?.RECOVERY, '/protocol documents Program 001 (Scroll schema, vocabulary)');
      const disc = (await c.getJson('/.well-known/acsp')).body;
      t.check(disc.endpoints.substrates?.endsWith('/substrates') && disc.extensions.includes('program-001'), 'discovery advertises substrates and the extension');
    });

    const f = await createIdentity(w, t);
    const a = w.actor('a', { session: 'session-a' });
    await embodied(t, f, a, null, null);
    await t.step('selection and availability failures', async () => {
      t.eq((await a.getJson(`/r/${f.rid}/substrates`)).body.current, null, 'no current substrate yet');
      t.status(await a.createScroll(f.rid, MULTIPLY), 200, 'a Scroll can be created without a selected substrate (nothing executes)');
      t.status(await a.execute(f.rid, { target: { scroll_id: 'SCR-001', version: 1 }, inputs: { a: 2, b: 3 } }), 409, 'execute with no substrate selected', 'invalid_state');
      t.status(await a.setSubstrate(f.rid, 'no-such-thing'), 404, 'select an unknown substrate', 'not_found');
      t.status(await a.setSubstrate(f.rid, 'model-session'), 409, 'select an unavailable substrate', 'substrate_unavailable');
      t.status(await a.setSubstrate(f.rid, null), 409, 'detach when nothing is attached', 'invalid_state');
      t.status(await a.setSubstrate(f.rid, 'deterministic-calculator'), 200, 'select the calculator');
      t.status(await a.setSubstrate(f.rid, 'deterministic-calculator'), 409, 'select it again', 'invalid_state');
      t.eq((await a.getJson(`/r/${f.rid}/substrates`)).body.current.substrate_id, 'deterministic-calculator', 'identity view shows the current substrate');
      t.status(await a.execute(f.rid, { target: { scroll_id: 'SCR-001', version: 1 }, inputs: { a: 2, b: 3 }, substrate_id: 'model-session' }), 409, 'execute on an unavailable substrate', 'substrate_unavailable');
      t.status(await a.execute(f.rid, { target: { scroll_id: 'SCR-001', version: 1 }, inputs: { a: 2, b: 3 }, substrate_id: 'nope' }), 404, 'execute on an unknown substrate', 'not_found');
      t.eq((await a.getJson(`/r/${f.rid}/executions`)).body.count, 0, 'refused executions record nothing');
      t.status(await a.setSubstrate(f.rid, null), 200, 'detach');
    });
  },
};

export const p001Scrolls: Scenario = {
  name: 'p001-scrolls',
  program: '001',
  description: 'Scrolls: create, validate, persist, retrieve, version, lineage, content hash, immutability, malformed/oversize, stale parent, concurrency.',
  async run(w, t) {
    const f = await createIdentity(w, t);
    const { rid } = f;
    const a = w.actor('a', { session: 'session-a' });
    await embodied(t, f, a, null);

    let v1: any;
    await t.step('create, retrieve and verify the content hash', async () => {
      const r = await a.createScroll(rid, MULTIPLY);
      t.status(r, 200, 'create SCR-001');
      v1 = r.body.result.scroll;
      t.eq([v1.scroll_id, v1.version, v1.parent_version, v1.ref], ['SCR-001', 1, null, 'SCR-001:v1'], 'id, version, lineage root');
      t.eq(v1.created_by.session_id, 'session-a', 'created_by the embodied session');
      t.check(!!v1.created_by.embodiment_id, 'embodiment recorded');
      const got = (await a.getJson(`/r/${rid}/scrolls/SCR-001?version=1`)).body.scroll;
      t.eq(got.content_sha256, canonicalHash(got.content), 'client recomputes content_sha256 from content');
      t.eq(got.content, v1.content, 'retrieved content equals committed content');
      t.eq(got.state, 'committed', 'state: committed (no checkpoint covers it yet)');
    });

    await t.step('version, lineage, immutability of earlier versions', async () => {
      const next = { ...MULTIPLY, purpose: 'multiply two values (v2: named output)', operations: [{ id: 'product', operation: 'multiply', arguments: ['a', 'b'] }], output: 'product' };
      const r = await a.versionScroll(rid, { scroll_id: 'SCR-001', parent_version: 1, scroll: next, reason: 'name the output' });
      t.status(r, 200, 'version_scroll → v2');
      t.eq([r.body.result.scroll.version, r.body.result.scroll.parent_version], [2, 1], 'v2 with parent v1');
      const stale = await a.versionScroll(rid, { scroll_id: 'SCR-001', parent_version: 1, scroll: { ...next, purpose: 'other' } });
      t.status(stale, 409, 'derive from a stale parent', 'stale_version');
      t.eq(stale.body.error.details, { scroll_id: 'SCR-001', expected: 1, current: 2 }, 'stale details');
      t.status(await a.versionScroll(rid, { scroll_id: 'SCR-001', parent_version: 2, scroll: next }), 409, 'identical content is not a new version', 'invalid_state');
      t.status(await a.versionScroll(rid, { scroll_id: 'SCR-404', parent_version: 1, scroll: next }), 404, 'unknown Scroll', 'not_found');
      const all = (await a.getJson(`/r/${rid}/scrolls/SCR-001`)).body;
      t.eq(all.versions.map((x: any) => [x.version, x.parent_version]), [[1, null], [2, 1]], 'lineage v1 → v2');
      t.eq(all.versions[0].content_sha256, v1.content_sha256, 'v1 is unchanged');
      if (w.env) {
        let refused = false;
        try {
          await w.env.db.query(`update scrolls set content = '{}' where resource_id = $1`, [rid]);
        } catch {
          refused = true;
        }
        t.check(refused, 'the database refuses UPDATE on committed Scroll versions');
      }
    });

    await t.step('composition: a Scroll that calls an explicit earlier version', async () => {
      const square = { purpose: 'square via multiply', inputs: ['x'], operations: [{ id: 'sq', scroll: { scroll_id: 'SCR-001', version: 1 }, arguments: ['x', 'x'] }] };
      const r = await a.createScroll(rid, square);
      t.status(r, 200, 'SCR-002 composes SCR-001:v1');
      t.eq(r.body.result.scroll.dependencies.scrolls, ['SCR-001:v1'], 'dependencies derived from content');
      t.status(await a.createScroll(rid, { ...square, operations: [{ scroll: { scroll_id: 'SCR-001', version: 9 }, arguments: ['x', 'x'] }] }), 422, 'call to a nonexistent version', 'invalid_payload');
      t.status(await a.createScroll(rid, { ...square, operations: [{ scroll: { scroll_id: 'SCR-001', version: 1 }, arguments: ['x'] }] }), 422, 'call with the wrong arity', 'invalid_payload');
    });

    await t.step('malformed and oversize Scrolls are refused', async () => {
      const bad = async (scroll: unknown, label: string, code = 'invalid_payload', status = 422) => t.status(await a.op(rid, 'create_scroll', { scroll }), status, label, code);
      await bad({ ...MULTIPLY, operations: [{ operation: 'teleport', arguments: ['a', 'b'] }] }, 'unknown operation');
      await bad({ ...MULTIPLY, operations: [{ operation: 'multiply', arguments: ['a', 'zz'] }] }, 'reference to an undefined name');
      await bad({ ...MULTIPLY, operations: [{ operation: 'multiply', arguments: ['a'] }] }, 'wrong arity');
      await bad({ ...MULTIPLY, operations: [{ substrate: 'no-such', operation: 'multiply', arguments: ['a', 'b'] }] }, 'unknown pinned substrate');
      await bad({ ...MULTIPLY, operations: [{ substrate: 'model-session', operation: 'multiply', arguments: ['a', 'b'] }] }, 'unavailable pinned substrate');
      await bad({ ...MULTIPLY, inputs: ['a', 'a'] }, 'duplicate input names');
      await bad({ ...MULTIPLY, operations: [] }, 'no operations');
      await bad({ ...MULTIPLY, code: 'process.exit()' }, 'unknown field (no code can be smuggled in)');
      await bad({ ...MULTIPLY, operations: [{ operation: 'multiply', arguments: ['a', 'b'], eval: '1' }] }, 'unknown step field');
      await bad({ ...MULTIPLY, output: 'nothing' }, 'undefined output');
      await bad('multiply', 'not an object');
      const long = (i: number) => `v${String(i).padStart(2, '0')}_${'x'.repeat(27)}`;
      const huge = {
        purpose: 'oversize',
        inputs: ['a', 'b'],
        operations: Array.from({ length: 64 }, (_, i) => ({ id: long(i), operation: 'add', arguments: i === 0 ? ['a', 'b'] : [long(i - 1), long(i - 1)] })),
        description: 'd'.repeat(2000),
        symbols: Object.fromEntries(Array.from({ length: 16 }, (_, i) => [`k${i}`, '7'.repeat(600)])),
      };
      await bad(huge, 'canonical size above 16 KiB');
      const body = a.envelope('create_scroll', { scroll: { ...MULTIPLY, description: 'x'.repeat(70_000) } });
      t.status(await w.client.postJson(`/r/${rid}/operations`, body, a.token(rid)), 413, 'request body above 64 KiB', 'payload_too_large');
      t.eq((await a.getJson(`/r/${rid}/scrolls`)).body.scrolls.length, 2, 'no Scroll was created by any refused request');
    });

    await t.step('concurrent creation and concurrent versioning', async () => {
      const made = await Promise.all(Array.from({ length: 8 }, (_, i) => a.createScroll(rid, { ...MULTIPLY, purpose: `parallel ${i}` })));
      t.check(made.every((r) => r.status === 200), '8 parallel creates succeed');
      t.eq(new Set(made.map((r) => r.body.result.scroll.scroll_id)).size, 8, 'distinct Scroll ids');
      const ver = await Promise.all(
        Array.from({ length: 6 }, (_, i) => a.versionScroll(rid, { scroll_id: 'SCR-003', parent_version: 1, scroll: { ...MULTIPLY, purpose: `branch ${i}` } })),
      );
      t.eq(ver.filter((r) => r.status === 200).length, 1, 'exactly one of 6 parallel versions from the same parent wins');
      t.eq(ver.filter((r) => r.status === 409 && r.body.error.code === 'stale_version').length, 5, 'the rest get stale_version');
    });

    await t.step('a checkpoint moves committed Scrolls to persisted', async () => {
      t.status(await a.checkpoint(rid, { label: 'scrolls' }), 200, 'checkpoint');
      const s = (await a.getJson(`/r/${rid}/scrolls/SCR-001?version=2`)).body.scroll;
      t.eq([s.state, s.persisted_in_checkpoint], ['persisted', 1], 'state: persisted in checkpoint 1');
    });
  },
};

export const p001Aliases: Scenario = {
  name: 'p001-aliases',
  program: '001',
  description: 'Aliases: bind, resolve, rebind with history, explicit versions only, stale/concurrent changes, authority.',
  async run(w, t) {
    const f = await createIdentity(w, t);
    const { rid } = f;
    const a = w.actor('a', { session: 'session-a' });
    await embodied(t, f, a, null);
    await a.createScroll(rid, MULTIPLY);
    await a.versionScroll(rid, { scroll_id: 'SCR-001', parent_version: 1, scroll: { ...MULTIPLY, purpose: 'multiply (v2)' } });

    await t.step('bind and resolve', async () => {
      t.status(await a.setAlias(rid, { name: 'multiply', target: { scroll_id: 'SCR-001', version: 1 } }), 400, 'expected_version is required', 'missing_expected_version');
      const r = await a.setAlias(rid, { name: 'multiply', target: { scroll_id: 'SCR-001', version: 1 } }, { expected_version: await a.version(rid) });
      t.status(r, 200, 'bind "multiply" → SCR-001:v1');
      t.eq([r.body.result.alias.binding, r.body.result.alias.previous], [1, null], 'first binding');
      const res = (await w.client.getJson(`/r/${rid}/aliases/multiply`)).body;
      t.eq(res.alias.target.ref, 'SCR-001:v1', 'resolves (with no credential) to an explicit version');
      t.status(await a.setAlias(rid, { name: 'multiply', target: { scroll_id: 'SCR-001', version: 1 } }, { expected_version: await a.version(rid) }), 409, 'rebinding to the same version', 'invalid_state');
      t.status(await a.setAlias(rid, { name: 'ghost', target: { scroll_id: 'SCR-009', version: 1 } }, { expected_version: await a.version(rid) }), 404, 'alias to a nonexistent Scroll', 'not_found');
      t.status(await a.setAlias(rid, { name: 'Bad Name', target: { scroll_id: 'SCR-001', version: 1 } }, { expected_version: await a.version(rid) }), 422, 'invalid alias name', 'invalid_payload');
    });

    await t.step('rebind keeps history and never mutates Scroll versions', async () => {
      const before = (await a.getJson(`/r/${rid}/scrolls/SCR-001?version=1`)).body.scroll.content_sha256;
      const v = await a.version(rid);
      const r = await a.setAlias(rid, { name: 'multiply', target: { scroll_id: 'SCR-001', version: 2 }, reason: 'v2' }, { expected_version: v });
      t.eq([r.body.result.alias.binding, r.body.result.alias.previous], [2, 'SCR-001:v1'], 'binding 2, previous recorded');
      const res = (await a.getJson(`/r/${rid}/aliases/multiply`)).body.alias;
      t.eq(res.history.map((h: any) => h.target.ref), ['SCR-001:v1', 'SCR-001:v2'], 'history v1 → v2');
      t.eq((await a.getJson(`/r/${rid}/scrolls/SCR-001?version=1`)).body.scroll.content_sha256, before, 'SCR-001:v1 unchanged');
      t.status(await a.setAlias(rid, { name: 'multiply', target: { scroll_id: 'SCR-001', version: 1 } }, { expected_version: v }), 409, 'stale expected_version', 'stale_version');
      const tr = (await a.getJson(`/r/${rid}/transitions`)).body.transitions.filter((x: any) => x.operation === 'set_alias');
      t.eq(tr.map((x: any) => x.observations[0]), ['ALIAS_CREATED', 'ALIAS_REBOUND'], 'observations');
      if (w.env) {
        let refused = false;
        try {
          await w.env.db.query(`delete from alias_bindings where resource_id = $1`, [rid]);
        } catch {
          refused = true;
        }
        t.check(refused, 'the database refuses DELETE on alias bindings');
      }
    });

    await t.step('concurrent alias changes: exactly one wins', async () => {
      const v = await a.version(rid);
      const rs = await Promise.all([1, 2, 1, 2, 1].map((ver, i) => a.setAlias(rid, { name: `race`, target: { scroll_id: 'SCR-001', version: ver }, reason: `r${i}` }, { expected_version: v })));
      t.eq(rs.filter((r) => r.status === 200).length, 1, 'one succeeds');
      t.eq(rs.filter((r) => r.status === 409).length, 4, 'four stale_version');
    });

    await t.step('authority over aliases', async () => {
      const b = w.actor('b', { session: 'session-b' });
      await authorize(t, f, b, ['alias']);
      const v = await a.version(rid);
      t.status(await b.setAlias(rid, { name: 'multiply', target: { scroll_id: 'SCR-001', version: 1 } }, { expected_version: v }), 403, 'alias scope but not embodied', 'not_embodied');
      const c = w.actor('c', { session: 'session-c' });
      await authorize(t, f, c, ['execute']);
      t.status(await c.setAlias(rid, { name: 'multiply', target: { scroll_id: 'SCR-001', version: 1 } }, { expected_version: v }), 403, 'wrong scope', 'insufficient_authority');
      t.status(await w.actor('anon').setAlias(rid, { name: 'multiply', target: { scroll_id: 'SCR-001', version: 1 } }, { expected_version: v }), 401, 'no capability', 'authentication_required');
      t.eq((await a.getJson(`/r/${rid}/aliases/multiply`)).body.alias.target.ref, 'SCR-001:v2', 'alias unchanged by refused attempts');
    });
  },
};
