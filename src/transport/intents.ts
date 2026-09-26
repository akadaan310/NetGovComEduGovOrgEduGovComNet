/**
 * Operation intents for browser-only agents.
 *
 * GET /r/{id}?action=prepare_{op} (and GET /new for create) returns a
 * complete, ready-to-submit request plus an HTML form. Opening it changes
 * NOTHING — this is how an agent that can only open URLs expresses an
 * operation for a human to review and execute.
 */
import { crockford } from '../continuity/ids';
import type { Random } from '../continuity/env';
import { protocolHeader, type Links, type ResourceDocument } from '../continuity/representation';
import { formatIssue, validatePayload } from '../continuity/validate';
import { NOTICE } from '../protocol/bootstrap';
import { PROTOCOL_VERSION } from '../protocol/constants';
import { AcspError } from '../protocol/errors';
import { EnvelopeSchema, OPERATIONS_BY_NAME, type OperationSpec } from '../protocol/operations';

const TEMPLATES: Record<string, Record<string, unknown>> = {
  create: { title: '', description: '', focus: '', visibility: 'unlisted', accepts_proposals: true },
  append: { type: 'finding', title: '', summary: '', content: '', stated_confidence: 'unclassified', refs: [] },
  annotate: { tok_id: 'TOK-001', kind: 'comment', content: '' },
  update: { focus: '' },
  supersede: { target: 'TOK-001', reason: '', replacement: { type: 'hypothesis', title: '', content: '' } },
  checkpoint: { label: '', note: '' },
  fork: { title: '', reason: '' },
  delegate: { to: { session_id: '' }, scopes: ['append'], expires_in_seconds: 86400, label: '' },
  revoke: { capability_id: 'cap_XXXXXXXXXX', reason: '' },
  handoff: { tok_id: 'TOK-001', to: { session_id: '' }, note: '' },
  acknowledge: { handoff_id: 'HO-001', decision: 'accept', note: '' },
  propose: { operation: 'append', payload: { type: 'finding', title: '', content: '' }, rationale: '' },
  resolve_proposal: { proposal_id: 'P-001', decision: 'accept', note: '' },
  close: { reason: '', final_note: '' },
  embody: { note: '' },
  release: { embodiment_id: 'EMB-001', reason: '' },
  set_substrate: { substrate_id: 'deterministic-calculator', reason: '' },
  announce: { kind: 'availability', statement: '', refs: [] },
  create_scroll: { scroll: { purpose: '', inputs: ['a', 'b'], operations: [{ operation: 'multiply', arguments: ['a', 'b'] }] } },
  version_scroll: { scroll_id: 'SCR-001', parent_version: 1, scroll: { purpose: '', inputs: ['a', 'b'], operations: [{ operation: 'multiply', arguments: ['a', 'b'] }] }, reason: '' },
  set_alias: { name: '', target: { scroll_id: 'SCR-001', version: 1 }, reason: '' },
  execute: { target: { alias: '' }, inputs: {} },
  discover_new_operation: {
    candidate: { purpose: '', inputs: ['a', 'b'], operations: [{ operation: 'add', arguments: ['a', 'b'] }] },
    trials: [{ inputs: { a: 1, b: 2 } }],
    propose: false,
    rationale: '',
  },
};

/**
 * Query parameters prefill a payload field only when the operation's template
 * has that field (so `kind` means an annotation kind for annotate and nothing
 * elsewhere). For propose and supersede, TOK fields go to the inner TOK.
 */
const SIMPLE_FIELDS = [
  'type', 'title', 'summary', 'content', 'stated_confidence', 'tok_id', 'kind', 'label', 'note', 'reason',
  'target', 'by', 'handoff_id', 'proposal_id', 'decision', 'capability_id', 'focus', 'description', 'rationale',
  'visibility', 'substrate_id', 'embodiment_id', 'name', 'statement', 'scroll_id',
];
const TOK_FIELDS = new Set(['type', 'title', 'summary', 'content', 'stated_confidence']);
const PLACEHOLDER_SESSION = '<your-session-id>';

function prefill(op: string, q: URLSearchParams): Record<string, unknown> {
  const payload: Record<string, unknown> = structuredClone(TEMPLATES[op] ?? {});
  const raw = q.get('payload');
  if (raw) {
    try {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) Object.assign(payload, parsed);
    } catch {
      throw new AcspError('malformed_request', 'The "payload" query parameter must be a JSON object.');
    }
  }
  for (const f of SIMPLE_FIELDS) {
    const v = q.get(f);
    if (v === null) continue;
    if (op === 'propose' && TOK_FIELDS.has(f)) (payload.payload as Record<string, unknown>)[f] = v;
    else if (op === 'supersede' && TOK_FIELDS.has(f)) (payload.replacement as Record<string, unknown>)[f] = v;
    else if (f in (TEMPLATES[op] ?? {})) payload[f] = v;
  }
  if (op === 'propose' && q.get('proposed_operation')) {
    payload.operation = q.get('proposed_operation');
    // A proposal for a Program 001 operation starts from that operation's template.
    if (payload.operation !== 'append' && TEMPLATES[String(payload.operation)] && !raw) payload.payload = structuredClone(TEMPLATES[String(payload.operation)]);
  }
  const alias = q.get('alias');
  if (alias && op === 'execute') payload.target = { alias };
  if (alias && op === 'propose' && payload.operation === 'execute') (payload.payload as Record<string, unknown>).target = { alias };
  if (op === 'create' && q.get('kind')) payload.kind = q.get('kind');
  const to = q.get('to_session_id');
  if (to && (op === 'delegate' || op === 'handoff')) payload.to = { session_id: to };
  const scopes = q.get('scopes');
  if (scopes && op === 'delegate') payload.scopes = scopes.split(',').map((s) => s.trim()).filter(Boolean);
  return payload;
}

