/**
 * Fixed-window rate limiting stored in Postgres, so it holds across
 * serverless instances. Only writes are limited; reads are never counted.
 */
import type { Env } from '../continuity/env';
import { AcspError } from '../protocol/errors';

export async function consumeRateLimit(env: Env, bucket: string, limitPerHour: number): Promise<void> {
  const window = 3600_000;
  const now = env.clock.now().getTime();
  const start = new Date(Math.floor(now / window) * window);
  const { rows } = await env.db.query<{ count: number }>(
    `insert into rate_limits (bucket, window_start, count) values ($1, $2, 1)
     on conflict (bucket, window_start) do update set count = rate_limits.count + 1
     returning count`,
    [bucket, start],
  );
  await env.db.query('delete from rate_limits where bucket = $1 and window_start < $2', [bucket, start]);
  if (rows[0].count > limitPerHour) {
    const retry = Math.ceil((start.getTime() + window - now) / 1000);
    throw new AcspError('rate_limited', `Too many writes from this client (limit ${limitPerHour}/hour). Retry in ${retry}s.`, {
      retry_after_seconds: retry,
    });
  }
}
