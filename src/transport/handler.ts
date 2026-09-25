/**
 * TRANSPORT LAYER — the complete ACSP HTTP surface as one Fetch-API handler:
 * `(Request) => Promise<Response>`. Next.js mounts it (app/[[...path]]/route.ts);
 * the harness calls it directly.
 */
import { verifyCapability } from '../continuity/authority';
import { executeMutation } from '../continuity/engine';
import type { Env } from '../continuity/env';
import {
  assertCanRead,
  buildResourceDocument,
  checkpointDocument,
  checkpointsDocument,
  diffDocument,
  eventDocument,
  eventsDocument,
  Links,
  loadResourceView,
  operationsDocument,
  statusDocument,
  tokDocument,
  type Viewer,
} from '../continuity/representation';
import { loadCheckpoints, loadEvents, loadResource } from '../continuity/state';
import { eventRecord } from '../continuity/records';
import { NOTICE, bootstrapDocument } from '../protocol/bootstrap';
import { INVARIANTS, PROTOCOL_VERSION, RESOURCE_LIMITS } from '../protocol/constants';
import { protocolDocument } from '../protocol/document';
import { AcspError } from '../protocol/errors';
import {
  renderDocumentPage,
  renderErrorPage,
  renderExplorerPage,
  renderHomePage,
  renderIntentPage,
  renderProtocolPage,
  renderResourcePage,
  renderResultPage,
} from './html';
import { bearer, clientKey, htmlResponse, jsonResponse, negotiate, readBody, securityHeaders, type Format } from './http';
import { intentDocument } from './intents';
import { consumeRateLimit } from './ratelimit';

const RESOURCE_ID = '([0-9A-HJKMNP-TV-Z]{12})';
const ROUTES = {
  resource: new RegExp(`^/r/${RESOURCE_ID}$`),
  sub: new RegExp(`^/r/${RESOURCE_ID}/(operations|events|checkpoints|diff|explorer|knowledge)(?:/([A-Za-z0-9-]+))?$`),
};

export type Handler = (req: Request) => Promise<Response>;

export function createHandler(getEnv: () => Promise<Env> | Env): Handler {
  return async (req) => {
    const url = new URL(req.url);
    const negotiated = negotiate(req, url);
    const { path } = negotiated;
    // POST errors default to JSON unless the request came from an HTML form.
    const isForm = (req.headers.get('content-type') ?? '').includes('application/x-www-form-urlencoded');
    const format: Format = req.method === 'POST' && !isForm && url.searchParams.get('format') !== 'html' ? 'json' : negotiated.format;
    let env: Env | null = null;
    try {
      env = await getEnv();
      const headers = securityHeaders(env.config.production);
      const base = env.config.publicUrl ?? url.origin;
      if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers });
      if (req.method === 'GET' || req.method === 'HEAD') {
        const res = await handleGet(env, req, url, path, format, base, headers);
        return req.method === 'HEAD' ? new Response(null, { status: res.status, headers: res.headers }) : res;
      }
      if (req.method === 'POST') return await handlePost(env, req, url, path, format, base, headers);
      throw new AcspError('method_not_allowed', `${req.method} is not supported. ACSP uses GET (safe reads) and POST (operations).`);
    } catch (err) {
      return errorResponse(err, format, env, url);
    }
  };
}

function errorResponse(err: unknown, format: Format, env: Env | null, url: URL): Response {
  const headers = securityHeaders(env?.config.production ?? false);
  const base = env?.config.publicUrl ?? url.origin;
  let e: AcspError;
  if (err instanceof AcspError) e = err;
  else {
    console.error('[acsp] unhandled error', err);
    e = new AcspError('internal_error', 'An internal error occurred. No partial changes were applied.');
  }
  if (e.code === 'rate_limited' && e.details?.retry_after_seconds) headers['Retry-After'] = String(e.details.retry_after_seconds);
  if (e.code === 'method_not_allowed') headers.Allow = 'GET, HEAD, POST, OPTIONS';
  const protocolHref = new URL('/protocol', base).toString();
  return format === 'json'
    ? jsonResponse({ ok: false, protocol: PROTOCOL_VERSION, error: e.toJSON(), links: { protocol: protocolHref } }, e.status, headers)
    : htmlResponse(renderErrorPage(e.status, e.toJSON(), protocolHref), e.status, headers);
}

/** Resolve the viewer for a GET: Authorization header or ?cap=. Failures are reported, not fatal. */
async function resolveViewer(env: Env, req: Request, url: URL): Promise<Viewer> {
  const capParam = url.searchParams.get('cap') ?? undefined;
  const token = bearer(req) ?? capParam;
  if (!token) return { cap: null };
  try {
    return { cap: await verifyCapability(env.db, token, env.clock.now()), capParam };
  } catch (err) {
    if (err instanceof AcspError) return { cap: null, credentialError: { code: err.code, message: err.message } };
    throw err;
  }
}

function jsonUrl(url: URL, path: string): string {
  const u = new URL(url.toString());
  u.pathname = path === '/' ? '/index.json' : `${path}.json`;
  u.searchParams.delete('format');
  return u.toString();
}

