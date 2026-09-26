/**
 * Serve the real ACSP handler over plain HTTP on localhost, backed by
 * embedded PGlite. For local experiments that need separate processes to
 * reach one ACSP instance (e.g. the PURL composition bridge); never for
 * deployment — ACSP must be served over HTTPS (README § Deployment).
 *
 *   npm run serve:local                     in-memory database, random port, system clock
 *   npm run serve:local -- --port 8787 --seed 7 --data .data/local
 *
 * Prints one JSON line {"acsp": "<base url>"} on stdout when listening.
 */
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { cryptoRandom, SeededRandom, systemClock, type Env } from '../src/continuity/env';
import { migrate } from '../src/db/migrate';
import { createPgliteDatabase } from '../src/db/pglite';
import { createHandler } from '../src/transport/handler';

const args = process.argv.slice(2);
const value = (name: string) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};

async function main() {
  const db = await createPgliteDatabase(value('--data'));
  await migrate(db);
  const seed = value('--seed');
  const env: Env = {
    db,
    clock: systemClock,
    random: seed !== undefined ? new SeededRandom(Number(seed)) : cryptoRandom,
    config: { rateLimits: { anonPerHour: 100_000, writesPerHour: 100_000 }, production: false },
  };
  const handler = createHandler(() => env);

  const server = createServer(async (req, res) => {
    try {
      const chunks: Buffer[] = [];
      for await (const c of req) chunks.push(c as Buffer);
      const body = chunks.length ? Buffer.concat(chunks) : undefined;
      const headers = new Headers();
      for (const [k, v] of Object.entries(req.headers)) if (typeof v === 'string') headers.set(k, v);
      const response = await handler(
        new Request(new URL(req.url ?? '/', env.config.publicUrl), { method: req.method, headers, body: req.method === 'GET' || req.method === 'HEAD' ? undefined : body }),
      );
      res.writeHead(response.status, Object.fromEntries(response.headers));
      res.end(Buffer.from(await response.arrayBuffer()));
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'text/plain' });
      res.end(String(err));
    }
  });

  server.listen(Number(value('--port') ?? 0), '127.0.0.1', () => {
    const { port } = server.address() as AddressInfo;
    env.config.publicUrl = `http://127.0.0.1:${port}`;
    process.stdout.write(JSON.stringify({ acsp: env.config.publicUrl }) + '\n');
  });
  const stop = () => server.close(() => db.close().then(() => process.exit(0)));
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
