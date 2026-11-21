import type { Mode } from '../../../shared/contracts/common.ts';
import { ForbiddenError } from '../../platform/errors.ts';
import type { TenantPassWrite } from '../passes/http.ts';
import type { SessionReadAuthority } from './scanning-session-dto.ts';

function sameSessionAuthority(
  authority: TenantPassWrite,
  captured: SessionReadAuthority['tenant'],
): boolean {
  if (authority.kind !== 'session' || !captured) return false;
  const same = (a: readonly string[], b: readonly string[]) =>
    a.length === b.length && a.every((value, index) => value === b[index]);
  return (
    authority.orgId === captured.orgId &&
    authority.mode === captured.mode &&
    authority.orgAccessRevision === captured.orgAccessRevision &&
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
  countAuthority: SessionReadAuthority,
): void {
  if (authority.kind === 'api_key') {
    // An org-bound key with `scan-setup:read`: its counts come from the key's own read fence.
    if (
      (authority.scope !== 'scan-setup:read' && authority.scope !== 'scanning:write') ||
      authority.keyOrgId === null ||
      countAuthority.key !== true ||
      countAuthority.tenant !== undefined ||
      countAuthority.sessionId !== undefined ||
      authority.mode !== mode ||
      countAuthority.mode !== mode ||
      authority.orgId !== countAuthority.orgId
    )
      throw new ForbiddenError();
    return;
  }
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
  countAuthority: SessionReadAuthority,
): void {
  if (authority.kind === 'api_key') {
    // An org-bound `scanning:write` key; its answer is read under the key's own fence.
    if (
      authority.scope !== 'scanning:write' ||
      authority.keyId !== userId ||
      authority.keyOrgId === null ||
      countAuthority.key !== true ||
      countAuthority.tenant !== undefined ||
      countAuthority.sessionId !== undefined ||
      authority.mode !== countAuthority.mode ||
      authority.orgId !== countAuthority.orgId
    )
      throw new ForbiddenError();
    return;
  }
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