function discoveryDocument(base: string) {
  const u = (p: string) => new URL(p, base).toString();
  return {
    protocol: { name: 'ACSP', version: PROTOCOL_VERSION, spec: u('/protocol'), spec_json: u('/protocol.json') },
    type: 'discovery',
    notice: NOTICE,
    invariants: [...INVARIANTS],
    description:
      'This service hosts Agent Continuity Resources at /r/{id}. Each resource explains itself (HTML and JSON), ' +
      'lists the operations available and whether you may perform them, and records every change with provenance.',
    bootstrap: bootstrapDocument(),
    endpoints: {
      resource: u('/r/{id}'),
      create: { method: 'POST', href: u('/r'), prepare: u('/new') },
      operations: { method: 'POST', href: u('/r/{id}/operations') },
    },
    links: { home: u('/'), protocol: u('/protocol'), protocol_json: u('/protocol.json'), new_resource: u('/new'), discovery: u('/.well-known/acsp') },
  };
}

async function handleGet(env: Env, req: Request, url: URL, path: string, format: Format, base: string, headers: Record<string, string>): Promise<Response> {
  const respond = (doc: unknown, html: () => string, status = 200) =>
    format === 'json' ? jsonResponse(doc, status, headers) : htmlResponse(html(), status, headers);

  if (path === '/' || path === '/index' || path === '/.well-known/acsp') {
    const doc = discoveryDocument(base);
    if (path === '/.well-known/acsp') return jsonResponse(doc, 200, headers);
    return respond(doc, () => renderHomePage({ links: doc.links, notice: doc.notice, invariants: doc.invariants }, jsonUrl(url, '/')));
  }
  if (path === '/protocol') {
    const doc = protocolDocument(base);
    return respond(doc, () => renderProtocolPage(doc, jsonUrl(url, path)));
  }
  if (path === '/health') {
    await env.db.query('select 1');
    return jsonResponse({ ok: true, protocol: PROTOCOL_VERSION, database: env.db.kind }, 200, headers);
  }
  if (path === '/new') {
    const doc = intentDocument({ op: 'create', query: url.searchParams, links: new Links(base), random: env.random });
    return respond(doc, () => renderIntentPage(doc, jsonUrl(url, path)));
  }

  let m = ROUTES.resource.exec(path);
  const sub = m ? null : ROUTES.sub.exec(path);
  if (!m && !sub) throw new AcspError('not_found', `No ACSP endpoint at ${path}. Start at ${new URL('/', base)}.`);
  const id = (m ?? sub)![1];

  const viewer = await resolveViewer(env, req, url);
  const links = new Links(base, viewer.capParam);
  const resource = await loadResource(env.db, id);
  assertCanRead(resource, viewer);
  headers['ACSP-Resource-Version'] = String(resource.version);
  headers.Link = `<${links.resource(id, '.json')}>; rel="alternate"; type="application/json", <${links.plain('/protocol')}>; rel="describedby"`;
  const self = jsonUrl(url, path);
  const now = env.clock.now();

  const fullDocument = async () => buildResourceDocument(await loadResourceView(env.db, resource), viewer, links, now);

  if (m) {
    const action = url.searchParams.get('action') ?? 'inspect';
    if (action === 'inspect') {
      const doc = await fullDocument();
      return respond(doc, () => renderResourcePage(doc));
    }
    if (action === 'status') {
      const doc = statusDocument(resource, await loadCheckpoints(env.db, id), links);
      return respond(doc, () => renderDocumentPage(doc, withQuery(self, url)));
    }
    if (action.startsWith('prepare_')) {
      const doc = intentDocument({ op: action.slice(8), query: url.searchParams, links, random: env.random, resource: await fullDocument() });
      return respond(doc, () => renderIntentPage(doc, withQuery(self, url)));
    }
    // Query-string aliases for agents that can only edit query parameters.
    const alias: Record<string, string> = { operations: 'operations', events: 'events', checkpoints: 'checkpoints', diff: 'diff', retrieve: 'knowledge', explorer: 'explorer' };
    if (alias[action]) {
      return dispatchSub(env, url, format, alias[action], url.searchParams.get('tok') ?? url.searchParams.get('id') ?? undefined, resource, links, viewer, headers, self, fullDocument);
    }
    throw new AcspError('malformed_request', `Unknown action "${action}". Use inspect, status, operations, events, checkpoints, diff, retrieve, or prepare_<operation>.`);
  }
  return dispatchSub(env, url, format, sub![2], sub![3], resource, links, viewer, headers, self, fullDocument);
}

const withQuery = (jsonHref: string, url: URL) => {
  const u = new URL(jsonHref);
  url.searchParams.forEach((v, k) => k !== 'format' && u.searchParams.set(k, v));
  return u.toString();
};

