import type { Database } from './types';

/**
 * Embedded PostgreSQL (WASM) for the harness, tests and zero-setup local
 * development. Never used in production.
 */
export async function createPgliteDatabase(dataDir?: string): Promise<Database> {
  const { PGlite } = await import('@electric-sql/pglite');
  const db = dataDir ? new PGlite(dataDir) : new PGlite();
  await db.waitReady;
  return {
    kind: 'pglite',
    async query(text, params) {
      const r = await db.query(text, params as unknown[]);
      return { rows: r.rows as never[] };
    },
    async exec(text) {
      await db.exec(text);
    },
    async tx(fn) {
      return db.transaction(async (t) =>
        fn({
          async query(text, params) {
            const r = await t.query(text, params as unknown[]);
            return { rows: r.rows as never[] };
          },
          async exec(text) {
            await t.exec(text);
          },
        }),
      );
    },
    async close() {
      await db.close();
    },
  };
}
