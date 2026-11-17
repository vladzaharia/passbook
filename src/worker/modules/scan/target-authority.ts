import type { AuthContext } from '../../platform/auth.ts';
import { NotFoundError } from '../../platform/errors.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { getOrgAccess } from '../orgs/access.ts';
import { tenantAuthorityOf } from '../passes/http.ts';

type Capability = Parameters<typeof tenantAuthorityOf>[3];

/** By-id console routes: a non-member gets the same 404 as a missing id. */
async function targetAuthority(
  ctx: ServiceContext,
  auth: AuthContext,
  orgId: string,
  capability: Capability,
  kind: 'scanner' | 'session',
) {
  if (auth.kind === 'session' && !(await getOrgAccess(ctx, auth.userId, orgId))) {
    throw kind === 'scanner'
      ? new NotFoundError('Scanner not found.', 'SCANNER_NOT_FOUND')
      : new NotFoundError('Scanning session not found.', 'SCANNING_SESSION_NOT_FOUND');
  }
  return tenantAuthorityOf(ctx, auth, orgId, capability);
}

export const scannerAuthority = (
  ctx: ServiceContext,
  auth: AuthContext,
  orgId: string,
  capability: Capability,
) => targetAuthority(ctx, auth, orgId, capability, 'scanner');

export const sessionAuthority = (
  ctx: ServiceContext,
  auth: AuthContext,
  orgId: string,
  capability: Capability,
) => targetAuthority(ctx, auth, orgId, capability, 'session');
