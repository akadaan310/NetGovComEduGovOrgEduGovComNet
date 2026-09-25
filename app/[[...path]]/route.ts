/**
 * Next.js adapter. The entire ACSP HTTP surface lives in src/transport/handler.ts
 * as a framework-independent (Request) => Response function; this file only mounts it.
 */
import { getRuntimeEnv } from '../../src/runtime';
import { createHandler } from '../../src/transport/handler';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const handler = createHandler(getRuntimeEnv);

export const GET = handler;
export const HEAD = handler;
export const POST = handler;
export const OPTIONS = handler;
