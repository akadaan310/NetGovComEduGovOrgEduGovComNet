import { PROTOCOL_VERSION } from '../../src/protocol/constants';
import { OPERATIONS } from '../../src/protocol/operations';
import { alternateJsonHref, embeddedDocument } from '../client';
import type { Scenario } from '../scenario';
import { setup } from './lifecycle';

export const failures: Scenario = {
  name: 'failures',
  description: 'Invalid resource/operation/payload, stale version, replay, key reuse, expired/revoked/forged capabilities, spoofing, oversize.',
  needsClock: true,
  async run(w, t) {
    const a = w.actor('a', { session: 'session-a' });
    const b = w.actor('b', { session: 'session-b' });
    const rid = await setup(t, a, 'Failures');
    const post = (path: string, body: unknown, token?: string | null) => w.client.postJson(path, body, token);

    await t.step('invalid resource', async () => {
      t.status(await a.getJson('/r/ZZZZZZZZZZZZ'), 404, 'GET unknown resource', 'not_found');
      t.status(await a.getJson('/r/not-an-id'), 404, 'GET malformed id', 'not_found');
      t.status(await a.append('ZZZZZZZZZZZZ', { type: 'finding', title: 'x' }, { token: a.token(rid) }), 403, 'append to unknown resource with a real token', 'capability_resource_mismatch');
      t.status(await a.append('ZZZZZZZZZZZZ', { type: 'finding', title: 'x' }, { token: null }), 404, 'append to unknown resource', 'not_found');
    });

    await t.step('invalid operation / envelope', async () => {
      t.status(await a.op(rid, 'teleport', {}), 400, 'unknown operation', 'unknown_operation');
      t.status(await a.op(rid, 'inspect', {}), 400, 'read operation via POST', 'unknown_operation');
      t.status(await a.op(rid, 'create', { title: 'x' }), 400, 'create on an existing resource', 'malformed_request');
      t.status(await post(`/r/${rid}/operations`, '{not json', a.token(rid)), 400, 'body not JSON', 'malformed_request');
      t.status(await post(`/r/${rid}/operations`, [1, 2], a.token(rid)), 400, 'body is an array', 'malformed_request');
      const env = a.envelope('append', { type: 'finding', title: 'x' });
      t.status(await post(`/r/${rid}/operations`, { ...env, protocol: 'ACSP/9.9' }, a.token(rid)), 400, 'unsupported protocol', 'unsupported_protocol');
      t.status(await post(`/r/${rid}/operations`, { ...env, idempotency_key: undefined }, a.token(rid)), 400, 'missing idempotency_key', 'malformed_request');
      t.status(await post(`/r/${rid}/operations`, { ...env, surprise: 1 }, a.token(rid)), 400, 'unknown envelope field', 'malformed_request');
      const bad = await w.client.request('POST', `/r/${rid}/operations`, { body: 'x', headers: { 'Content-Type': 'text/plain' } });
      t.status(bad, 415, 'unsupported media type', 'unsupported_media_type');
      t.status(await w.client.request('DELETE', `/r/${rid}`, { headers: { Accept: 'application/json' } }), 405, 'DELETE not allowed', 'method_not_allowed');
      t.status(await w.client.postJson(`/r/${rid}`, env), 405, 'POST to the resource URL itself', 'method_not_allowed');
    });

    await t.step('malformed payloads', async () => {
      t.status(await a.append(rid, { type: 'rumour', title: 'x' }), 422, 'unknown TOK type', 'invalid_payload');
      t.status(await a.append(rid, { type: 'finding' }), 422, 'missing title', 'invalid_payload');
      t.status(await a.append(rid, { type: 'finding', title: 'x', hidden: true }), 422, 'unknown payload field', 'invalid_payload');
      t.status(await a.append(rid, { type: 'finding', title: 'x'.repeat(201) }), 422, 'title too long', 'invalid_payload');
      t.status(await a.append(rid, { type: 'finding', title: 'x', refs: [{ tok: 'TOK-404' }] }), 422, 'reference to a non-existent TOK', 'invalid_payload');
      t.status(await a.append(rid, { type: 'finding', title: 'x', refs: [{ url: 'javascript:alert(1)' }] }), 422, 'non-http reference URL', 'invalid_payload');
      t.status(await a.delegate(rid, { to: { session_id: 'b' }, scopes: ['owner'] }), 422, 'delegate the owner scope', 'invalid_payload');
      t.status(await a.op(rid, 'append', { type: 'finding', title: 'x' }, { actor: { session_id: 'has spaces' } }), 400, 'invalid session id', 'malformed_request');
      const huge = await post(`/r/${rid}/operations`, a.envelope('append', { type: 'finding', title: 'x', content: 'y'.repeat(70_000) }), a.token(rid));
      t.status(huge, 413, 'oversize body', 'payload_too_large');
    });

    await t.step('stale version', async () => {
      const v = await a.version(rid);
      t.status(await a.append(rid, { type: 'finding', title: 'moves version' }, { expected_version: v }), 200, 'append at current version');
      const stale = await a.append(rid, { type: 'finding', title: 'stale' }, { expected_version: v });
      t.status(stale, 409, 'append at the old version', 'stale_version');
      t.eq(stale.body.error.details, { expected: v, current: v + 1 }, 'error reports expected and current');
    });

    await t.step('replayed mutation is idempotent; key reuse is refused', async () => {
      const before = await a.version(rid);
      const first = await a.append(rid, { type: 'finding', title: 'once' }, { key: 'replay-key-0001' });
      const again = await a.append(rid, { type: 'finding', title: 'once' }, { key: 'replay-key-0001' });
      t.status(again, 200, 'replay');
      t.eq(again.body.replayed, true, 'marked replayed');
      t.eq(again.body.result.tok.id, first.body.result.tok.id, 'same TOK returned');
      t.eq(await a.version(rid), before + 1, 'exactly one event created');
      const reuse = await a.append(rid, { type: 'finding', title: 'different' }, { key: 'replay-key-0001' });
      t.status(reuse, 422, 'same key, different request', 'idempotency_key_reuse');
      const failed = await a.append(rid, { type: 'bogus', title: 'x' }, { key: 'retry-after-fail' });
      t.status(failed, 422, 'failed request', 'invalid_payload');
      t.status(await a.append(rid, { type: 'finding', title: 'x' }, { key: 'retry-after-fail' }), 200, 'failures are not recorded: key can be retried');
    });

    await t.step('replays never re-disclose secrets', async () => {
      const d1 = await a.delegate(rid, { to: { session_id: 'session-b' }, scopes: ['append'] }, { key: 'delegate-b-0001' });
      t.check(typeof d1.body.result.capability.token === 'string', 'token in the original response');
      const d2 = await a.delegate(rid, { to: { session_id: 'session-b' }, scopes: ['append'] }, { key: 'delegate-b-0001' });
      t.eq([d2.body.replayed, d2.body.result.capability.token, d2.body.result.capability.token_redacted], [true, null, true], 'replay redacts the token');
      t.eq(d2.body.result.capability_url, undefined, 'replay has no capability URL');
      const c1 = await b.create({ title: 'replayed create' }, { key: 'create-once-0001' });
      const c2 = await b.create({ title: 'replayed create' }, { key: 'create-once-0001' });
      t.eq([c2.status, c2.body.resource_id, c2.body.result.owner_capability.token], [201, c1.body.resource_id, null], 'replayed create: same resource, no token');
      b.receive(rid, d1.body.result.capability.token);
    });

    await t.step('expired, revoked, forged and cross-resource capabilities', async () => {
      const short = await a.delegate(rid, { to: { session_id: 'session-b' }, scopes: ['append'], expires_in_seconds: 60 });
      const tok = short.body.result.capability.token;
      t.status(await b.append(rid, { type: 'finding', title: 'before expiry' }, { token: tok }), 200, 'valid before expiry');
      w.clock!.advance(61_000);
      t.status(await b.append(rid, { type: 'finding', title: 'after expiry' }, { token: tok }), 401, 'expired capability', 'capability_expired');
      const html = await b.openHtml(`/r/${rid}?cap=${tok}`);
      t.check(html.status === 200 && html.text.includes('capability_expired'), 'expired capability URL still reads an unlisted resource and explains the problem');
      const forged = tok.slice(0, -4) + 'AAAA';
      t.status(await b.append(rid, { type: 'finding', title: 'x' }, { token: forged }), 401, 'forged secret', 'invalid_capability');
      t.status(await b.append(rid, { type: 'finding', title: 'x' }, { token: 'acsp_garbage' }), 401, 'malformed token', 'invalid_capability');
      const other = await setup(t, b, 'Other');
      t.status(await b.append(rid, { type: 'finding', title: 'x' }, { token: b.token(other) }), 403, 'token for another resource', 'capability_resource_mismatch');
      t.status(await b.append(rid, { type: 'finding', title: 'x' }, { actor: { session_id: 'session-a' } }), 403, 'impersonate the owner session', 'session_mismatch');
    });
  },
};

