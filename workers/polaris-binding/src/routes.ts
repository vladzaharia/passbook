import { assertClientId, assertId, assertSubject } from './policy.ts';
import { clientIdOk, encodeClientId } from './registry.ts';
import type { Layout } from './types.ts';

const escapeRegExp = (v: string) => v.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Polaris ID routes per layout. Ids are validated here, so no caller text becomes path syntax. */
export function routes(layout: Layout) {
  const admin = layout === 'admin';
  const base = admin ? '/api/admin' : '/api';
  const id = (kind: string, v: string) => encodeURIComponent(assertId(kind, v));
  const sub = (v: string) => encodeURIComponent(assertSubject(v));
  return {
    groupSearch: (name: string, page = 1) =>
      `${base}/user-groups?search=${encodeURIComponent(name)}&pagination[limit]=100${page > 1 ? `&pagination[page]=${page}` : ''}`,
    groups: `${base}/user-groups`,
    groupPage: (page: number) =>
      `${base}/user-groups?pagination[limit]=100&pagination[page]=${page}`,
    groupClients: (gid: string) =>
      `${base}/user-groups/${id('group id', gid)}/allowed-oidc-clients`,
    userClaims: (s: string) => `${base}/custom-claims/user/${sub(s)}`,
    groupClaims: (gid: string) => `${base}/custom-claims/user-group/${id('group id', gid)}`,
    group: (gid: string) => `${base}/user-groups/${id('group id', gid)}`,
    config: admin ? '/api/admin/application-configuration' : '/api/application-configuration/all',
    apiKeys: '/api/api-keys',
    client: (cid: string) => `${base}/oidc/clients/${assertClientId(cid)}`,
    /** PUT to the client path writes its settings; the allowed groups and the SCIM connection hang off it. */
    clientGroups: (cid: string) =>
      `${base}/oidc/clients/${assertClientId(cid)}/allowed-user-groups`,
    scimOf: (cid: string) => `${base}/oidc/clients/${assertClientId(cid)}/scim-service-provider`,
    scimCreate: `${base}/scim/service-provider`,
    scim: (pid: string) => `${base}/scim/service-provider/${id('provider id', pid)}`,
    scimSync: (pid: string) => `${base}/scim/service-provider/${id('provider id', pid)}/sync`,
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
 * Never allowed: POST or DELETE of users, one-time access tokens, `PUT user-groups/{id}/users` (a whole-group
 * replace), `POST oidc/clients`, `DELETE oidc/clients/*`, client secrets, client refresh, any client but the
 * configured one, `DELETE scim/service-provider/*`, `GET custom-claims/suggestions` (every app's keys), config
 * writes and API key writes. The group, claim, client and SCIM writes that are allowed are called only through
 * group-admin.ts, api-claims.ts and setup-*.ts. A test lists what the RPCs actually send.
 * The client path is the configured client's exact encoded literal. `~` is allowed there and nowhere else:
 * Polaris ID decodes `~` in every `:id`, so `~bWU` on a user route would reach it as `me`.
 */
export function allowedRoutes(
  layout: Layout,
  clientId: string,
): { method: string; path: RegExp }[] {
  const base = layout === 'admin' ? '/api/admin' : '/api';
  const id = '[A-Za-z0-9_-]{1,64}';
  const config =
    layout === 'admin'
      ? '/api/admin/application-configuration'
      : '/api/application-configuration/all';
  const audit = layout === 'admin' ? '/api/admin/audit-logs' : '/api/audit-logs/all';
  const rule = (method: string, path: string) => ({ method, path: new RegExp(`^${path}$`) });
  return [
    rule('GET', `${base}/user-groups`),
    rule('POST', `${base}/user-groups`),
    rule('GET', `${base}/user-groups/${id}`),
    rule('PUT', `${base}/user-groups/${id}`),
    rule('DELETE', `${base}/user-groups/${id}`),
    rule('PUT', `${base}/user-groups/${id}/allowed-oidc-clients`),
    rule('PUT', `${base}/custom-claims/user/(?!me$)${id}`),
    rule('PUT', `${base}/custom-claims/user-group/${id}`),
    rule('GET', config),
    rule('GET', '/api/api-keys'),
    ...(clientIdOk(clientId)
      ? [
          ...['GET', 'PUT'].map((m) =>
            rule(m, `${base}/oidc/clients/${escapeRegExp(encodeClientId(clientId))}`),
          ),
          rule(
            'PUT',
            `${base}/oidc/clients/${escapeRegExp(encodeClientId(clientId))}/allowed-user-groups`,
          ),
          rule(
            'GET',
            `${base}/oidc/clients/${escapeRegExp(encodeClientId(clientId))}/scim-service-provider`,
          ),
          rule('POST', `${base}/scim/service-provider`),
          rule('PUT', `${base}/scim/service-provider/${id}`),
          rule('POST', `${base}/scim/service-provider/${id}/sync`),
        ]
      : []),
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
