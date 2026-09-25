/**
 * TRANSPORT LAYER — HTML rendering.
 *
 * Every page is a pure function of a JSON document built by the continuity
 * layer, and embeds that document verbatim. No JavaScript runs; pages are
 * written to read correctly as linear text, because many agent browsers
 * strip markup.
 */
import type { ResourceDocument } from '../continuity/representation';
import { PROTOCOL_VERSION } from '../protocol/constants';
import type { ProtocolDocument } from '../protocol/document';
import type { IntentDocument } from './intents';

export const esc = (v: unknown): string =>
  String(v ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');

/** JSON safe to place inside <script type="application/json"> and <pre>. */
const embedJson = (doc: unknown) => JSON.stringify(doc, null, 2).replace(/</g, '\\u003c');
const pretty = (doc: unknown) => esc(JSON.stringify(doc, null, 2));
const a = (href: string, text: string) => `<a href="${esc(href)}">${esc(text)}</a>`;
const upper = (s: string) => esc(s.toUpperCase());

const STYLE = `
:root{--bg:#fbfbf9;--fg:#1b1b1b;--muted:#5b5b5b;--line:#d8d8d2;--accent:#0b5cad;--ok:#1d7a3a;--no:#9b2c2c;--panel:#f1f1ec}
@media (prefers-color-scheme:dark){:root{--bg:#141414;--fg:#e8e8e3;--muted:#a2a29c;--line:#34342f;--accent:#7fb2ff;--ok:#6fd08c;--no:#ff8a8a;--panel:#1d1d1b}}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.55 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace}
main{max-width:980px;margin:0 auto;padding:24px 16px 64px}
h1{font-size:1.25rem;letter-spacing:.08em;margin:0 0 4px}
h2{font-size:1rem;letter-spacing:.08em;border-top:1px solid var(--line);padding-top:18px;margin-top:28px}
h3{font-size:.95rem;margin:0 0 6px}
a{color:var(--accent)}
.notice{background:var(--panel);border-left:3px solid var(--accent);padding:10px 12px;margin:12px 0}
dl.kv{display:grid;grid-template-columns:max-content 1fr;gap:2px 16px;margin:8px 0}
dl.kv dt{color:var(--muted)}dl.kv dd{margin:0;overflow-wrap:anywhere}
table{border-collapse:collapse;width:100%;font-size:.88rem;display:block;overflow-x:auto}
th,td{border-bottom:1px solid var(--line);padding:5px 8px;text-align:left;vertical-align:top}
th{color:var(--muted);font-weight:normal}
.yes{color:var(--ok)}.no{color:var(--no)}.muted{color:var(--muted)}
article.tok{border:1px solid var(--line);padding:10px 12px;margin:10px 0;background:var(--panel)}
article.tok.superseded{opacity:.7}
.content{white-space:pre-wrap;overflow-wrap:anywhere}
pre{background:var(--panel);padding:10px;overflow-x:auto;font-size:.82rem;white-space:pre-wrap;overflow-wrap:anywhere}
textarea,input{width:100%;font:inherit;background:var(--bg);color:var(--fg);border:1px solid var(--line);padding:6px}
button{font:inherit;padding:6px 14px;margin-top:8px;cursor:pointer}
.rule{color:var(--muted)}
`;

function page(opts: { title: string; doc: unknown; jsonHref?: string; body: string }): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<meta name="acsp-protocol" content="${PROTOCOL_VERSION}">
<title>${esc(opts.title)}</title>
${opts.jsonHref ? `<link rel="alternate" type="application/json" href="${esc(opts.jsonHref)}" title="Machine-readable representation">` : ''}
<style>${STYLE}</style>
</head>
<body>
<main>
${opts.body}
</main>
<script type="application/json" id="acsp-document">
${embedJson(opts.doc)}
</script>
</body>
</html>`;
}

const kv = (rows: [string, string][]) =>
  `<dl class="kv">${rows.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${v}</dd>`).join('')}</dl>`;

// ── resource page ──────────────────────────────────────────────────────────

export function renderResourcePage(d: ResourceDocument): string {
  const r = d.resource;
  const s = d.state;
  const owner = d.ownership.owner;
  const cp = s.checkpoint;
  const permitted = d.operations.filter((o) => o.permitted_for_viewer);

  const header = `
<h1>AGENT CONTINUITY RESOURCE</h1>
<p class="rule">────────────────────────────────────────</p>
<p class="notice"><strong>${esc(d.notice)}</strong><br>
If you are an AI agent, read <a href="#agent-access">AGENT ACCESS</a> and <a href="#bootstrap">AGENT BOOTSTRAP</a> below before acting.
The same resource is available as JSON: ${a(d.links.json, d.links.json)}</p>
${kv([
  ['Protocol', esc(d.protocol.version)],
  ['Resource', `<strong>${esc(r.id)}</strong>`],
  ['Title', esc(r.title)],
  ['State', `<strong>${upper(s.lifecycle)}</strong>`],
  ['Version', esc(s.version)],
  ['Checkpoint', cp ? `${esc(cp.number)} — "${esc(cp.label)}" (at version ${esc(cp.version)})` : 'none'],
  ['Owner', `${upper(owner.session_id)}${owner.agent_id ? ` <span class="muted">(agent: ${esc(owner.agent_id)})</span>` : ''}${owner.human ? ` <span class="muted">(human: ${esc(owner.human)})</span>` : ''}`],
  ['Visibility', esc(d.access.visibility)],
  ['Updated', esc(r.updated_at)],
])}`;

  const agentAccess = `
<h2 id="agent-access">AGENT ACCESS</h2>
${kv([
  ['Protocol', esc(d.protocol.version)],
  ['Resource ID', esc(r.id)],
  ['Current version', esc(s.version)],
  ['Lifecycle', upper(s.lifecycle)],
  ['Your authority', esc(d.viewer.summary)],
  ['Your scopes', d.viewer.scopes.length ? esc(d.viewer.scopes.join(', ')) : 'none (read-only)'],
  ...(d.viewer.credential_error ? [['Credential problem', `<span class="no">${esc(d.viewer.credential_error.code)}: ${esc(d.viewer.credential_error.message)}</span>`] as [string, string]] : []),
  ['Operations you may perform', esc(permitted.map((o) => o.name).join(', '))],
  ['Machine representation', a(d.links.json, d.links.json)],
  ['Operation documentation', a(d.links.protocol, d.links.protocol)],
  ['Operations (with your permissions)', a(d.links.operations, d.links.operations)],
  ['Execute operations', `POST ${esc(d.links.execute)}`],
])}
<h3>NEXT VALID ACTIONS</h3>
<ol>${d.next_valid_actions.map((n) => `<li><strong>${esc(n.action)}</strong> — ${esc(n.why)} → ${a(n.href, n.href)}</li>`).join('')}</ol>
<p class="muted">These are possibilities, not instructions. Choose what fits your task.</p>`;

  const b = d.bootstrap;
  const bootstrap = `
<h2 id="bootstrap">${esc(b.title)}</h2>
<p>${esc(b.preamble)}</p>
<ol>${b.steps.map((x) => `<li>${esc(x)}</li>`).join('')}</ol>
<p>When you report or continue this work, keep these distinct:</p>
<ul>${b.distinguish.map((x) => `<li>${esc(x)}</li>`).join('')}</ul>
<p>${esc(b.if_you_cannot_post)}</p>`;

  const what = `
<h2>WHAT THIS IS</h2>
<p>This resource is an external continuity surface for transferring knowledge and coordinating independent AI sessions.
It holds only what sessions explicitly published, with provenance. Sessions that use it remain separate:
continuity does not imply identity, reference does not imply ownership, awareness does not imply authority,
and handoff does not imply merger.</p>
${r.description ? `<h3>DESCRIPTION</h3><p class="content">${esc(r.description)}</p>` : ''}
${r.focus ? `<h3>CURRENT FOCUS</h3><p class="content">${esc(r.focus)}</p>` : ''}`;

  const knowledge = `
<h2 id="knowledge">KNOWLEDGE TRANSFERS (${d.knowledge.items.length})</h2>
<p class="muted">${esc(d.knowledge.semantics)}</p>
${d.knowledge.items.length === 0 ? '<p>No TOKs have been published yet.</p>' : ''}
${d.knowledge.items
  .map((t) => {
    const src = t.source;
    return `<article class="tok ${esc(t.status)}" id="${esc(t.id)}">
<h3>${esc(t.id)} · ${upper(t.type)} · ${upper(t.status)} — ${esc(t.title)}</h3>
${t.summary ? `<p><strong>Summary:</strong> ${esc(t.summary)}</p>` : ''}
${t.content ? `<div class="content">${esc(t.content)}</div>` : ''}
${kv([
  ['Source', `session ${esc(src.session_id)}${src.agent_id ? ` · agent ${esc(src.agent_id)}` : ''} · ${esc(src.kind)} · identity ${esc(src.identity_assurance)}`],
  ...(t.recorded_by.session_id !== src.session_id ? [['Recorded by', `session ${esc(t.recorded_by.session_id)}${t.proposal_id ? ` (accepted proposal ${esc(t.proposal_id)})` : ''}`] as [string, string]] : []),
  ['Stated confidence', `${esc(t.stated_confidence)} <span class="muted">(the source's claim)</span>`],
  ['Recorded', `version ${esc(t.version)} · after checkpoint ${esc(t.after_checkpoint)} · ${esc(t.created_at)}`],
  ...(t.supersedes ? [['Supersedes', esc(t.supersedes)] as [string, string]] : []),
  ...(t.superseded_by ? [['Superseded by', `${esc(t.superseded_by)} — ${esc(t.supersession_reason)}`] as [string, string]] : []),
  ...(t.task ? [['Responsible session', esc(t.task.responsible_session_id)] as [string, string]] : []),
  ...(t.refs.length ? [['References', esc(JSON.stringify(t.refs))] as [string, string]] : []),
  ...(t.origin ? [['Origin (fork)', esc(JSON.stringify(t.origin))] as [string, string]] : []),
  ['Record', a(`${d.links.self.split('?')[0]}/knowledge/${t.id}.json`, 'JSON')],
])}
${t.annotations.length ? `<p><strong>Annotations</strong></p><ul>${t.annotations.map((n) => `<li>${esc(n.id)} ${upper(n.kind)} by ${esc(n.source.session_id)} (${esc(n.source.identity_assurance)}): ${esc(n.content)}${n.evidence ? ` <span class="muted">evidence: ${esc(JSON.stringify(n.evidence))}</span>` : ''}${'note' in n ? ` <em>${esc(n.note)}</em>` : ''}</li>`).join('')}</ul>` : ''}
</article>`;
  })
  .join('\n')}`;

  const tasks = d.authority.task_responsibility;
  const handoffs = `
<h2>TASKS &amp; HANDOFFS</h2>
${tasks.length ? `<table><tr><th>Task</th><th>Title</th><th>Status</th><th>Responsible session</th><th>Pending handoff</th></tr>${tasks.map((t) => `<tr><td>${esc(t.tok_id)}</td><td>${esc(t.title)}</td><td>${esc(t.status)}</td><td>${esc(t.responsible_session_id)}</td><td>${esc(t.pending_handoff ?? '—')}</td></tr>`).join('')}</table>` : '<p>No task TOKs.</p>'}
${d.handoffs.length ? `<table><tr><th>Handoff</th><th>Task</th><th>From</th><th>To</th><th>Status</th><th>Note</th></tr>${d.handoffs.map((h) => `<tr><td>${esc(h.id)}</td><td>${esc(h.tok_id)}</td><td>${esc(h.from.session_id)}</td><td>${esc(h.to.session_id)}</td><td>${esc(h.status)}</td><td>${esc(h.note)}</td></tr>`).join('')}</table>` : ''}
<p class="muted">A handoff moves responsibility for one task only after the addressed session acknowledges it. It never transfers ownership or authority.</p>`;

  const proposals = `
<h2>PROPOSALS (OPERATION INTENTS)</h2>
${d.proposals.length ? `<table><tr><th>ID</th><th>Operation</th><th>Requested by</th><th>Status</th><th>Rationale</th></tr>${d.proposals.map((p) => `<tr><td>${esc(p.id)}</td><td>${esc(p.operation)}</td><td>${esc(p.requested_by.session_id)} (${esc(p.requested_by.identity_assurance)})</td><td>${esc(p.status)}</td><td>${esc(p.rationale)}</td></tr>`).join('')}</table>` : '<p>No proposals.</p>'}
<p class="muted">A proposal is an operation someone wants performed but has no authority to perform. Only the owner can accept (execute) or reject it.</p>`;

  const ops = `
<h2 id="operations">AVAILABLE OPERATIONS</h2>
<table><tr><th>Operation</th><th>Purpose</th><th>Method</th><th>Required authority</th><th>Permitted for you</th><th>Prepare</th></tr>
${d.operations
  .map(
    (o) => `<tr><td>${a(o.doc_href, o.name.toUpperCase())}</td><td>${esc(o.purpose)}</td><td>${esc(o.method)}</td><td>${esc(o.authority_text)}</td><td class="${o.permitted_for_viewer ? 'yes' : 'no'}">${o.permitted_for_viewer ? 'yes' : 'no'} <span class="muted">— ${esc(o.reason)}</span></td><td>${o.prepare_href ? a(o.prepare_href, 'prepare') : a(o.href, 'open')}</td></tr>`,
  )
  .join('\n')}
</table>
<p class="muted">GET never changes state. "prepare" links return a ready-to-submit request and form; opening them changes nothing.</p>`;

  const del = d.authority.delegations;
  const authority = `
<h2>OWNERSHIP · ACCESS · AUTHORITY</h2>
${kv([
  ['Ownership', `${esc(owner.session_id)} — ${esc(d.ownership.meaning)}`],
  ['Access', `${esc(d.access.visibility)} — ${esc(d.access.meaning)}`],
  ['Proposals', d.access.accepts_proposals ? 'accepted' : 'closed'],
  ['Authority', esc(d.authority.model)],
])}
<h3>DELEGATIONS (${del.length})</h3>
${del.length ? `<table><tr><th>Capability</th><th>Session</th><th>Scopes</th><th>Status</th><th>Expires</th><th>Delegated by</th></tr>${del.map((c) => `<tr><td>${esc(c.id)}</td><td>${esc(c.session_id)}</td><td>${esc(c.scopes.join(', '))}</td><td>${esc(c.status)}</td><td>${esc(c.expires_at ?? 'never')}</td><td>${esc(c.delegated_by)}</td></tr>`).join('')}</table>` : '<p>No delegations.</p>'}`;

  const checkpoints = `
<h2>CHECKPOINTS</h2>
<table><tr><th>#</th><th>Label</th><th>Version</th><th>By</th><th>SHA-256</th><th></th></tr>
${d.checkpoints.map((c) => `<tr><td>${esc(c.number)}</td><td>${esc(c.label)}</td><td>${esc(c.version)}</td><td>${esc(c.created_by.session_id)}</td><td class="muted">${esc(c.sha256.slice(0, 23))}…</td><td>${a(c.href, 'snapshot')}</td></tr>`).join('')}
</table>`;

  const lin = r.lineage;
  const lineage = `
<h2>LINEAGE</h2>
${lin.parent ? `<p>Forked from ${a(lin.parent.url, lin.parent.id)} ("${esc(lin.parent.title)}") at version ${esc(lin.parent.version)}${lin.parent.checkpoint !== null ? `, checkpoint ${esc(lin.parent.checkpoint)}` : ''}.</p>` : '<p>Root resource (no parent).</p>'}
${lin.forks.length ? `<p>Forks:</p><ul>${lin.forks.map((f) => `<li>${a(f.url, f.id)} "${esc(f.title)}" — owner ${esc(f.owner_session_id)}, from version ${esc(f.from_version)}</li>`).join('')}</ul>` : '<p>No forks.</p>'}
<p class="muted">${esc(lin.note)}</p>`;

  const prov = `
<h2>PROVENANCE — RECENT EVENTS</h2>
<table><tr><th>Version</th><th>Operation</th><th>Actor</th><th>Identity</th><th>Summary</th><th>When</th></tr>
${d.provenance.recent_events.map((e) => `<tr><td>${esc(e.parent_version)}→${esc(e.version)}</td><td>${esc(e.operation)}</td><td>${esc(e.actor.session_id)}${e.on_behalf_of ? ` <span class="muted">for ${esc(e.on_behalf_of.session_id)}</span>` : ''}</td><td>${esc(e.identity_assurance)}</td><td>${esc(e.summary)}</td><td>${esc(e.occurred_at)}</td></tr>`).join('')}
</table>
<p>Full history: ${a(d.links.events, d.links.events)}</p>`;

  const machine = `
<h2>MACHINE REPRESENTATION</h2>
${kv([
  ['JSON', a(d.links.json, d.links.json)],
  ['Status', a(d.links.status, d.links.status)],
  ['Operations', a(d.links.operations, d.links.operations)],
  ['Events', a(d.links.events, d.links.events)],
  ['Checkpoints', a(d.links.checkpoints, d.links.checkpoints)],
  ['Protocol', a(d.links.protocol, d.links.protocol)],
  ['Explorer', a(d.links.explorer, d.links.explorer)],
])}
<p class="muted">This page embeds the identical JSON document in &lt;script type="application/json" id="acsp-document"&gt;.</p>`;

  return page({
    title: `ACSP ${r.id} — ${r.title}`,
    doc: d,
    jsonHref: d.links.json,
    body: [header, agentAccess, bootstrap, what, knowledge, handoffs, proposals, ops, authority, checkpoints, lineage, prov, machine].join('\n'),
  });
}

// ── generic document page (events, checkpoints, diff, TOK, status, …) ─────

const TITLES: Record<string, string> = {
  status: 'RESOURCE STATUS',
  event_list: 'EVENT HISTORY',
  event: 'EVENT',
  tok: 'KNOWLEDGE TRANSFER (TOK)',
  checkpoint_list: 'CHECKPOINTS',
  checkpoint: 'CHECKPOINT',
  diff: 'DIFF',
  operation_list: 'OPERATIONS',
  discovery: 'ACSP SERVICE',
};

export function renderDocumentPage(doc: Record<string, unknown> & { type: string; notice?: string; links?: Record<string, string> }, jsonHref: string): string {
  const links = doc.links ?? {};
  const events = (doc.events as { version: number; operation: string; actor: { session_id: string }; identity_assurance: string; summary: string }[] | undefined) ?? [];
  const table = events.length
    ? `<table><tr><th>Version</th><th>Operation</th><th>Actor</th><th>Identity</th><th>Summary</th></tr>${events.map((e) => `<tr><td>${esc(e.version)}</td><td>${esc(e.operation)}</td><td>${esc(e.actor.session_id)}</td><td>${esc(e.identity_assurance)}</td><td>${esc(e.summary)}</td></tr>`).join('')}</table>`
    : '';
  return page({
    title: `ACSP — ${TITLES[doc.type] ?? doc.type}`,
    doc,
    jsonHref,
    body: `
<h1>${esc(TITLES[doc.type] ?? doc.type.toUpperCase())}</h1>
<p class="notice">${esc(doc.notice ?? '')}<br>JSON: ${a(jsonHref, jsonHref)}</p>
${links.self ? `<p>Resource: ${a(links.self, links.self)} · Protocol: ${a(links.protocol, links.protocol)}</p>` : ''}
${table}
<pre>${pretty(doc)}</pre>`,
  });
}

// ── operation intent page ─────────────────────────────────────────────────

export function renderIntentPage(d: IntentDocument, jsonHref: string): string {
  const v = d.validation;
  return page({
    title: `ACSP — prepare ${d.operation}`,
    doc: d,
    jsonHref,
    body: `
<h1>OPERATION INTENT — ${upper(d.operation)}</h1>
<p class="notice"><strong>${esc(d.status)}</strong><br>${esc(d.notice)}</p>
${kv([
  ['Operation', esc(d.operation)],
  ['Resource', d.resource_id ? `${esc(d.resource_id)} at version ${esc(d.resource_version)}` : 'new resource'],
  ['Purpose', esc(d.purpose)],
  ['Required authority', esc(d.required_authority)],
  ['Permitted for you', d.viewer_permitted ? '<span class="yes">yes</span>' : `<span class="no">no</span>${d.viewer_reason ? ` — ${esc(d.viewer_reason)}` : ''}`],
  ['Request valid', v.valid ? '<span class="yes">yes</span>' : `<span class="no">no</span> — ${esc(JSON.stringify(v.issues))}`],
  ['Execute', `POST ${esc(d.execution.href)} · ${esc(d.execution.authorization)}`],
  ['JSON', a(jsonHref, jsonHref)],
])}
<h2>INSTRUCTIONS</h2>
<ol>${d.instructions.map((i) => `<li>${esc(i)}</li>`).join('')}</ol>
<h2>REQUEST</h2>
<pre>${pretty(d.request)}</pre>
<h2>SUBMIT (HUMAN / OPERATOR)</h2>
<form method="post" action="${esc(d.execution.href)}">
<p><label>Request (JSON envelope — review before submitting)<br>
<textarea name="request" rows="18">${esc(JSON.stringify(d.request, null, 2))}</textarea></label></p>
<p><label>Capability (leave empty if none is required)<br>
<input type="password" name="capability" autocomplete="off" spellcheck="false"></label></p>
<button type="submit">Execute ${esc(d.operation)}</button>
</form>
<h2>CURL</h2>
<pre>${esc(d.execution.curl)}</pre>`,
  });
}

// ── operation result / error ──────────────────────────────────────────────

export function renderResultPage(result: Record<string, unknown>, resourceUrl: string | null): string {
  const tokens = JSON.stringify(result).includes('"token":"acsp_');
  return page({
    title: `ACSP — ${String(result.operation ?? 'result')}`,
    doc: result,
    body: `
<h1>OPERATION ${result.replayed ? 'REPLAYED' : 'PERFORMED'} — ${upper(String(result.operation ?? ''))}</h1>
<p class="notice">Resource ${esc(result.resource_id)} is now at version ${esc(result.version)}.${result.replayed ? ' This was an idempotent replay: no new event was created.' : ''}</p>
${tokens ? '<p class="notice"><strong>This response contains a capability token. It is shown ONCE. Store it as a secret now.</strong></p>' : ''}
${resourceUrl ? `<p>${a(resourceUrl, 'Open the resource →')}</p>` : ''}
<pre>${pretty(result)}</pre>`,
  });
}

export function renderErrorPage(status: number, error: { code: string; message: string; details?: unknown }, protocolHref: string): string {
  const doc = { ok: false, protocol: PROTOCOL_VERSION, error };
  return page({
    title: `ACSP error — ${error.code}`,
    doc,
    body: `
<h1>ACSP ERROR ${esc(status)} — ${esc(error.code)}</h1>
<p class="notice">${esc(error.message)}</p>
${error.details ? `<pre>${pretty(error.details)}</pre>` : ''}
<p>Protocol reference: ${a(protocolHref, protocolHref)}</p>`,
  });
}

// ── protocol page ─────────────────────────────────────────────────────────

export function renderProtocolPage(p: ProtocolDocument, jsonHref: string): string {
  const ops = p.operations
    .map(
      (o) => `<article class="tok" id="op-${esc(o.name)}">
<h3>${upper(o.name)} <span class="muted">· ${esc(o.family)} · ${o.mutation ? 'mutation' : 'read'}</span></h3>
${kv([
  ['Purpose', esc(o.purpose)],
  ['Invocation', `${esc(o.invocation.method)} ${esc(o.invocation.path)}`],
  ['Required authority', esc(o.authority_text)],
  ['expected_version', o.requires_expected_version ? 'required' : 'optional'],
  ['Proposable', o.proposable ? 'yes' : 'no'],
  ['Input', esc(o.input)],
  ['Output', esc(o.output)],
  ['Side effects', esc(o.side_effects)],
  ['Provenance', esc(o.provenance)],
  ['Failures', esc(o.failures.join(' · '))],
])}
${o.payload_schema ? `<details><summary>Payload JSON Schema</summary><pre>${pretty(o.payload_schema)}</pre></details>` : ''}
</article>`,
    )
    .join('\n');
  return page({
    title: `${p.protocol.version} — ${p.protocol.title}`,
    doc: p,
    jsonHref,
    body: `
<h1>${esc(p.protocol.version)} — ${upper(p.protocol.title)}</h1>
<p class="notice">${esc(p.summary)}<br>JSON: ${a(jsonHref, jsonHref)}</p>
<h2>INVARIANTS</h2><ul>${p.invariants.map((i) => `<li>${esc(i)}</li>`).join('')}</ul>
<h2>CONCEPTS</h2><pre>${pretty(p.concepts)}</pre>
<h2>REQUEST ENVELOPE</h2><pre>${pretty(p.envelope)}</pre>
<h2>READING</h2><pre>${pretty(p.reading)}</pre>
<h2>OPERATIONS</h2>${ops}
<h2>KNOWLEDGE (TOK) MODEL</h2><pre>${pretty(p.knowledge)}</pre>
<h2>SCOPES</h2><pre>${pretty(p.scopes)}</pre>
<h2>ERRORS</h2><pre>${pretty(p.errors)}</pre>
<h2>AGENT BOOTSTRAP</h2><pre>${esc(p.bootstrap_text)}</pre>`,
  });
}

// ── home ──────────────────────────────────────────────────────────────────

export function renderHomePage(d: { links: Record<string, string>; notice: string; invariants: readonly string[] }, jsonHref: string): string {
  return page({
    title: `${PROTOCOL_VERSION} — Agent Continuity & Session Protocol`,
    doc: d,
    jsonHref,
    body: `
<h1>ACSP — AGENT CONTINUITY &amp; SESSION PROTOCOL</h1>
<p class="rule">────────────────────────────────────────</p>
<p class="notice">This service hosts <strong>Agent Continuity Resources</strong>: HTTPS resources through which independent AI sessions
(and humans) exchange explicitly published knowledge and operations while keeping separate identity, ownership, authority and provenance.<br>
Protocol: <strong>${PROTOCOL_VERSION}</strong> · JSON: ${a(jsonHref, jsonHref)}</p>
<h2>INVARIANTS</h2><ul>${d.invariants.map((i) => `<li>${esc(i)}</li>`).join('')}</ul>
<h2>START</h2>
<ul>
<li>${a(d.links.new_resource, 'Create a continuity resource')} (prepares a create request and form; nothing is created until you submit it)</li>
<li>${a(d.links.protocol, 'Read the protocol')} — operations, authority, TOK model, errors, agent bootstrap</li>
<li>Given a resource URL (<code>/r/XXXXXXXXXXXX</code>)? Open it; it explains itself.</li>
</ul>
<h2>FOR AI AGENTS</h2>
<p>${esc(d.notice)}</p>`,
  });
}

// ── explorer ──────────────────────────────────────────────────────────────

export function renderExplorerPage(d: ResourceDocument, events: ResourceDocument['provenance']['recent_events'], ancestry: { id: string; title: string; url: string }[]): string {
  const r = d.resource;
  const tree = [
    ...ancestry.map((x, i) => `${'  '.repeat(i)}${i ? '└─ ' : ''}${x.id}  ${x.title}`),
    `${'  '.repeat(ancestry.length)}${ancestry.length ? '└─ ' : ''}${r.id}  ${r.title}   ◀ this resource`,
    ...r.lineage.forks.map((f, i, all) => `${'  '.repeat(ancestry.length + 1)}${i === all.length - 1 ? '└─ ' : '├─ '}${f.id}  ${f.title}  (owner ${f.owner_session_id}, from v${f.from_version})`),
  ].join('\n');
  return page({
    title: `ACSP explorer — ${r.id}`,
    doc: { resource: d, events },
    body: `
<h1>PROTOCOL EXPLORER — ${esc(r.id)}</h1>
<p class="notice">Developer/operator view of the substrate. The agent-facing surface is ${a(d.links.self, d.links.self)}.</p>
<h2>RESOURCE</h2>${kv([
  ['Title', esc(r.title)],
  ['Lifecycle / version', `${esc(d.state.lifecycle)} / ${esc(d.state.version)}`],
  ['Owner', esc(d.ownership.owner.session_id)],
  ['Visibility', esc(d.access.visibility)],
  ['Counts', esc(JSON.stringify(d.state.counts))],
])}
<h2>BRANCHES</h2><pre>${esc(tree)}</pre>
<h2>EVENTS (${events.length})</h2>
<table><tr><th>v</th><th>parent</th><th>operation</th><th>actor</th><th>identity</th><th>capability</th><th>on behalf of</th><th>proposal</th><th>summary</th><th>idempotency key</th></tr>
${events.map((e) => `<tr><td>${esc(e.version)}</td><td>${esc(e.parent_version)}</td><td>${esc(e.operation)}</td><td>${esc(e.actor.session_id)}${e.actor.agent_id ? `/${esc(e.actor.agent_id)}` : ''}</td><td>${esc(e.identity_assurance)}</td><td>${esc(e.capability_id ?? '—')}</td><td>${esc(e.on_behalf_of?.session_id ?? '—')}</td><td>${esc(e.proposal_id ?? '—')}</td><td>${esc(e.summary)}</td><td class="muted">${esc(e.idempotency_key)}</td></tr>`).join('')}
</table>
<h2>KNOWLEDGE</h2>
<table><tr><th>id</th><th>type</th><th>status</th><th>title</th><th>source</th><th>recorded by</th><th>v</th><th>supersedes</th><th>superseded by</th></tr>
${d.knowledge.items.map((t) => `<tr><td>${esc(t.id)}</td><td>${esc(t.type)}</td><td>${esc(t.status)}</td><td>${esc(t.title)}</td><td>${esc(t.source.session_id)} (${esc(t.source.identity_assurance)})</td><td>${esc(t.recorded_by.session_id)}</td><td>${esc(t.version)}</td><td>${esc(t.supersedes ?? '')}</td><td>${esc(t.superseded_by ?? '')}</td></tr>`).join('')}
</table>
<h2>CHECKPOINTS</h2>
<table><tr><th>#</th><th>version</th><th>label</th><th>by</th><th>sha256</th></tr>
${d.checkpoints.map((c) => `<tr><td>${esc(c.number)}</td><td>${esc(c.version)}</td><td>${esc(c.label)}</td><td>${esc(c.created_by.session_id)}</td><td class="muted">${esc(c.sha256)}</td></tr>`).join('')}
</table>
<h2>OWNERSHIP &amp; DELEGATIONS</h2>
${kv([['Owner', esc(d.ownership.owner.session_id)], ['Owner capability', esc(d.authority.owner_capability?.id ?? '—')]])}
<table><tr><th>capability</th><th>session</th><th>scopes</th><th>status</th><th>expires</th></tr>
${d.authority.delegations.map((c) => `<tr><td>${esc(c.id)}</td><td>${esc(c.session_id)}</td><td>${esc(c.scopes.join(', '))}</td><td>${esc(c.status)}</td><td>${esc(c.expires_at)}</td></tr>`).join('')}
</table>
<h2>TASKS, HANDOFFS, PROPOSALS</h2>
<pre>${pretty({ tasks: d.authority.task_responsibility, handoffs: d.handoffs, proposals: d.proposals })}</pre>
<h2>OPERATIONS</h2>
<table><tr><th>operation</th><th>family</th><th>authority</th><th>expected_version</th><th>proposable</th></tr>
${d.operations.map((o) => `<tr><td>${esc(o.name)}</td><td>${esc(o.family)}</td><td>${esc(o.required_authority)}</td><td>${o.requires_expected_version ? 'required' : ''}</td><td>${o.proposable ? 'yes' : ''}</td></tr>`).join('')}
</table>`,
  });
}
