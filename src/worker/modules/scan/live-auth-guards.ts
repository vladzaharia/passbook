import type { Mode } from '../../../shared/contracts/common.ts';
import { type ScanActor, type ScanTenantAuthority, tenantScanRole } from './actor.ts';

export interface LiveAttachmentTenant {
  orgId: string;
  mode: Mode;
  admin?: { sessionId: string; userId: string; tenantAuthority: ScanTenantAuthority };
}

type SessionBinding = NonNullable<ScanActor['scanningSession']>;

/** Compare original authority structurally without serializing credential identifiers. */
export function sameAuthorityValue(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true;
  if (!left || !right || typeof left !== 'object' || typeof right !== 'object') return false;
  if (Array.isArray(left) || Array.isArray(right))
    return (
      Array.isArray(left) &&
      Array.isArray(right) &&
      left.length === right.length &&
      left.every((value, index) => sameAuthorityValue(value, right[index]))
    );
  const a = left as Record<string, unknown>;
  const b = right as Record<string, unknown>;
  return (
    Object.entries(a).every(([key, value]) => sameAuthorityValue(value, b[key])) &&
    Object.entries(b).every(([key, value]) => Object.hasOwn(a, key) || value === undefined)
  );
}

export function tenantReadAuthority(a: LiveAttachmentTenant): ScanTenantAuthority | null {
  const admin = a.admin;
  const authority = admin?.tenantAuthority;
  if (
    !admin ||
    !authority ||
    typeof authority !== 'object' ||
    authority.kind !== 'session' ||
    typeof admin.userId !== 'string' ||
    !admin.userId ||
    typeof admin.sessionId !== 'string' ||
    !admin.sessionId ||
    authority.orgId !== a.orgId ||
    authority.mode !== a.mode ||
    authority.userId !== admin.userId ||
    authority.sessionId !== admin.sessionId ||
    authority.capability !== 'scanning:read' ||
    !Number.isSafeInteger(authority.sessionCreatedAt) ||
    authority.sessionCreatedAt < 0 ||
    !Number.isSafeInteger(authority.sessionExpiresAt) ||
    authority.sessionExpiresAt <= authority.sessionCreatedAt ||
    typeof authority.sessionCsrfProof !== 'string' ||
    !/^[A-Za-z0-9_-]{43}$/.test(authority.sessionCsrfProof) ||
    typeof authority.membershipId !== 'string' ||
    !authority.membershipId ||
    !Number.isSafeInteger(authority.orgUpdatedAt) ||
    authority.orgUpdatedAt < 0 ||
    (authority.amr !== 'oidc' &&
      authority.amr !== 'magic_link' &&
      authority.amr !== 'breakglass') ||
    !Array.isArray(authority.sessionRoles) ||
    authority.sessionRoles.length === 0 ||
    !authority.sessionRoles.every((role) => role === 'admin' || role === 'user') ||
    !Array.isArray(authority.roles) ||
    !authority.roles.every((role) => typeof role === 'string') ||
    !tenantScanRole(authority)
  )
    return null;
  return authority;
}

export function sameSession(
  expected: SessionBinding | null,
  current: SessionBinding | null,
): boolean {
  if (expected === null || current === null) return expected === current;
  return (
    expected.id === current.id &&
    expected.status === current.status &&
    expected.updatedAt === current.updatedAt
  );
}
