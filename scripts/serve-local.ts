/**
 * A local ACSP/0.1 server without Next.js, for integration tests from other
 * systems (e.g. the PURL circle bridge). It mounts the same framework-independent
 * handler the Next route mounts; no protocol behaviour is added or changed.
 *
 *   npx tsx scripts/serve-local.ts [--port 8787] [--data DIR]
 *
 * Without --data the database is an in-memory PGlite: every start is a fresh,
 * empty ACSP universe. Rate limits are raised for tests (ACSP_RATE_LIMIT_* still win).
 */
import { createServer } from 'node:http';
import { configFromProcessEnv, cryptoRandom, systemClock, type Env } from '../src/continuity/env';
import { migrate } from '../src/db/migrate';
import { createPgliteDatabase } from '../src/db/pglite';
import { createHandler } from '../src/transport/handler';

const arg = (name: string) => {
  const i = process.argv.indexOf(name);
  return i > 0 ? process.argv[i + 1] : undefined;
};
const port = Number(arg('--port') ?? process.env.PORT ?? 8787);

const db = await createPgliteDatabase(arg('--data'));
await migrate(db);
const config = configFromProcessEnv({
  ACSP_RATE_LIMIT_ANON_PER_HOUR: '100000',
  ACSP_RATE_LIMIT_WRITES_PER_HOUR: '100000',
  ACSP_PUBLIC_URL: `http://127.0.0.1:${port}`,
  ...process.env,
});
const env: Env = { db, clock: systemClock, random: cryptoRandom, config };
const handler = createHandler(() => env);

createServer(async (req, res) => {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  const body = chunks.length && req.method !== 'GET' && req.method !== 'HEAD' ? Buffer.concat(chunks) : undefined;
  const headers = new Headers();
  for (const [k, v] of Object.entries(req.headers)) if (typeof v === 'string') headers.set(k, v);
  headers.set('x-forwarded-for', req.socket.remoteAddress ?? '127.0.0.1');
  const response = await handler(new Request(`http://127.0.0.1:${port}${req.url}`, { method: req.method, headers, body }));
  res.writeHead(response.status, Object.fromEntries(response.headers));
  res.end(Buffer.from(await response.arrayBuffer()));
}).listen(port, '127.0.0.1', () => {
  console.log(`ACSP/0.1 (local, ${arg('--data') ? 'PGlite at ' + arg('--data') : 'in-memory PGlite'}) on http://127.0.0.1:${port}/`);
});