export const concurrency: Scenario = {
  name: 'concurrency',
  description: 'Parallel writes serialise into consecutive versions; conflicting writes on one expected_version: exactly one wins.',
  async run(w, t) {
    const a = w.actor('a', { session: 'session-a' });
    const rid = await setup(t, a, 'Concurrency');

    await t.step('20 parallel appends', async () => {
      const results = await Promise.all(Array.from({ length: 20 }, (_, i) => a.append(rid, { type: 'observation', title: `obs ${i}` })));
      t.check(results.every((r) => r.status === 200), 'all succeed');
      const versions = results.map((r) => r.body.version).sort((x, y) => x - y);
      t.eq(versions, Array.from({ length: 20 }, (_, i) => i + 2), 'distinct consecutive versions 2..21');
      const ids = new Set(results.map((r) => r.body.result.tok.id));
      t.eq(ids.size, 20, 'distinct TOK ids');
      const events = (await a.getJson(`/r/${rid}/events`)).body.events;
      t.eq(events.length, 21, 'history has no gaps or duplicates');
    });

    await t.step('10 parallel writes against the same expected_version', async () => {
      const v = await a.version(rid);
      const results = await Promise.all(Array.from({ length: 10 }, (_, i) => a.append(rid, { type: 'decision', title: `d${i}` }, { expected_version: v })));
      t.eq(results.filter((r) => r.status === 200).length, 1, 'exactly one succeeds');
      t.eq(results.filter((r) => r.status === 409 && r.body.error.code === 'stale_version').length, 9, 'the rest get stale_version');
      t.eq(await a.version(rid), v + 1, 'one version added');
    });

    await t.step('parallel identical requests (same idempotency key) create one event', async () => {
      const v = await a.version(rid);
      const results = await Promise.all(Array.from({ length: 6 }, () => a.append(rid, { type: 'finding', title: 'dup' }, { key: 'parallel-dup-0001' })));
      t.check(results.every((r) => r.status === 200), 'all return success');
      t.eq(results.filter((r) => !r.body.replayed).length, 1, 'one original, the rest replays');
      t.eq(await a.version(rid), v + 1, 'one event created');
    });
  },
};

