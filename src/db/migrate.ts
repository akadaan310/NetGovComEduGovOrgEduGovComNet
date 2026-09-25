import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import type { Database } from './types';

export const MIGRATIONS_DIR = path.join(process.cwd(), 'db', 'migrations');

/**
 * Apply every `db/migrations/NNNN_*.sql` file not yet recorded in
 * `schema_migrations`, in lexical order, each in its own transaction.
 * Returns the names of the migrations applied.
 */
export async function migrate(db: Database, dir = MIGRATIONS_DIR): Promise<string[]> {
  await db.query(
    `create table if not exists schema_migrations (
       name text primary key,
       applied_at timestamptz not null default now()
     )`,
  );
  const files = (await readdir(dir)).filter((f) => /^\d+_.*\.sql$/.test(f)).sort();
  const applied = new Set(
    (await db.query<{ name: string }>('select name from schema_migrations')).rows.map((r) => r.name),
  );
  const done: string[] = [];
  for (const file of files) {
    if (applied.has(file)) continue;
    const text = await readFile(path.join(dir, file), 'utf8');
    await db.tx(async (sql) => {
      await sql.exec(text);
      await sql.query('insert into schema_migrations (name) values ($1)', [file]);
    });
    done.push(file);
  }
  return done;
}