async function dispatchSub(
  env: Env,
  url: URL,
  format: Format,
  kind: string,
  arg: string | undefined,
  resource: Awaited<ReturnType<typeof loadResource>>,
  links: Links,
  viewer: Viewer,
  headers: Record<string, string>,
  self: string,
  fullDocument: () => Promise<ReturnType<typeof buildResourceDocument>>,
): Promise<Response> {
  const respond = (doc: Record<string, unknown> & { type: string }) =>
    format === 'json' ? jsonResponse(doc, 200, headers) : htmlResponse(renderDocumentPage(doc, withQuery(self, url)), 200, headers);
  const int = (v: string | null | undefined, name: string): number | undefined => {
    if (v === null || v === undefined || v === '') return undefined;
    const n = Number(v);
    if (!Number.isInteger(n) || n < 0) throw new AcspError('malformed_request', `"${name}" must be a non-negative integer.`);
    return n;
  };
  const q = url.searchParams;
  switch (kind) {
    case 'operations':
      if (arg) break;
      return respond(operationsDocument(await fullDocument()));
    case 'events': {
      if (arg) return respond(await eventDocument(env.db, resource, links, int(arg, 'version')!));
      const limit = Math.min(int(q.get('limit'), 'limit') ?? RESOURCE_LIMITS.eventsPageMax, RESOURCE_LIMITS.eventsPageMax);
      return respond(await eventsDocument(env.db, resource, links, int(q.get('after'), 'after') ?? 0, limit));
    }
    case 'knowledge':
      if (!arg) break;
      return respond(await tokDocument(env.db, resource, links, arg));
    case 'checkpoints':
      if (arg) return respond(await checkpointDocument(env.db, resource, links, int(arg, 'checkpoint')!));
      return respond(await checkpointsDocument(env.db, resource, links));
    case 'diff':
      return respond(
        await diffDocument(env.db, resource, links, {
          from: int(q.get('from'), 'from'),
          to: int(q.get('to'), 'to'),
          sinceCheckpoint: int(q.get('since_checkpoint'), 'since_checkpoint'),
        }),
      );
    case 'explorer': {
      const doc = await fullDocument();
      const events = (await loadEvents(env.db, resource.id)).map(eventRecord);
      const ancestry: { id: string; title: string; url: string }[] = [];
      for (let p = resource.parent_id; p && ancestry.length < 32; ) {
        const pr = await loadResource(env.db, p);
        ancestry.unshift({ id: pr.id, title: pr.title, url: links.resource(pr.id) });
        p = pr.parent_id;
      }
      if (format === 'json') return jsonResponse({ ...doc, type: 'explorer', events, ancestry }, 200, headers);
      return htmlResponse(renderExplorerPage(doc, events, ancestry), 200, headers);
    }
  }
  throw new AcspError('not_found', `No ACSP endpoint at ${url.pathname}.`);
}

async function handlePost(env: Env, req: Request, url: URL, path: string, format: Format, base: string, headers: Record<string, string>): Promise<Response> {
  let resourceId: string | null;
  if (path === '/r') resourceId = null;
  else {
    const m = /^\/r\/([0-9A-HJKMNP-TV-Z]{12})\/operations$/.exec(path);
    if (!m) {
      throw new AcspError('method_not_allowed', `POST is accepted only at /r (create) and /r/{id}/operations. GET ${path} to read.`);
    }
    resourceId = m[1];
  }
  const body = await readBody(req);
  // JSON requests get JSON; HTML form submissions (the human execution path) get HTML.
  const replyFormat: Format = body.kind === 'form' && format !== 'json' ? 'html' : 'json';
  try {
    const credential = body.capability ?? bearer(req);
    // Unauthenticated writes (create, propose, fork, or any POST without a capability) get the tighter bucket.
    const bucket = credential ? `write:${clientKey(req)}` : `anon:${clientKey(req)}`;
    await consumeRateLimit(env, bucket, credential ? env.config.rateLimits.writesPerHour : env.config.rateLimits.anonPerHour);

    const { status, response } = await executeMutation(env, { resourceId, body: body.value, credential });
    const links = new Links(base);
    const rid = response.resource_id;
    const enriched = {
      ...response,
      result: withCapabilityUrls(response.result, links, rid),
      links: {
        resource: links.resource(rid),
        json: links.resource(rid, '.json'),
        events: links.resource(rid, '/events'),
        operations: links.resource(rid, '/operations'),
        protocol: links.plain('/protocol'),
      },
    };
    headers['ACSP-Resource-Version'] = String(response.version);
    if (status === 201) headers.Location = links.resource(rid);
    return replyFormat === 'json'
      ? jsonResponse(enriched, status, headers)
      : htmlResponse(renderResultPage(enriched, links.resource(rid)), status, headers);
  } catch (err) {
    return errorResponse(err, replyFormat, env, url);
  }
}

/** Where a fresh token was minted, add the matching capability URL (also shown once). */
function withCapabilityUrls(result: Record<string, unknown>, links: Links, rid: string): Record<string, unknown> {
  const out = { ...result };
  for (const key of ['owner_capability', 'capability']) {
    const c = out[key] as { token?: string | null } | undefined;
    if (c && typeof c.token === 'string') {
      out[`${key}_url`] = `${links.plain(`/r/${rid}`)}?cap=${encodeURIComponent(c.token)}`;
    }
  }
  return out;
}
