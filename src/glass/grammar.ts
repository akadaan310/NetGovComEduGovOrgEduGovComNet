/** GLASS/1 private derived-event grammar; standalone from ACSP authority.
 * Raw audio, transcribed words, voiceprints, names, stable device IDs and
 * other personal information are NEVER accepted. Strict allowlist only.
 */
import { createHash, timingSafeEqual } from 'node:crypto';

export const ROOM_RE = /^[A-Za-z0-9_-]{8,64}$/;
export const EVENT_RE = /^[A-Za-z0-9_-]{8,96}$/;
export const KIND = new Set([
  'audio.trace', 'language.candidate', 'language.confirmed',
  'session.state', 'trace.drop',
]);
export const FEATURE_FIELDS = new Set([
  'rms', 'peak', 'zcr', 'centroidHz', 'flux', 'lowEnergy',
  'midEnergy', 'highEnergy', 'pitchHz', 'voice', 'onset', 'confidence',
  'frameMs', 'generation', 'confirmations', 'switches',
  'dropped', 'noiseFloor', 'threshold', 'disagreement',
  'language', 'state', 'verdict', 'traceId',
]);
const CATEGORICAL: Record<string, ReadonlySet<string>> = {
  language: new Set(['ar','en','other','unknown']),
  state: new Set(['started','stopped','muted','paused','calibrating','listening','unknown']),
  verdict: new Set(['confirmed','correct','incorrect','abstain','candidate','unknown']),
  traceId: new Set(['dsp.rms','dsp.peak','dsp.zcr','dsp.flux','dsp.centroid',
    'dsp.pitch_proxy','dsp.pause_candidate','language.clock',
    'muqri.deferred','qitt.research']),
};
export type TraceKind =
  'audio.trace'|'language.candidate'|'language.confirmed'|'session.state'|'trace.drop';
export type TraceFields = Record<string, string | number | boolean | null>;
export type DerivedEvent = {
  room: string;
  eventId: string;
  kind: TraceKind;
  features: TraceFields;
};
export class GlassError extends Error {
  constructor(public readonly status: number, message: string) { super(message); }
}
export function constantTimeKey(supplied: string | null, expected: string | undefined): boolean {
  if (!supplied || !expected || expected.length < 24) return false;
  const a = createHash('sha256').update(supplied).digest();
  const b = createHash('sha256').update(expected).digest();
  return timingSafeEqual(a, b);
}
export function bearer(request: Request): string | null {
  const header = request.headers.get('authorization') || '';
  return header.startsWith('Bearer ') ? header.slice(7) : null;
}
export function requireKey(req: Request, direction: 'read'|'write'): void {
  const expected = direction === 'read'
    ? process.env.GLASS_STREAM_READ_KEY : process.env.GLASS_STREAM_WRITE_KEY;
  if (!expected || expected.length < 24) throw new GlassError(503,'GLASS private stream is not configured');
  if (!constantTimeKey(bearer(req), expected)) throw new GlassError(401,'Private stream capability required');
}
export function validatedRoom(room: unknown): string {
  if (typeof room !== 'string' || !ROOM_RE.test(room)) throw new GlassError(400,'Invalid room identity');
  return room;
}
export function parseCursor(raw: string | null): number {
  if (!raw) return 0;
  if (!/^[0-9]{1,15}$/.test(raw)) throw new GlassError(400,'Invalid event cursor');
  const n = Number(raw);
  if (!Number.isSafeInteger(n) || n < 0) throw new GlassError(400,'Unsafe event cursor');
  return n;
}
export function parseEvent(input: unknown): DerivedEvent {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new GlassError(400,'Event must be an object');
  const obj = input as Record<string, unknown>;
  const room = validatedRoom(obj.room);
  if (typeof obj.eventId !== 'string' || !EVENT_RE.test(obj.eventId)) throw new GlassError(400,'Invalid event ID');
  if (typeof obj.kind !== 'string' || !KIND.has(obj.kind)) throw new GlassError(400,'Unsupported event kind');
  if (obj.features == null || typeof obj.features !== 'object' || Array.isArray(obj.features))
    throw new GlassError(400,'Features must be a typed object');
  const source = obj.features as Record<string, unknown>;
  if (Object.keys(source).length > 18) throw new GlassError(400,'Too many features');
  const features: TraceFields = Object.create(null) as TraceFields;
  for (const [key,value] of Object.entries(source)) {
    if (!FEATURE_FIELDS.has(key)) throw new GlassError(400,'Feature rejected: '+key);
    if (key in CATEGORICAL) {
      if (typeof value !== 'string' || !CATEGORICAL[key].has(value))
        throw new GlassError(400,'Unknown categorical value for '+key);
      features[key] = value;
    } else if (value === null) {
      features[key] = null;
    } else if (typeof value === 'boolean' && ['voice','onset'].includes(key)) {
      features[key] = value;
    } else if (typeof value === 'number' && Number.isFinite(value) && Math.abs(value) <= 1_000_000_000) {
      features[key] = value;
    } else {
      throw new GlassError(400,'Invalid numeric/Boolean feature '+key);
    }
  }
  return { room, eventId: obj.eventId, kind: obj.kind as TraceKind, features };
}
export function safeJsonError(error: unknown): Response {
  const status = error instanceof GlassError ? error.status : 503;
  return Response.json({ ok:false, error: error instanceof GlassError ? error.message : 'Service temporarily unavailable' },
    {status, headers: {'Cache-Control':'no-store','X-Content-Type-Options':'nosniff'}});
}

export const DOMAIN_NAME = 'NetGovComEduGovOrgEduGovComNet';
const SEGMENTS = ['Net','Gov','Com','Edu','Org'] as const;
function factorial(n: number): number { let p = 1; for(let i=2;i<=n;i++) p*=i; return p; }
export function domainGrammar(name=DOMAIN_NAME) {
  let remainder = name; const tokens: string[] = [];
  while (remainder.length) {
    const token = SEGMENTS.find(x => remainder.startsWith(x));
    if (!token) throw new GlassError(400,'Unknown symbolic registry name');
    tokens.push(token); remainder=remainder.slice(token.length);
  }
  if (tokens[0]!=='Net' || tokens[tokens.length-1]!=='Net')
    throw new GlassError(400,'Missing Net envelope');
  const interior=tokens.slice(1,-1);
  const frequency: Record<string,number> = {};
  for(const token of interior) frequency[token]=(frequency[token]??0)+1;
  const multisetOrders = factorial(interior.length) /
    Object.values(frequency).reduce((acc,count)=>acc*factorial(count),1);
  return {
    source: name, envelope: ['Net','Net'], interior, frequency, multisetOrders,
    unconstrainedFiveTypeInterior: 5**interior.length,
    meaning: 'Symbolic domain-category composition, NOT DNS privileges or proven semantic meaning',
  };
}
