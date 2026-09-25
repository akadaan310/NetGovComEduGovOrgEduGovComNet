/**
 * Section 42 — the core demonstration, end to end over HTTP.
 *
 * Human → Session A creates a resource and publishes TOKs → the human gives
 * the URL to Session B → B opens the HTML, discovers the bootstrap and the
 * JSON, inspects protocol/state/provenance/knowledge/operations/authority →
 * B proposes (no authority), then contributes with a delegated capability →
 * A later sees B's contribution. A and B remain separate throughout, and a
 * third session can reconstruct everything after A is gone.
 */
import { canonicalHash } from '../../src/continuity/canonical';
import { alternateJsonHref, embeddedDocument, visibleText } from '../client';
import type { Scenario } from '../scenario';

export const coreDemonstration: Scenario = {
  name: 'core-demonstration',
  description: 'Section 42: A publishes, B discovers via URL, B contributes, A observes; sessions stay independent.',
  async run(w, t) {
    const human = w.actor('human', { session: 'human-operator', agent: null, kind: 'human' });
    const a = w.actor('agent-a', { session: 'session-a', agent: 'agent-a' });
    const b = w.actor('agent-b', { session: 'session-b', agent: 'agent-b' });

    // ── Session A ─────────────────────────────────────────────────────────
    const created = await t.step('Session A creates a research resource', async () => {
      const res = await a.create({
        title: 'Tail latency in the ingest pipeline',
        description: 'Research into p99 latency spikes observed in the ingest service.',
        focus: 'Identify the cause of p99 spikes above 800 ms.',
        owner_human: 'operator',
      });
      t.status(res, 201, 'create');
      t.eq(res.body.version, 1, 'new resource is at version 1');
      t.check(typeof res.body.result.owner_capability.token === 'string', 'owner capability token returned once');
      t.check(typeof res.body.result.owner_capability_url === 'string', 'owner capability URL returned');
      t.eq(res.body.result.checkpoint.number, 0, 'genesis checkpoint 0 exists');
      t.eq(res.body.events[0].identity_assurance, 'asserted', 'create is recorded with asserted identity');
      return res.body;
    });
    const rid: string = created.resource_id;
    const resourceUrl: string = created.links.resource;

    await t.step('Session A decides a finding should be available to another session: publishes TOKs', async () => {
      const f = await a.append(rid, {
        type: 'finding',
        title: 'p99 spikes coincide with full GC pauses',
        summary: 'Every spike above 800 ms in the 24h sample overlaps a full GC pause.',
        content: 'Correlated 41 of 41 spikes with GC logs (G1, full collections).',
        stated_confidence: 'medium',
      });
      t.status(f, 200, 'append finding');
      t.eq(f.body.result.tok.id, 'TOK-001', 'first TOK is TOK-001');
      t.eq(f.body.result.tok.source, { session_id: 'session-a', agent_id: 'agent-a', kind: 'agent', identity_assurance: 'capability' }, 'TOK records its source with capability assurance');
      const task = await a.append(rid, { type: 'task', title: 'Reproduce the spike under synthetic load' });
      t.status(task, 200, 'append task');
      t.eq(task.body.result.tok.task, { responsible_session_id: 'session-a' }, 'task starts with its author responsible');
      const cp = await a.checkpoint(rid, { label: 'initial findings', note: 'GC correlation established.' });
      t.status(cp, 200, 'checkpoint');
      t.eq(cp.body.result.checkpoint.number, 1, 'checkpoint 1 created');
      t.eq(cp.body.result.checkpoint.version, cp.body.version, 'checkpoint captures its own event version');
    });

    // ── The human hands the URL to Session B ──────────────────────────────
    const html = await t.step('Human gives the HTTPS URL to Session B; B opens it as a browser would', async () => {
      const origin = new URL(w.transport.base);
      if (['localhost', '127.0.0.1'].includes(origin.hostname)) {
        t.check(resourceUrl.startsWith(origin.origin), `resource URL is on this origin (${resourceUrl}; local run — HTTPS comes from the deployment platform)`);
      } else {
        t.check(resourceUrl.startsWith('https://'), `resource URL is HTTPS (${resourceUrl})`);
      }
      const page = await b.openHtml(resourceUrl);
      t.status(page, 200, 'open resource URL');
      t.check((page.headers.get('content-type') ?? '').includes('text/html'), 'served as HTML by default');
      const text = visibleText(page.text);
      t.check(text.includes('AGENT CONTINUITY RESOURCE'), 'page identifies itself as an Agent Continuity Resource');
      t.check(text.includes('You are an AI agent accessing an Agent Continuity Resource'), 'page addresses the agent explicitly');
      t.check(text.includes('AGENT BOOTSTRAP'), 'agent bootstrap is present in plain text');
      t.check(text.includes('AGENT ACCESS'), 'agent access section is present in plain text');
      t.check(text.includes('ACSP/0.1'), 'protocol version visible');
      t.check(text.includes('p99 spikes coincide with full GC pauses'), 'published knowledge is readable');
      t.check(text.includes('SESSION-A'), 'owner visible');
      return page.text;
    });

    const doc = await t.step('B discovers and reads the machine representation', async () => {
      const href = alternateJsonHref(html);
      t.check(href?.endsWith(`/r/${rid}.json`), 'JSON discoverable via <link rel="alternate">');
      const res = await b.openHtml(href!); // a plain GET, no Accept negotiation needed
      t.status(res, 200, 'GET .json');
      t.check((res.headers.get('content-type') ?? '').includes('application/json'), '.json suffix yields JSON');
      const d = res.body;
      t.eq(d.protocol.version, 'ACSP/0.1', 'protocol');
      t.eq(d.type, 'continuity_resource', 'document type');
      t.check(d.notice.startsWith('You are an AI agent accessing an Agent Continuity Resource'), 'notice');
      t.check(Array.isArray(d.bootstrap.steps) && d.bootstrap.steps.length >= 6, 'bootstrap steps');
      t.eq(d.state.lifecycle, 'active', 'state: active');
      t.eq(d.state.version, 4, 'state: version 4');
      t.eq(d.state.checkpoint.number, 1, 'state: latest checkpoint 1');
      t.eq(d.ownership.owner.session_id, 'session-a', 'ownership: session-a');
      t.eq(d.knowledge.items.length, 2, 'knowledge: two TOKs');
      t.check(d.knowledge.semantics.includes('does not evaluate truth'), 'knowledge semantics disclaim truth evaluation');
      t.eq(d.provenance.created.actor.session_id, 'session-a', 'provenance: created by session-a');
      t.eq(d.viewer.authenticated, false, 'authority: B is not authenticated');
      const ops = Object.fromEntries(d.operations.map((o: any) => [o.name, o]));
      t.eq(ops.inspect.permitted_for_viewer, true, 'B may inspect');
      t.eq(ops.append.permitted_for_viewer, false, 'B may NOT append (awareness ≠ authority)');
      t.eq(ops.propose.permitted_for_viewer, true, 'B may propose');
      t.eq(ops.fork.permitted_for_viewer, true, 'B may fork');
      t.eq(ops.delegate.permitted_for_viewer, false, 'B may NOT delegate');
      t.check(ops.append.prepare_href.includes('action=prepare_append'), 'operations expose prepare links');
      t.check(d.next_valid_actions.some((n: any) => n.action === 'propose'), 'next valid actions suggest propose');
      t.eq(embeddedDocument(html)?.state?.version, d.state.version, 'HTML embeds the same document');
      return d;
    });

    await t.step('B cannot mutate without authority; it proposes instead', async () => {
      const denied = await b.append(rid, { type: 'finding', title: 'Heap is undersized' }, { token: null });
      t.status(denied, 401, 'append without capability', 'authentication_required');
      const prop = await b.propose(rid, {
        operation: 'append',
        payload: { type: 'hypothesis', title: 'Heap is undersized for peak batch size', stated_confidence: 'low', refs: [{ tok: 'TOK-001' }] },
        rationale: 'GC pressure suggests the heap cannot hold peak batches.',
      });
      t.status(prop, 200, 'propose (no capability)');
      t.eq(prop.body.result.proposal.status, 'pending', 'proposal pending');
      t.eq(prop.body.events[0].identity_assurance, 'asserted', 'proposal identity is asserted');
      t.eq(prop.body.version, doc.state.version + 1, 'proposal recorded as an event');
    });

    await t.step('Session A reviews and accepts the proposal', async () => {
      const v = await a.version(rid);
      const res = await a.resolveProposal(rid, { proposal_id: 'P-001', decision: 'accept', note: 'Worth tracking.' }, { expected_version: v });
      t.status(res, 200, 'resolve_proposal accept');
      t.eq(res.body.events.map((e: any) => e.operation), ['resolve_proposal', 'append'], 'two events: resolution, then execution');
      const exec = res.body.events[1];
      t.eq(exec.actor.session_id, 'session-a', 'executed by session-a');
      t.eq(exec.on_behalf_of.session_id, 'session-b', 'on behalf of session-b');
      t.eq(exec.proposal_id, 'P-001', 'linked to the proposal');
      const tok = res.body.result.executed.tok;
      t.eq(tok.source.session_id, 'session-b', 'TOK source remains the proposer (session-b)');
      t.eq(tok.source.identity_assurance, 'asserted', 'proposer identity remains asserted');
      t.eq(tok.recorded_by.session_id, 'session-a', 'recorded_by is the executor (session-a)');
    });

    const bToken = await t.step('Session A delegates scoped authority to Session B; the human passes it on', async () => {
      const res = await a.delegate(rid, { to: { session_id: 'session-b', agent_id: 'agent-b' }, scopes: ['append', 'annotate'], label: 'contributor' });
      t.status(res, 200, 'delegate');
      const cap = res.body.result.capability;
      t.eq(cap.session_id, 'session-b', 'capability bound to session-b');
      t.eq(cap.scopes, ['append', 'annotate'], 'scopes as requested');
      t.check(cap.expires_at !== null, 'delegation expires');
      t.eq(res.body.events[0].data.capability_id, cap.id, 'event records the capability id');
      t.check(!JSON.stringify(res.body.events).includes(cap.token), 'event does not contain the secret');
      b.receive(rid, cap.token); // out of band, via the human
      return { token: cap.token as string, url: res.body.result.capability_url as string, id: cap.id as string };
    });

    await t.step('B opens its capability URL and discovers its own authority', async () => {
      const page = await b.openHtml(bToken.url);
      t.status(page, 200, 'open capability URL');
      const text = visibleText(page.text);
      t.check(text.includes('delegated capability') && text.includes('session-b'), 'page states B\'s delegated authority');
      const d = (await b.inspect(rid)).body;
      t.eq(d.viewer.session_id, 'session-b', 'viewer is session-b');
      t.eq(d.viewer.is_owner, false, 'B is not the owner');
      const ops = Object.fromEntries(d.operations.map((o: any) => [o.name, o]));
      t.eq(ops.append.permitted_for_viewer, true, 'B may now append');
      t.eq(ops.delegate.permitted_for_viewer, false, 'B still may not delegate (write ≠ ownership)');
    });

    await t.step('Session B contributes a new TOK under its own identity', async () => {
      const v = await b.version(rid);
      const res = await b.append(
        rid,
        {
          type: 'finding',
          title: 'Spike reproduced at 3x batch size',
          content: 'Synthetic load at 3x nominal batch reproduces 900 ms p99 with full GCs.',
          stated_confidence: 'high',
          refs: [{ tok: 'TOK-001' }, { tok: 'TOK-002' }],
        },
        { expected_version: v },
      );
      t.status(res, 200, 'B appends');
      t.eq(res.body.result.tok.id, 'TOK-004', 'B\'s TOK is TOK-004');
      t.eq(res.body.result.tok.source, { session_id: 'session-b', agent_id: 'agent-b', kind: 'agent', identity_assurance: 'capability' }, 'source is session-b, capability-verified');
      t.eq(res.body.events[0].capability_id, bToken.id, 'event names B\'s capability');
    });

    await t.step('B cannot become A', async () => {
      const spoof = await b.append(rid, { type: 'finding', title: 'x' }, { actor: { session_id: 'session-a' } });
      t.status(spoof, 403, 'append claiming session-a with B\'s capability', 'session_mismatch');
      const del = await b.delegate(rid, { to: { session_id: 'session-z' }, scopes: ['append'] });
      t.status(del, 403, 'B delegates', 'insufficient_authority');
      const own = (await b.inspect(rid)).body.ownership.owner.session_id;
      t.eq(own, 'session-a', 'ownership unchanged');
    });

    await t.step('Session A later inspects and observes B\'s contribution', async () => {
      const d = (await a.inspect(rid)).body;
      const t4 = d.knowledge.items.find((k: any) => k.id === 'TOK-004');
      t.check(t4, 'A sees TOK-004');
      t.eq(t4?.source.session_id, 'session-b', 'attributed to session-b, not session-a');
      t.check(d.provenance.recent_events.some((e: any) => e.actor.session_id === 'session-b' && e.operation === 'append'), 'event history shows B\'s append');
      t.eq(d.viewer.is_owner, true, 'A is still the owner');
    });

    await t.step('Session A disappears; a new Session C reconstructs the published state from the URL alone', async () => {
      a.forget();
      b.forget();
      const c = w.actor('agent-c', { session: 'session-c', agent: 'agent-c' });
      const d = (await c.openHtml(`${resourceUrl}.json`)).body;
      t.eq(d.knowledge.items.map((k: any) => k.id), ['TOK-001', 'TOK-002', 'TOK-003', 'TOK-004'], 'all TOKs readable');
      t.eq(d.knowledge.items.map((k: any) => k.source.session_id), ['session-a', 'session-a', 'session-b', 'session-b'], 'each with its source');
      const cp = (await c.getJson(`/r/${rid}/checkpoints/1`)).body.checkpoint;
      t.eq(canonicalHash(cp.snapshot), cp.sha256, 'checkpoint 1 snapshot hash verifies independently');
      t.eq(cp.snapshot.knowledge.length, 2, 'checkpoint 1 captured the two TOKs published before it');
      const diff = (await c.getJson(`/r/${rid}/diff?since_checkpoint=1`)).body;
      t.eq(diff.knowledge_added.map((k: any) => k.id), ['TOK-003', 'TOK-004'], 'diff since checkpoint 1 = the later contributions');
      const ev = (await c.getJson(`/r/${rid}/events`)).body.events;
      t.eq(ev.map((e: any) => e.version), ev.map((_: any, i: number) => i + 1), 'complete, gap-free history');
    });
    void human;
  },
};
