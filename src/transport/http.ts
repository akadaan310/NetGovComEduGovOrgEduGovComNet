/** TRANSPORT LAYER — HTTP primitives: headers, negotiation, bodies, responses. */
import { PROTOCOL_VERSION, RESOURCE_LIMITS } from '../protocol/constants';
import { AcspError } from '../protocol/errors';

export function securityHeaders(production: boolean): Record<string, string> {
  return {
    'Content-Security-Policy':
      "default-src 'none'; style-src 'unsafe-inline'; img-src 'self' data:; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    'X-Frame-Options': 'DENY',
    'Cache-Control': 'no-store',
    'X-Robots-Tag': 'noindex, nofollow',
    'Permissions-Policy': 'interest-cohort=()',
    // No ambient credentials exist (no cookies), so open CORS grants nothing.
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Authorization, Content-Type, Accept',
    'Access-Control-Allow-Methods': 'GET, HEAD, POST, OPTIONS',
    'Access-Control-Expose-Headers': 'ACSP-Protocol, ACSP-Resource-Version, Link',
    'ACSP-Protocol': PROTOCOL_VERSION,
    Vary: 'Accept',
    ...(production ? { 'Strict-Transport-Security': 'max-age=63072000; includeSubDomains' } : {}),
  };
}

export type Format = 'json' | 'html';

/** Strip a trailing ".json" and decide the representation. */
export function negotiate(req: Request, url: URL): { format: Format; path: string } {
  let path = url.pathname.replace(/\/+$/, '') || '/';
  let format: Format = 'html';
  if (path.endsWith('.json')) {
    path = path.slice(0, -5) || '/';
    format = 'json';
  }
  const q = url.searchParams.get('format');
  if (q === 'json') format = 'json';
  else if (q === 'html') format = 'html';
  else if (format === 'html') {
    const accept = req.headers.get('accept') ?? '';
    if (/application\/(.+\+)?json/.test(accept) && !accept.includes('text/html')) format = 'json';
  }
  return { format, path };
}

export function bearer(req: Request): string | null {
  const h = req.headers.get('authorization');
  if (!h) return null;
  const m = /^Bearer\s+(\S+)\s*$/i.exec(h);
  return m ? m[1] : null;
}

export function clientKey(req: Request): string {
  const xff = req.headers.get('x-forwarded-for');
  return (xff?.split(',')[0].trim() || req.headers.get('x-real-ip') || 'unknown').slice(0, 64);
}

export interface ParsedBody {
  kind: 'json' | 'form';
  value: unknown;
  /** From a form's `capability` field. */
  capability: string | null;
}

export async function readBody(req: Request): Promise<ParsedBody> {
  const declared = Number(req.headers.get('content-length') ?? '0');
  if (declared > RESOURCE_LIMITS.bodyBytes) {
    throw new AcspError('payload_too_large', `Request bodies are limited to ${RESOURCE_LIMITS.bodyBytes} bytes.`);
  }
  const text = await req.text();
  if (Buffer.byteLength(text, 'utf8') > RESOURCE_LIMITS.bodyBytes) {
    throw new AcspError('payload_too_large', `Request bodies are limited to ${RESOURCE_LIMITS.bodyBytes} bytes.`);
  }
  const type = (req.headers.get('content-type') ?? '').toLowerCase();
  if (type.includes('application/x-www-form-urlencoded')) {
    const form = new URLSearchParams(text);
    const raw = form.get('request') ?? '';
    const cap = form.get('capability')?.trim() || null;
    return { kind: 'form', value: parseJson(raw, 'The form field "request" must contain the JSON operation envelope.'), capability: cap };
  }
  if (type.includes('json') || type === '') {
    return { kind: 'json', value: parseJson(text, 'The request body is not valid JSON.'), capability: null };
  }
  throw new AcspError('unsupported_media_type', 'POST bodies must be application/json or an HTML form (application/x-www-form-urlencoded).');
}

function parseJson(text: string, message: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    throw new AcspError('malformed_request', message);
  }
}

export function jsonResponse(body: unknown, status: number, headers: Record<string, string>): Response {
  return new Response(JSON.stringify(body, null, 2) + '\n', {
    status,
    headers: { ...headers, 'Content-Type': 'application/json; charset=utf-8' },
  });
}

export function htmlResponse(html: string, status: number, headers: Record<string, string>): Response {
  return new Response(html, { status, headers: { ...headers, 'Content-Type': 'text/html; charset=utf-8' } });
}
