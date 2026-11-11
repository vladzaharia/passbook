import type { Mode } from '../../../shared/contracts/common.ts';
import { ForbiddenError } from '../../platform/errors.ts';
import type { TenantPassWrite } from '../passes/http.ts';
import type { SessionCountAuthority } from './scanning-session-dto.ts';

function sameSessionAuthority(
  authority: TenantPassWrite,
  captured: SessionCountAuthority['tenant'],
): boolean {
  if (authority.kind !== 'session' || !captured) return false;
  const same = (a: readonly string[], b: readonly string[]) =>
    a.length === b.length && a.every((value, index) => value === b[index]);
  return (
    authority.orgId === captured.orgId &&
    authority.mode === captured.mode &&
    authority.orgUpdatedAt === captured.orgUpdatedAt &&
    authority.userId === captured.userId &&
    authority.sessionId === captured.sessionId &&
    authority.membershipId === captured.membershipId &&
    authority.amr === captured.amr &&
    same(authority.roles, captured.roles) &&
    same(authority.sessionRoles, captured.sessionRoles)
  );
}

export function assertSessionReadAuthority(
  mode: Mode,
  authority: TenantPassWrite,
  countAuthority: SessionCountAuthority,
): void {
  if (
    authority.kind !== 'session' ||
    authority.capability !== 'scanning:read' ||
    !countAuthority ||
    countAuthority.tenant?.capability !== 'scanning:read' ||
    countAuthority.sessionId !== undefined ||
    !sameSessionAuthority(authority, countAuthority.tenant) ||
    authority.mode !== mode ||
    countAuthority.mode !== mode ||
    authority.orgId !== countAuthority.orgId
  )
    throw new ForbiddenError();
}

export function assertSessionWriteCountAuthority(
  userId: string,
  authority: TenantPassWrite,
  countAuthority: SessionCountAuthority,
): void {
  if (
    authority.kind !== 'session' ||
    authority.capability !== 'scanning:manage' ||
    authority.userId !== userId ||
    !countAuthority ||
    countAuthority.tenant?.capability !== 'scanning:read' ||
    countAuthority.sessionId !== undefined ||
    !sameSessionAuthority(authority, countAuthority.tenant)
  )
    throw new ForbiddenError();
}