export const getSafety: Scenario = {
  name: 'get-safety',
  description: 'Opening any GET URL — including prepare and capability URLs — never changes state.',
  async run(w, t) {
    const a = w.actor('a', { session: 'session-a' });
    const rid = await setup(t, a, 'GET safety');
    await a.append(rid, { type: 'task', title: 'T' });
    const d = await a.delegate(rid, { to: { session_id: 'session-b' }, scopes: ['append'] });
    const capUrl = d.body.result.capability_url;
    const v = await a.version(rid);
    const crawler = w.actor('crawler', { session: 'crawler' });
    const urls = [
      `/r/${rid}`, `/r/${rid}.json`, `/r/${rid}?action=status`, `/r/${rid}/operations`, `/r/${rid}/events`,
      `/r/${rid}/events/1`, `/r/${rid}/knowledge/TOK-001`, `/r/${rid}/checkpoints`, `/r/${rid}/checkpoints/0`,
      `/r/${rid}/diff?from=1`, `/r/${rid}/explorer`, capUrl, '/', '/protocol', '/new?title=x', '/.well-known/acsp',
      ...['append', 'annotate', 'update', 'supersede', 'checkpoint', 'fork', 'delegate', 'revoke', 'handoff', 'acknowledge', 'propose', 'resolve_proposal', 'close']
        .map((op) => `/r/${rid}?action=prepare_${op}&title=crawled&session_id=crawler`),
      `/r/${rid}?action=prepare_append&title=x&cap=${d.body.result.capability.token}`,
    ];

    await t.step(`a crawler opens ${urls.length} URLs (HTML and JSON, HEAD too)`, async () => {
      for (const u of urls) {
        const html = await crawler.openHtml(u);
        const json = await crawler.getJson(u);
        const head = await w.client.request('HEAD', u);
        t.check(html.status === 200 && json.status === 200 && head.status === 200, `GET ${u.replace(/cap=[^&]+/, 'cap=…')} → 200`);
      }
    });

    await t.step('nothing changed', async () => {
      t.eq(await a.version(rid), v, 'version unchanged');
      t.eq((await a.inspect(rid)).body.knowledge.items.length, 1, 'no knowledge created');
      const created = await w.client.getJson('/r/ZZZZZZZZZZZZ');
      t.status(created, 404, 'no resource was created by GET /new');
    });
  },
};

