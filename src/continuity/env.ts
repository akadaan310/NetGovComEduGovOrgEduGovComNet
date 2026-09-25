/**
 * Everything the continuity engine needs from the outside world, injected so
 * the harness can make time and randomness deterministic.
 */
import { randomBytes } from 'node:crypto';
import type { Database } from '../db/types';

export interface Clock {
  now(): Date;
}

export interface Random {
  bytes(n: number): Uint8Array;
}

export interface Config {
  /** When set, `create` requires this key. */
  createKey?: string;
  /** Absolute public origin for links; defaults to the request origin. */
  publicUrl?: string;
  rateLimits: { anonPerHour: number; writesPerHour: number };
  production: boolean;
}

export interface Env {
  db: Database;
  clock: Clock;
  random: Random;
  config: Config;
}

export const systemClock: Clock = { now: () => new Date() };
export const cryptoRandom: Random = { bytes: (n) => new Uint8Array(randomBytes(n)) };

/** Clock the harness controls: starts at a fixed instant, ticks 1 ms per read. */
export class ManualClock implements Clock {
  private t: number;
  constructor(start = Date.parse('2026-01-01T00:00:00.000Z')) {
    this.t = start;
  }
  now(): Date {
    this.t += 1;
    return new Date(this.t);
  }
  advance(ms: number): void {
    this.t += ms;
  }
}

/** Seeded PRNG (sfc32) for deterministic ids and secrets in the harness. Never used in production. */
export class SeededRandom implements Random {
  private a: number;
  private b: number;
  private c: number;
  private d: number;
  constructor(seed = 0x5eed) {
    this.a = 0x9e3779b9;
    this.b = 0x243f6a88;
    this.c = 0xb7e15162;
    this.d = seed >>> 0;
    for (let i = 0; i < 15; i++) this.next();
  }
  private next(): number {
    this.a >>>= 0; this.b >>>= 0; this.c >>>= 0; this.d >>>= 0;
    let t = (this.a + this.b) | 0;
    this.a = this.b ^ (this.b >>> 9);
    this.b = (this.c + (this.c << 3)) | 0;
    this.c = (this.c << 21) | (this.c >>> 11);
    this.d = (this.d + 1) | 0;
    t = (t + this.d) | 0;
    this.c = (this.c + t) | 0;
    return t >>> 0;
  }
  bytes(n: number): Uint8Array {
    const out = new Uint8Array(n);
    for (let i = 0; i < n; i++) out[i] = this.next() & 0xff;
    return out;
  }
}

export function configFromProcessEnv(e: NodeJS.ProcessEnv = process.env): Config {
  const int = (v: string | undefined, d: number) => {
    const n = v ? Number.parseInt(v, 10) : NaN;
    return Number.isFinite(n) && n > 0 ? n : d;
  };
  return {
    createKey: e.ACSP_CREATE_KEY || undefined,
    publicUrl: e.ACSP_PUBLIC_URL?.replace(/\/+$/, '') || undefined,
    rateLimits: {
      anonPerHour: int(e.ACSP_RATE_LIMIT_ANON_PER_HOUR, 60),
      writesPerHour: int(e.ACSP_RATE_LIMIT_WRITES_PER_HOUR, 1200),
    },
    production: e.NODE_ENV === 'production',
  };
}
