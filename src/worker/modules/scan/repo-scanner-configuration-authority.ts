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
  /** A key answers only where the caller opts in: its flows are revoke, mode move and the device update. */
  options: { key?: true } = {},
): Promise<void> {
  const { authority, userId, now } = credential;
  const holds =
    authority?.kind === 'api_key'
      ? options.key === true && authority.scope === 'scanning:write' && authority.keyId === userId
      : authority?.kind === 'session' &&
        authority.userId === userId &&
        authority.capability === 'scanning:manage';
  if (
    !authority ||
    !holds ||
    authority.orgId !== orgId ||
    !(await tenantPassAuthorityValid(db, authority, now))
  )
    throw new ForbiddenError();
}