export const representations: Scenario = {
  name: 'representations',
  description: 'HTML and JSON are the same document; .json, ?format=json and Accept agree; every page is self-describing.',
  async run(w, t) {
    const a = w.actor('a', { session: 'session-a' });
    const rid = await setup(t, a, 'Representations <script>alert(1)</script>', { description: '"quotes" & <tags>' });
    await a.append(rid, { type: 'finding', title: '<img src=x onerror=alert(1)>', content: '</script><script>alert(2)</script>' });
    const ro = w.actor('ro', { session: 'session-ro' });

    await t.step('three ways to ask for JSON agree; HTML embeds the same document', async () => {
      const viaSuffix = (await ro.openHtml(`/r/${rid}.json`)).body;
      const viaQuery = (await ro.openHtml(`/r/${rid}?format=json`)).body;
      const viaAccept = (await ro.getJson(`/r/${rid}`)).body;
      const html = await ro.openHtml(`/r/${rid}`);
      const embedded = embeddedDocument(html.text);
      const strip = (d: any) => JSON.stringify({ ...d, links: undefined });
      t.check(strip(viaSuffix) === strip(viaQuery) && strip(viaQuery) === strip(viaAccept), '.json = ?format=json = Accept: application/json');
      t.eq(strip(embedded), strip(viaAccept), 'HTML embeds exactly the JSON document');
      t.check(alternateJsonHref(html.text) !== null, 'HTML advertises the JSON via <link rel="alternate">');
      t.check((html.headers.get('link') ?? '').includes('rel="alternate"'), 'Link header advertises the JSON too');
      t.eq(html.headers.get('acsp-protocol'), PROTOCOL_VERSION, 'ACSP-Protocol header');
    });

    await t.step('user content is escaped (no script injection)', async () => {
      const html = (await ro.openHtml(`/r/${rid}`)).text;
      t.check(!html.includes('<img src=x'), 'TOK title escaped');
      t.check(!html.includes('<script>alert'), 'no injected script tags');
      t.eq((html.match(/<script/g) ?? []).length, 1, 'only the inert application/json script block');
      t.check(embeddedDocument(html).knowledge.items[0].content.includes('</script>'), 'embedded JSON preserves content exactly');
    });

    await t.step('security headers on every response', async () => {
      for (const u of [`/r/${rid}`, `/r/${rid}.json`, '/protocol', '/r/ZZZZZZZZZZZZ']) {
        const r = await ro.openHtml(u);
        const h = r.headers;
        t.check(
          (h.get('content-security-policy') ?? '').includes("default-src 'none'") &&
            h.get('x-content-type-options') === 'nosniff' &&
            h.get('referrer-policy') === 'no-referrer' &&
            h.get('cache-control') === 'no-store' &&
            (h.get('x-robots-tag') ?? '').includes('noindex'),
          `security headers on ${u}`,
        );
      }
    });

    await t.step('every endpoint identifies itself and links back to the protocol', async () => {
      for (const u of [`/r/${rid}/events`, `/r/${rid}/checkpoints/0`, `/r/${rid}/knowledge/TOK-001`, `/r/${rid}/diff?from=1`, `/r/${rid}/operations`, `/r/${rid}?action=status`, `/r/${rid}?action=prepare_append`]) {
        const d = (await ro.getJson(u)).body;
        t.check(d.protocol?.version === PROTOCOL_VERSION && typeof d.notice === 'string' && d.notice.includes('Agent Continuity Resource'), `${u} is self-describing`);
      }
      const p = (await ro.getJson('/protocol')).body;
      t.check(p.operations.length === OPERATIONS.length && p.operations.length >= 18 && p.operations.every((o: any) => o.purpose && o.authority_text && o.side_effects && o.provenance && o.failures.length), 'protocol documents every operation completely');
      t.check(p.operations.filter((o: any) => o.mutation).every((o: any) => o.payload_schema?.type === 'object'), 'every mutation publishes a JSON Schema');
      const disc = await ro.getJson('/.well-known/acsp');
      t.eq(disc.body.type, 'discovery', 'well-known discovery document');
    });

    await t.step('errors are self-describing in both formats', async () => {
      const j = await ro.getJson('/r/ZZZZZZZZZZZZ');
      t.eq([j.status, j.body.ok, j.body.error.code, typeof j.body.links.protocol], [404, false, 'not_found', 'string'], 'JSON error');
      const h = await ro.openHtml('/r/ZZZZZZZZZZZZ');
      t.check(h.status === 404 && h.text.includes('ACSP ERROR 404') && h.text.includes('not_found'), 'HTML error');
    });
  },
};

