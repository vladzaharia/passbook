import { type AuthContext, assertOrgAccess } from '../../platform/auth.ts';
import { first, type SqlValue } from '../../platform/db.ts';
import { ForbiddenError, NotFoundError, UnauthenticatedError } from '../../platform/errors.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { activeMembership } from '../orgs/repo-members.ts';
import { type TenantPassWrite, tenantAuthorityOf } from '../passes/http.ts';
import { tenantPassAuthorityParams, tenantPassAuthoritySql } from '../passes/repo-authority.ts';

type ConnectionCapability = 'integrations:read' | 'integrations:manage';

/** A secret-free principal and grant snapshot, including the request's Live/Test mode. */
export type ConnectionAuthority = TenantPassWrite;
/** Trusted work with no tenant principal (seeding, fixtures, jobs) names itself instead of passing nothing. */
export type ConnectionWriter = ConnectionAuthority | 'system';

/** Check the stored resource's organization, never a caller-supplied replacement for it. */
export async function authorizeConnection(
  sctx: ServiceContext,
  auth: AuthContext | undefined,
  orgId: string,
  capability: ConnectionCapability,
): Promise<ConnectionAuthority> {
  if (!auth) throw new UnauthenticatedError();
  if (auth.kind === 'scanner') throw new ForbiddenError();
  assertOrgAccess(auth, orgId);
  if (auth.kind === 'api_key') {
    const needed = capability === 'integrations:read' ? 'connections:read' : 'connections:write';
    if (!auth.scopes.includes(needed)) {
      throw new ForbiddenError(`The API key lacks the ${needed} scope.`, 'MISSING_SCOPE');
    }
  }
  return tenantAuthorityOf(sctx, auth, orgId, capability);
}

/**
 * By-id routes: a caller with no access to the stored connection's organization learns nothing
 * about it, so a non-member (or an org-bound key for another org) gets 404, not 403.
 */
export async function authorizeStoredConnection(
  sctx: ServiceContext,
  auth: AuthContext | undefined,
  orgId: string,
  capability: ConnectionCapability,
): Promise<ConnectionAuthority> {
  try {
    return await authorizeConnection(sctx, auth, orgId, capability);
  } catch (error) {
    if (
      error instanceof ForbiddenError &&
      ((auth?.kind === 'session' && !(await activeMembership(sctx.env.DB, auth.userId, orgId))) ||
        (auth?.kind === 'api_key' && auth.orgId !== null && auth.orgId !== orgId))
    ) {
      throw new NotFoundError('Connection not found.', 'CONNECTION_NOT_FOUND');
    }
    throw error;
  }
}

/**
 * Bind the canonical tenant authority to the mutated row's actual organization. `orgSql` is a
 * trusted SQL expression; callers supply any placeholders in it before `params`. There is no
 * authority-less form: trusted system work skips the predicate explicitly (`ConnectionWriter`).
 * Mutations require integrations:manage for sessions or connections:write for API keys.
 */
export function connectionAuthPredicate(
  authority: ConnectionAuthority,
  orgSql: string,
  now: number,
): { sql: string; params: SqlValue[] } {
  if (
    authority.mode !== 'live' ||
    (authority.kind === 'session' && authority.capability !== 'integrations:manage') ||
    (authority.kind === 'api_key' && authority.scope !== 'connections:write')
  ) {
    return { sql: `((${orgSql}) IS NULL AND 0)`, params: [] };
  }
  return {
    sql: `(${orgSql}) = ? AND (${tenantPassAuthoritySql(authority)})`,
    params: [authority.orgId, ...tenantPassAuthorityParams(authority, now)],
  };
}

/** For non-D1 side effects that immediately follow an authorization check. */
export async function assertConnectionAuthority(
  sctx: ServiceContext,
  authority: ConnectionAuthority | undefined,
): Promise<void> {
  if (!authority) return;
  const predicate = connectionAuthPredicate(authority, '?', sctx.clock.now());
  const row = await first<{ ok: number }>(sctx.env.DB, `SELECT 1 AS ok WHERE ${predicate.sql}`, [
    authority.orgId,
    ...predicate.params,
  ]);
  if (!row) throw new ForbiddenError();
}
