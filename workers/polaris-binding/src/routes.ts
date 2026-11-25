import { assertId, assertSubject } from './policy.ts';
import type { Layout } from './types.ts';

/** Polaris ID routes per layout. Ids are validated here, so no caller text becomes path syntax. */
export function routes(layout: Layout) {
  const admin = layout === 'admin';
  const base = admin ? '/api/admin' : '/api';
  const id = (kind: string, v: string) => encodeURIComponent(assertId(kind, v));
  const sub = (v: string) => encodeURIComponent(assertSubject(v));
  return {
    group: (gid: string) => `${base}/user-groups/${id('group id', gid)}`,
    config: admin ? '/api/admin/application-configuration' : '/api/application-configuration/all',
    apiKeys: '/api/api-keys',
    client: (cid: string) => `${base}/oidc/clients/${id('client id', cid)}`,
    signupTokens: `${base}/signup-tokens`,
    signupToken: (tid: string) => `${base}/signup-tokens/${id('token id', tid)}`,
    auditLogs: (page: number) =>
      `${admin ? '/api/admin/audit-logs' : '/api/audit-logs/all'}?filters[event]=ACCOUNT_CREATED&sort[column]=createdAt&sort[direction]=desc&pagination[limit]=100&pagination[page]=${page}`,
    me: `${base}/users/me`,
    /** A search for an address. The caller validated it; it is encoded here. */
    users: (search: string, page: number) =>
      `${base}/users?search=${encodeURIComponent(search)}&pagination[limit]=100&pagination[page]=${page}`,
    user: (s: string) => `${base}/users/${sub(s)}`,
    userGroups: (s: string) => `${base}/users/${sub(s)}/groups`,
    setUserGroups: (s: string) => `${base}/users/${sub(s)}/user-groups`,
  };
}
export type Routes = ReturnType<typeof routes>;

/**
 * Every request the binding may send, as method and path pattern. `pocketRequest` refuses anything else, so
 * POST/DELETE users, one-time access tokens, custom claims, OIDC client writes, group writes, config writes and
 * API key writes cannot be reached by any code path. A test lists what the RPCs actually send.
 */
export function allowedRoutes(layout: Layout): { method: string; path: RegExp }[] {
  const base = layout === 'admin' ? '/api/admin' : '/api';
  const id = '[A-Za-z0-9_-]{1,64}';
  const config =
    layout === 'admin'
      ? '/api/admin/application-configuration'
      : '/api/application-configuration/all';
  const audit = layout === 'admin' ? '/api/admin/audit-logs' : '/api/audit-logs/all';
  const rule = (method: string, path: string) => ({ method, path: new RegExp(`^${path}$`) });
  return [
    rule('GET', `${base}/user-groups/${id}`),
    rule('GET', config),
    rule('GET', '/api/api-keys'),
    rule('GET', `${base}/oidc/clients/${id}`),
    rule('GET', `${base}/users/me`),
    rule('GET', `${base}/users`),
    rule('GET', `${base}/users/${id}`),
    rule('GET', `${base}/users/${id}/groups`),
    rule('PUT', `${base}/users/(?!me$)${id}`),
    rule('PUT', `${base}/users/(?!me/)${id}/user-groups`),
    rule('GET', `${base}/signup-tokens`),
    rule('POST', `${base}/signup-tokens`),
    rule('DELETE', `${base}/signup-tokens/${id}`),
    rule('GET', audit),
  ];
}