export const restricted: Scenario = {
  name: 'restricted',
  description: 'Restricted resources require a capability to read; ["read"] grants access without authority.',
  async run(w, t) {
    const a = w.actor('a', { session: 'session-a' });
    const r = w.actor('r', { session: 'session-r' });
    const rid = await setup(t, a, 'Restricted', { visibility: 'restricted' });

    await t.step('without a capability nothing is readable', async () => {
      t.status(await r.getJson(`/r/${rid}`), 401, 'inspect', 'authentication_required');
      t.status(await r.getJson(`/r/${rid}/events`), 401, 'events', 'authentication_required');
      t.status(await r.propose(rid, { operation: 'append', payload: { type: 'question', title: 'x' } }), 401, 'propose (requires read access)', 'authentication_required');
      t.status(await r.fork(rid, {}), 401, 'fork (requires read access)', 'authentication_required');
      t.status(await r.getJson(`/r/${rid}?cap=acsp_cap_0000000000_00000000000000000000000000000000`), 401, 'bogus capability URL', 'invalid_capability');
    });

    await t.step('a ["read"] capability grants access but no authority', async () => {
      const d = await a.delegate(rid, { to: { session_id: 'session-r' }, scopes: ['read'] });
      const tok = d.body.result.capability.token;
      r.receive(rid, tok);
      t.status(await r.inspect(rid), 200, 'inspect with read capability');
      const page = await r.openHtml(d.body.result.capability_url);
      t.status(page, 200, 'capability URL opens in a browser');
      t.check(page.text.includes(`/r/${rid}/events?cap=`), 'links on the page carry the capability for navigation');
      t.status(await r.append(rid, { type: 'finding', title: 'x' }), 403, 'append with read capability', 'insufficient_authority');
      t.status(await r.propose(rid, { operation: 'append', payload: { type: 'question', title: 'May I?' } }), 200, 'propose with read capability');
      const f = await r.fork(rid, {});
      t.status(f, 201, 'fork with read capability');
      t.eq((await r.inspect(f.body.resource_id)).body.access.visibility, 'restricted', 'fork inherits visibility');
    });
  },
};

