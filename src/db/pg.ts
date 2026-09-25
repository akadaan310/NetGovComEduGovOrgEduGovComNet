import pg from 'pg';
import type { Database, Sql } from './types';

// Parse int8 (e.g. count(*)) as a JS number; ACSP never stores values beyond 2^53.
pg.types.setTypeParser(20, (v) => Number(v));

export interface PgOptions {
  connectionString: string;
  /** Optional schema to use as search_path (used by the harness for isolation). */
  schema?: string;
  max?: number;
}

export function createPgDatabase(opts: PgOptions): Database {
  const pool = new pg.Pool({
    connectionString: opts.connectionString,
    max: opts.max ?? 5,
    options: opts.schema ? `-c search_path=${opts.schema}` : undefined,
  });
  return {
    kind: 'postgres',
    async query(text, params) {
      const r = await pool.query(text, params as unknown[]);
      return { rows: r.rows };
    },
    async exec(text) {
      await pool.query(text);
    },
    async tx(fn) {
      const client = await pool.connect();
      const sql: Sql = {
        async query(text, params) {
          const r = await client.query(text, params as unknown[]);
          return { rows: r.rows };
        },
        async exec(text) {
          await client.query(text);
        },
      };
      try {
        await client.query('BEGIN');
        const out = await fn(sql);
        await client.query('COMMIT');
        return out;
      } catch (err) {
        await client.query('ROLLBACK').catch(() => undefined);
        throw err;
      } finally {
        client.release();
      }
    },
    async close() {
      await pool.end();
    },
  };
}
