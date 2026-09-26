/** Shared fixtures for Program 001 scenarios. */
import type { Actor } from '../actors';
import type { T } from '../scenario';
import type { World } from '../world';

/** Every scope a session needs to act as an agent identity. */
export const EMBODIMENT_SCOPES = ['embody', 'substrate', 'scroll', 'alias', 'execute', 'checkpoint', 'announce'];

export const MULTIPLY = {
  purpose: 'multiply two values',
  inputs: ['a', 'b'],
  operations: [{ operation: 'multiply', arguments: ['a', 'b'] }],
  output: 's1',
};

export interface IdentityFixture {
  rid: string;
  principal: Actor;
}

/** The human principal creates an agent identity and holds its owner capability. */
export async function createIdentity(
  w: World,
  t: T,
  title = 'Agent X',
  extra: Record<string, unknown> = {},
  principal: Actor = w.actor('principal', { session: 'principal-alice', agent: null, kind: 'human' }),
): Promise<IdentityFixture> {
  const res = await principal.create({ title, kind: 'agent_identity', owner_human: 'alice', ...extra });
  t.status(res, 201, `principal creates agent identity "${title}"`);
  return { rid: res.body.resource_id, principal };
}

/** The principal delegates a session-bound capability; the session receives it out of band. */
export async function authorize(t: T, f: IdentityFixture, session: Actor, scopes = EMBODIMENT_SCOPES, expires_in_seconds?: number): Promise<string> {
  const d = await f.principal.delegate(f.rid, { to: { session_id: session.session_id }, scopes, ...(expires_in_seconds ? { expires_in_seconds } : {}) });
  t.status(d, 200, `principal delegates [${scopes.join(', ')}] to ${session.session_id}`);
  session.receive(f.rid, d.body.result.capability.token);
  return d.body.result.capability.id;
}

/** Authorize, embody and select a substrate. */
export async function embodied(t: T, f: IdentityFixture, session: Actor, model: Record<string, unknown> | null, substrate: string | null = 'deterministic-calculator') {
  const capId = await authorize(t, f, session);
  const e = await session.embody(f.rid, model ? { model } : {});
  t.status(e, 200, `${session.session_id} embodies the identity`);
  if (substrate) t.status(await session.setSubstrate(f.rid, substrate), 200, `${session.session_id} selects ${substrate}`);
  return { capId, embodimentId: e.body.result?.embodiment?.id as string };
}

export const execution = (res: { body: any }) => res.body?.result?.execution;