/** Validate the whole prepared request (envelope and payload) so problems show before submission. */
function validationOf(spec: OperationSpec, request: Record<string, unknown>) {
  const issues: unknown[] = [];
  const env = EnvelopeSchema.safeParse(request);
  if (!env.success) issues.push(...env.error.issues.map(formatIssue));
  if ((request.actor as { session_id?: string }).session_id === PLACEHOLDER_SESSION) {
    issues.push({ path: 'actor.session_id', message: 'replace the placeholder with your session id (or add &session_id=… to this URL)' });
  }
  try {
    validatePayload(spec, request.payload);
  } catch (e) {
    if (!(e instanceof AcspError)) throw e;
    issues.push(...(((e.details?.issues as unknown[]) ?? [e.message]).map((i) => (typeof i === 'object' ? { ...i, path: `payload.${(i as { path: string }).path}` } : i))));
  }
  return { valid: issues.length === 0, issues };
}

export function intentDocument(opts: {
  op: string;
  query: URLSearchParams;
  links: Links;
  random: Random;
  resource?: ResourceDocument;
}) {
  const spec = OPERATIONS_BY_NAME[opts.op];
  if (!spec || !spec.mutation) {
    throw new AcspError('unknown_operation', `"${opts.op}" is not a mutating ${PROTOCOL_VERSION} operation that can be prepared.`);
  }
  const doc = opts.resource;
  if (spec.name !== 'create' && !doc) throw new AcspError('malformed_request', 'Only "create" can be prepared without a resource.');

  const payload = prefill(spec.name, opts.query);
  const session = opts.query.get('session_id') ?? doc?.viewer.session_id ?? PLACEHOLDER_SESSION;
  const agent = opts.query.get('agent_id');
  const request: Record<string, unknown> = {
    protocol: PROTOCOL_VERSION,
    operation: spec.name,
    actor: { session_id: session, ...(agent ? { agent_id: agent } : {}), kind: opts.query.get('actor_kind') ?? 'agent' },
    ...(doc ? { expected_version: doc.state.version } : {}),
    idempotency_key: `intent-${crockford(opts.random, 16)}`,
    payload,
  };
  const href = spec.name === 'create' ? opts.links.plain('/r') : opts.links.plain(`/r/${doc!.resource.id}/operations`);
  const entry = doc?.operations.find((o) => o.name === spec.name);
  const needsCapability = spec.authority.kind !== 'none' && spec.authority.kind !== 'read';
  const body = JSON.stringify(request);
  return {
    protocol: protocolHeader(opts.links),
    type: 'operation_intent',
    notice: NOTICE,
    status: 'prepared — NOT executed. Opening this document changed nothing.',
    operation: spec.name,
    resource_id: doc?.resource.id ?? null,
    resource_version: doc?.state.version ?? null,
    purpose: spec.purpose,
    required_authority: spec.authority_text,
    viewer_permitted: entry ? entry.permitted_for_viewer : spec.name === 'create',
    viewer_reason: entry?.reason ?? null,
    requested_by: { session_id: session, agent_id: agent },
    validation: validationOf(spec, request),
    request,
    execution: {
      method: 'POST',
      href,
      content_type: 'application/json',
      authorization: needsCapability ? 'Authorization: Bearer <capability with the required authority>' : 'none required',
      curl:
        `curl -sS -X POST '${href}' -H 'Content-Type: application/json'` +
        (needsCapability ? ` -H "Authorization: Bearer $ACSP_CAPABILITY"` : '') +
        ` --data '${body.replace(/'/g, "'\\''")}'`,
      form: 'The HTML version of this page contains a form that submits this request without JavaScript.',
    },
    instructions: [
      'An agent that cannot POST: give this URL to your human. They review the request, add a capability if one is required, and submit the form.',
      'Edit the query parameters to change the request: session_id, agent_id, actor_kind, payload fields (e.g. &title=...&content=...), or payload=<JSON object>. "validation" shows whether it is acceptable.',
      spec.requires_expected_version
        ? 'expected_version is required: if the resource changes before submission the request fails with stale_version — re-open this page.'
        : 'expected_version is set to the version you saw; remove it if you do not need that guarantee.',
      'Resubmitting the same request with the same idempotency_key is safe: it returns the original result without creating a second event.',
    ],
    links: doc?.links ?? { protocol: opts.links.plain('/protocol'), home: opts.links.plain('/') },
  };
}
export type IntentDocument = ReturnType<typeof intentDocument>;
