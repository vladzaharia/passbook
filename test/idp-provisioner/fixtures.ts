/**
 * Pocket ID response shapes for both route layouts, written from the Go DTOs (json tags) at v2.19.3 and at main
 * (2026-11-24): `dto.UserDto`, `dto.UserGroupDto`, `usersignup.signupTokenDto`, `auditlogs.auditLogDto`,
 * `apikey.apiKeyDto`, `appconfig.AppConfigVariableDto` and `dto.Paginated`. The layouts differ in the audit
 * `data` key (token value vs token id), the signup token DTO (`prefix`) and the route prefix.
 */
export type Layout = 'v2' | 'admin';

export const paginated = <T>(data: T[]) => ({
  data,
  pagination: { totalPages: 1, totalItems: data.length, currentPage: 1, itemsPerPage: 100 },
});

export const groupDto = (id: string, name: string) => ({
  id,
  friendlyName: name,
  name,
  customClaims: [],
  ldapId: null,
  createdAt: '2026-11-01T10:00:00Z',
  users: [],
  allowedOidcClients: [],
});

export const groupMinimal = (id: string, name: string) => ({
  id,
  friendlyName: name,
  name,
  customClaims: [],
  userCount: 0,
  ldapId: null,
  createdAt: '2026-11-01T10:00:00Z',
});

export const userDto = (id: string, o: { isAdmin?: boolean; disabled?: boolean } = {}) => ({
  id,
  username: `u-${id}`,
  email: `${id}@example.test`,
  emailVerified: true,
  firstName: 'Dev',
  lastName: null,
  displayName: 'Dev',
  isAdmin: o.isAdmin ?? false,
  locale: null,
  customClaims: [],
  userGroups: [],
  ldapId: null,
  disabled: o.disabled ?? false,
});

export const configVariable = (key: string, value: string) => ({
  key,
  type: 'string',
  value,
  isPublic: false,
});

export const apiKeyDto = (id: string, expiresAt: string) => ({
  id,
  name: 'passbook-provisioner',
  description: null,
  expiresAt,
  lastUsedAt: null,
  createdAt: '2026-11-01T10:00:00Z',
  expirationEmailSent: false,
});

export function signupTokenDto(
  layout: Layout,
  t: {
    id: string;
    token: string;
    expiresAt: string;
    usageCount: number;
    groups: { id: string; name: string }[];
  },
) {
  return {
    id: t.id,
    // main adds `prefix`; the create answer carries the value in both layouts.
    token: t.token,
    ...(layout === 'admin' ? { prefix: t.token.slice(0, 4) } : {}),
    expiresAt: t.expiresAt,
    usageLimit: 1,
    usageCount: t.usageCount,
    userGroups: t.groups.map((g) => groupMinimal(g.id, g.name)),
    createdAt: '2026-11-20T12:00:00Z',
  };
}

export function auditAccountCreated(
  layout: Layout,
  row: { id: string; userId: string; createdAt: string; token: { id: string; value: string } },
) {
  return {
    id: row.id,
    createdAt: row.createdAt,
    event: 'ACCOUNT_CREATED',
    ipAddress: '203.0.113.9',
    country: '',
    city: '',
    device: 'Firefox on Linux',
    userID: row.userId,
    username: `u-${row.userId}`,
    actorUsername: '',
    data: layout === 'admin' ? { signupTokenID: row.token.id } : { signupToken: row.token.value },
  };
}
