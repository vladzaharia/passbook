import { ForbiddenError } from '../../platform/errors.ts';
import type { TenantPassWrite } from '../passes/http.ts';
import { tenantPassAuthorityValid } from '../passes/repo-authority.ts';

type Db = D1Database;

export interface AdminConfigurationClaim {
  kind: 'admin';
  userId: string;
  authority: TenantPassWrite | null | undefined;
  now: number;
}

/** A no-op console edit still answers only to an admin who holds scanning:manage right now. */
export async function assertAdminConfigurationAuthority(
  db: Db,
  orgId: string,
  credential: AdminConfigurationClaim,
): Promise<void> {
  const { authority, userId, now } = credential;
  if (
    authority?.kind !== 'session' ||
    authority.orgId !== orgId ||
    authority.userId !== userId ||
    authority.capability !== 'scanning:manage' ||
    !(await tenantPassAuthorityValid(db, authority, now))
  )
    throw new ForbiddenError();
}