export const humanFormPath: Scenario = {
  name: 'human-form-path',
  description: 'A GET-only agent prepares an intent URL; the human reviews and submits the no-JS form.',
  async run(w, t) {
    const a = w.actor('a', { session: 'session-a' });
    const rid = await setup(t, a, 'Forms');
    const d = await a.delegate(rid, { to: { session_id: 'session-g' }, scopes: ['append'] });
    const token = d.body.result.capability.token;

    await t.step('a prepared proposal is validated as the server will validate it', async () => {
      const inner = { operation: 'append', payload: { type: 'finding', title: 't', refs: [{ tok: 'P-005' }] } };
      const url = `/r/${rid}?action=prepare_propose&session_id=session-g&payload=${encodeURIComponent(JSON.stringify(inner))}`;
      const prepared = (await w.client.getJson(url)).body;
      t.check(prepared.validation.valid === false && prepared.validation.issues.some((i: any) => i.path === 'payload.payload.refs.0.tok'), 'an invalid inner payload is reported, with its path');
      const submitted = await w.client.postJson(`/r/${rid}/operations`, prepared.request);
      t.status(submitted, 422, 'and the server refuses the same request', 'invalid_payload');
    });

    const intentUrl = `/r/${rid}?action=prepare_append&session_id=session-g&agent_id=browser-agent&type=observation&title=${encodeURIComponent('Seen from a browser')}&content=${encodeURIComponent('Composed as a URL.')}`;
    const intent = await t.step('the GET-only agent composes and opens an intent URL', async () => {
      const page = await w.client.getHtml(intentUrl);
      t.status(page, 200, 'open prepare URL');
      t.check(page.text.includes('NOT executed'), 'page states nothing was executed');
      t.check(/<form method="post" action="[^"]+\/operations">/.test(page.text), 'contains a plain HTML form');
      const doc = (await w.client.getJson(intentUrl)).body;
      t.eq(doc.type, 'operation_intent', 'operation intent document');
      t.eq(doc.validation, { valid: true, issues: [] }, 'prefilled request validates');
      t.eq(doc.request.payload.title, 'Seen from a browser', 'payload prefilled from the URL');
      t.eq(doc.request.expected_version, await a.version(rid), 'expected_version set to the version seen');
      t.check(doc.execution.curl.startsWith('curl'), 'curl equivalent provided');
      const invalid = (await w.client.getJson(`/r/${rid}?action=prepare_append&type=rumour`)).body;
      t.eq(invalid.validation.valid, false, 'invalid prefill reported before submission');
      t.check(invalid.validation.issues.some((i: any) => i.path === 'actor.session_id'), 'missing session id flagged');
      t.check(invalid.validation.issues.some((i: any) => i.path === 'payload.type'), 'invalid TOK type flagged');
      return doc;
    });

    await t.step('the human submits the form with the capability', async () => {
      const res = await w.client.postForm(`/r/${rid}/operations`, { request: JSON.stringify(intent.request), capability: token });
      t.status(res, 200, 'form POST');
      t.check((res.headers.get('content-type') ?? '').includes('text/html'), 'HTML result for the human');
      t.check(res.text.includes('OPERATION PERFORMED'), 'result page confirms execution');
      const tok = (await a.inspect(rid)).body.knowledge.items[0];
      t.eq([tok.title, tok.source.session_id, tok.source.agent_id], ['Seen from a browser', 'session-g', 'browser-agent'], 'TOK attributed to the agent session that composed it');
      const again = await w.client.postForm(`/r/${rid}/operations`, { request: JSON.stringify(intent.request), capability: token });
      t.check(again.text.includes('OPERATION REPLAYED'), 'double-submitting the form is an idempotent replay');
    });

    await t.step('form errors render as HTML; create works from /new', async () => {
      const res = await w.client.postForm(`/r/${rid}/operations`, { request: JSON.stringify(intent.request).replace('observation', 'rumour') });
      t.check(res.status === 400 || res.status === 422, 'invalid form submission refused');
      t.check(res.text.includes('ACSP ERROR'), 'HTML error page');
      const prep = (await w.client.getJson('/new?title=From%20a%20form&session_id=human-1&actor_kind=human')).body;
      t.eq(prep.validation.valid, true, 'prepared create validates');
      t.eq(prep.request.actor, { session_id: 'human-1', kind: 'human' }, 'actor prefilled; no placeholder agent id');
      const created = await w.client.postForm('/r', { request: JSON.stringify(prep.request) });
      t.status(created, 201, 'create via form');
      t.check(created.text.includes('shown ONCE'), 'owner token shown once with a warning');
    });
  },
};

export const rateLimits: Scenario = {
  name: 'rate-limits',
  description: 'Unauthenticated writes are rate limited per client; reads are never limited.',
  config: { rateLimits: { anonPerHour: 3, writesPerHour: 1000 } },
  needsClock: true,
  async run(w, t) {
    const x = w.actor('x', { session: 'session-x' });
    await t.step('the fourth unauthenticated write in an hour is refused', async () => {
      for (let i = 0; i < 3; i++) t.status(await x.create({ title: `r${i}` }), 201, `create ${i + 1}`);
      const r = await x.create({ title: 'r4' });
      t.status(r, 429, 'create 4', 'rate_limited');
      t.check(Number(r.headers.get('retry-after')) > 0, 'Retry-After header');
      t.status(await x.getJson('/protocol'), 200, 'reads unaffected');
    });
    await t.step('the window resets', async () => {
      w.clock!.advance(3600_000);
      t.status(await x.create({ title: 'next hour' }), 201, 'create after the window');
    });
  },
};
