/**
 * Production/dev runtime environment (a process-wide singleton).
 *   DATABASE_URL (or POSTGRES_URL) set → PostgreSQL via node-postgres.
 *   Unset in development              → embedded PGlite in .data/pglite (auto-migrated).
 *   Unset in production               → 503 service_unavailable; never silently ephemeral.
 */
import { configFromProcessEnv, cryptoRandom, systemClock, type Env } from './continuity/env';
import { migrate } from './db/migrate';
import { createPgDatabase } from './db/pg';
import { AcspError } from './protocol/errors';

let envPromise: Promise<Env> | null = null;

export function getRuntimeEnv(): Promise<Env> {
  envPromise ??= init().catch((err) => {
    envPromise = null;
    throw err;
  });
  return envPromise;
}

async function init(): Promise<Env> {
  const config = configFromProcessEnv();
  const url = process.env.DATABASE_URL || process.env.POSTGRES_URL;
  if (url) {
    return { db: createPgDatabase({ connectionString: url }), clock: systemClock, random: cryptoRandom, config };
  }
  if (config.production) {
    throw new AcspError('service_unavailable', 'The server is not configured: DATABASE_URL is not set.');
  }
  const { createPgliteDatabase } = await import('./db/pglite');
  const db = await createPgliteDatabase(process.env.ACSP_PGLITE_DIR || '.data/pglite');
  await migrate(db);
  console.warn('[acsp] DATABASE_URL not set — using embedded PGlite at .data/pglite (development only).');
  return { db, clock: systemClock, random: cryptoRandom, config };
}
