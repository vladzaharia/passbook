import { assertId } from './policy.ts';
import type { Layout } from './types.ts';

/** Pocket ID routes per layout (design 3.4). Ids are validated here, so no caller text becomes path syntax. */
export function routes(layout: Layout) {
  const admin = layout === 'admin';
  const base = admin ? '/api/admin' : '/api';
  const id = (kind: string, v: string) => encodeURIComponent(assertId(kind, v));
  return {
    group: (gid: string) => `${base}/user-groups/${id('group id', gid)}`,
    config: admin ? '/api/admin/application-configuration' : '/api/application-configuration/all',
    apiKeys: '/api/api-keys',
    signupTokens: `${base}/signup-tokens`,
    signupToken: (tid: string) => `${base}/signup-tokens/${id('token id', tid)}`,
    auditLogs: (page: number) =>
      `${admin ? '/api/admin/audit-logs' : '/api/audit-logs/all'}?filters[event]=ACCOUNT_CREATED&sort[column]=createdAt&sort[direction]=desc&pagination[limit]=100&pagination[page]=${page}`,
    user: (sub: string) => `${base}/users/${id('subject', sub)}`,
    userGroups: (sub: string) => `${base}/users/${id('subject', sub)}/groups`,
    setUserGroups: (sub: string) => `${base}/users/${id('subject', sub)}/user-groups`,
  };
}
export type Routes = ReturnType<typeof routes>;
