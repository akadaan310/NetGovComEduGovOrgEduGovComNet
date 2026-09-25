/**
 * Apply pending migrations to DATABASE_URL (or POSTGRES_URL).
 *   npm run db:migrate
 * With ACSP_MIGRATE_OPTIONAL=1 a missing URL is a warning, not an error
 * (used by `vercel-build` so preview builds without a database still build).
 */
import { migrate } from '../src/db/migrate';
import { createPgDatabase } from '../src/db/pg';

const url = process.env.DATABASE_URL || process.env.POSTGRES_URL;
if (!url) {
  if (process.env.ACSP_MIGRATE_OPTIONAL === '1') {
    console.warn('[acsp] DATABASE_URL not set; skipping migrations.');
    process.exit(0);
  }
  console.error('[acsp] DATABASE_URL (or POSTGRES_URL) must be set.');
  process.exit(1);
}
const db = createPgDatabase({ connectionString: url, max: 1 });
try {
  const applied = await migrate(db);
  console.log(applied.length ? `[acsp] applied: ${applied.join(', ')}` : '[acsp] database is up to date.');
} catch (err) {
  console.error('[acsp] migration failed:', err);
  process.exitCode = 1;
} finally {
  await db.close();
}
