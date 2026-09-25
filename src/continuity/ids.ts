import { createHash, timingSafeEqual } from 'node:crypto';
import type { Random } from './env';

/** Crockford base32 (no I, L, O, U): unambiguous when read aloud or retyped by a human. */
const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

export function crockford(random: Random, length: number): string {
  const bytes = random.bytes(length);
  let out = '';
  for (let i = 0; i < length; i++) out += ALPHABET[bytes[i] & 31];
  return out;
}

/** 12 characters ≈ 60 bits: not enumerable, short enough to read aloud. */
export const newResourceId = (r: Random) => crockford(r, 12);

export const CAPABILITY_TOKEN_RE = /^acsp_(cap_[0-9A-Z]{10})_([0-9A-Z]{32})$/;

/** A new capability: public id + 160-bit secret. Only sha256(secret) is ever stored. */
export function newCapability(r: Random): { id: string; secret: string; token: string; secretHash: string } {
  const id = `cap_${crockford(r, 10)}`;
  const secret = crockford(r, 32);
  return { id, secret, token: `acsp_${id}_${secret}`, secretHash: sha256Hex(secret) };
}

export function parseCapabilityToken(token: string): { id: string; secret: string } | null {
  const m = CAPABILITY_TOKEN_RE.exec(token.trim());
  return m ? { id: m[1], secret: m[2] } : null;
}

export function sha256Hex(s: string): string {
  return createHash('sha256').update(s, 'utf8').digest('hex');
}

export function secretMatches(secret: string, storedHash: string): boolean {
  const a = Buffer.from(sha256Hex(secret), 'hex');
  const b = Buffer.from(storedHash, 'hex');
  return a.length === b.length && timingSafeEqual(a, b);
}

export const pad3 = (n: number) => String(n).padStart(3, '0');
