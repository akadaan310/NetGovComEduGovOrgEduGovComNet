/**
 * A World is one isolated ACSP universe for a scenario: a fresh database,
 * a controllable clock, a seeded RNG, the real HTTP handler, and actors.
 */
import { randomBytes } from 'node:crypto';
import { ManualClock, SeededRandom, type Config, type Env } from '../src/continuity/env';
import { migrate } from '../src/db/migrate';
import { createPgDatabase } from '../src/db/pg';
import { createPgliteDatabase } from '../src/db/pglite';
import type { Database } from '../src/db/types';
import { createHandler } from '../src/transport/handler';
import { Actor, type ActorOptions } from './actors';
import { AcspClient, type Transport } from './client';

export interface WorldOptions {
  /** 'pglite' (default), 'postgres' (ACSP_TEST_DATABASE_URL / DATABASE_URL), or a remote deployment. */
  db?: 'pglite' | 'postgres';
  baseUrl?: string;
  seed?: number;
  config?: Partial<Config>;
}

export interface World {
  mode: 'in-process' | 'http';
  client: AcspClient;
  transport: Transport;
  /** Present in-process only. */
  env?: Env;
  clock?: ManualClock;
  actor(name: string, opts?: ActorOptions): Actor;
  close(): Promise<void>;
}

const TEST_CONFIG: Config = {
  rateLimits: { anonPerHour: 100_000, writesPerHour: 100_000 },
  production: false,
};

export async function createWorld(opts: WorldOptions = {}): Promise<World> {
  if (opts.baseUrl) {
    const base = opts.baseUrl.replace(/\/+$/, '');
    const transport: Transport = { base, fetch: (req) => fetch(req) };
    const client = new AcspClient(transport);
    // Idempotency keys must not collide with earlier runs against the same deployment
    // (a repeated key + identical request would replay the earlier result).
    const run = randomBytes(4).toString('hex');
    return {
      mode: 'http',
      client,
      transport,
      actor: (name, o = {}) => new Actor(name, client, { ...o, keyPrefix: `${o.session ?? `session-${name}`}-${run}` }),
      close: async () => undefined,
    };
  }

  let db: Database;
  let cleanup = async () => undefined as void;
  if (opts.db === 'postgres') {
    const url = process.env.ACSP_TEST_DATABASE_URL || process.env.DATABASE_URL;
    if (!url) throw new Error('--db postgres needs ACSP_TEST_DATABASE_URL or DATABASE_URL');
    const schema = `acsp_h_${randomBytes(6).toString('hex')}`;
    const admin = createPgDatabase({ connectionString: url, max: 1 });
    await admin.query(`create schema ${schema}`);
    db = createPgDatabase({ connectionString: url, schema, max: 8 });
    cleanup = async () => {
      await db.close();
      await admin.query(`drop schema ${schema} cascade`);
      await admin.close();
    };
  } else {
    db = await createPgliteDatabase();
    cleanup = () => db.close();
  }
  await migrate(db);

  const clock = new ManualClock();
  const env: Env = {
    db,
    clock,
    random: new SeededRandom(opts.seed ?? 42),
    config: { ...TEST_CONFIG, ...opts.config, rateLimits: { ...TEST_CONFIG.rateLimits, ...opts.config?.rateLimits } },
  };
  const handler = createHandler(() => env);
  const transport: Transport = { base: 'https://acsp.test', fetch: handler };
  const client = new AcspClient(transport);
  return {
    mode: 'in-process',
    client,
    transport,
    env,
    clock,
    actor: (name, o) => new Actor(name, client, o),
    close: cleanup,
  };
}
