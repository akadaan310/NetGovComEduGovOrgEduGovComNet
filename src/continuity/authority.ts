/**
 * CONTINUITY LAYER — ownership, access, authority.
 *
 * Kept deliberately separate:
 *   ownership  — resources.owner_session_id; held via the owner capability
 *   access     — who may read (visibility + capabilities)
 *   authority  — scopes on a verified capability
 *   delegation — the act (and record) of granting a capability
 *   task responsibility — per task TOK, moved only by handoff + acknowledge
 */
import type { Sql } from '../db/types';
import { SCOPE_MEANINGS, type Scope } from '../protocol/constants';
import type { AuthorityRequirement, OperationSpec } from '../protocol/operations';
import { AcspError } from '../protocol/errors';
import { parseCapabilityToken, secretMatches } from './ids';
import { capabilityStatus, type CapabilityRow, type ResourceRow } from './records';

/** A capability whose secret, revocation and expiry have been checked. */
export interface VerifiedCapability {
  id: string;
  resource_id: string;
  kind: 'owner' | 'delegation';
  session_id: string;
  agent_id: string | null;
  scopes: Scope[];
  expires_at: Date | null;
}

export async function verifyCapability(sql: Sql, token: string, now: Date): Promise<VerifiedCapability> {
  const parsed = parseCapabilityToken(token);
  if (!parsed) throw new AcspError('invalid_capability', 'The capability token is malformed.');
  const { rows } = await sql.query<CapabilityRow>('select * from capabilities where id = $1', [parsed.id]);
  const row = rows[0];
  if (!row || !secretMatches(parsed.secret, row.secret_hash)) {
    throw new AcspError('invalid_capability', 'The capability token is not recognised.');
  }
  const status = capabilityStatus(row, now);
  if (status === 'revoked') throw new AcspError('capability_revoked', `Capability ${row.id} was revoked.`);
  if (status === 'expired') {
    throw new AcspError('capability_expired', `Capability ${row.id} expired at ${row.expires_at?.toISOString()}.`);
  }
  return {
    id: row.id,
    resource_id: row.resource_id,
    kind: row.kind,
    session_id: row.session_id,
    agent_id: row.agent_id,
    scopes: row.scopes,
    expires_at: row.expires_at,
  };
}

export const isOwner = (cap: VerifiedCapability | null): boolean => cap?.kind === 'owner';

export function hasScope(cap: VerifiedCapability | null, scope: Scope): boolean {
  if (!cap) return false;
  if (cap.scopes.includes('owner')) return true;
  if (scope === 'read') return true; // every capability implies read
  return cap.scopes.includes(scope);
}

/** Effective scopes, spelled out, for discovery. */
export function effectiveScopes(cap: VerifiedCapability | null): Scope[] {
  if (!cap) return [];
  if (cap.scopes.includes('owner')) return Object.keys(SCOPE_MEANINGS) as Scope[];
  return Array.from(new Set<Scope>(['read', ...cap.scopes]));
}

export function canRead(resource: ResourceRow, cap: VerifiedCapability | null): boolean {
  if (resource.visibility === 'unlisted') return true;
  return cap !== null && cap.resource_id === resource.id;
}

export type Decision = { ok: true } | { ok: false; error: AcspError };

const deny = (code: 'authentication_required' | 'insufficient_authority', message: string): Decision => ({
  ok: false,
  error: new AcspError(code, message),
});

/**
 * Pure authority check for an operation's *base* requirement. Operation
 * handlers add data-dependent checks (task responsibility for handoff, the
 * addressee for acknowledge).
 */
export function authorize(
  spec: Pick<OperationSpec, 'name' | 'authority'>,
  resource: ResourceRow | null,
  cap: VerifiedCapability | null,
): Decision {
  const req: AuthorityRequirement = spec.authority;
  switch (req.kind) {
    case 'none':
      return { ok: true };
    case 'read':
      if (!resource || canRead(resource, cap)) return { ok: true };
      return cap
        ? deny('insufficient_authority', 'This capability does not grant read access to this resource.')
        : deny('authentication_required', 'This resource is restricted: reading requires a capability.');
    case 'scope':
      if (!cap) {
        return deny(
          'authentication_required',
          `"${spec.name}" requires a capability with scope "${req.scope}". Ask the owner to delegate one, or use "propose".`,
        );
      }
      return hasScope(cap, req.scope)
        ? { ok: true }
        : deny('insufficient_authority', `Capability ${cap.id} lacks scope "${req.scope}" (has: ${cap.scopes.join(', ')}).`);
    case 'owner':
      if (!cap) return deny('authentication_required', `"${spec.name}" requires the owner capability.`);
      return isOwner(cap)
        ? { ok: true }
        : deny('insufficient_authority', `"${spec.name}" is reserved for the owner; capability ${cap.id} is a delegation.`);
    case 'addressee':
      if (!cap) {
        return deny('authentication_required', `"${spec.name}" requires a capability bound to the addressed session.`);
      }
      return { ok: true };
  }
}

export function describeRequirement(req: AuthorityRequirement): string {
  switch (req.kind) {
    case 'none':
      return 'none';
    case 'read':
      return 'read access';
    case 'scope':
      return `scope:${req.scope}`;
    case 'owner':
      return 'owner';
    case 'addressee':
      return 'addressed session';
  }
}
