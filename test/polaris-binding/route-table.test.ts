import { beforeEach, describe, expect, it } from 'vitest';
import { allowedRoutes, routes } from '../../workers/polaris-binding/src/routes.ts';
import { ctx, groupsJson, resetLedger, seedCreated, seedGrant, setup, userCtx } from './harness.ts';

beforeEach(resetLedger);

/** Replaces ids with a placeholder so a request reads as a route shape. */
const shape = (method: string, path: string) =>
  `${method} ${path.replace(/[?].*$/, '').replace(/\/(?:[uc]\d|g-[a-z]+|tok-id-\d|client-1|key-user|u-new|tok-x)(?=\/|$)/g, '/:id')}`;

describe.each(['v2', 'admin'] as const)('route table (%s layout)', (layout) => {
  const base = layout === 'admin' ? '/api/admin' : '/api';
  const ALLOWED = [
    `GET ${base}/user-groups/:id`,
    `GET ${layout === 'admin' ? '/api/admin/application-configuration' : '/api/application-configuration/all'}`,
    'GET /api/api-keys',
    `GET ${base}/oidc/clients/:id`,
    `GET ${base}/users/me`,
    `GET ${base}/users`,
    `GET ${base}/users/:id`,
    `GET ${base}/users/:id/groups`,
    `PUT ${base}/users/:id`,
    `PUT ${base}/users/:id/user-groups`,
    `GET ${base}/signup-tokens`,
    `POST ${base}/signup-tokens`,
    `DELETE ${base}/signup-tokens/:id`,
    `GET ${layout === 'admin' ? '/api/admin/audit-logs' : '/api/audit-logs/all'}`,
  ];

  it('every request the RPC methods send is on the list, and every route on the list is sent', async () => {
    const { api, pocket } = setup(layout, { GROUPS: groupsJson({ support: true }) });
    pocket.addUser('u1', { groups: ['g-dev'], email: 'a@example.test' });
    pocket.addUser('u2');
    pocket.addUser('c1', { groups: ['g-dev'] });
    await seedGrant('u1');
    await seedCreated('c1');
    await api.health();
    const link = await api.createSignup('developer', ctx());
    pocket.signUp('tok-id-1', 'u-new');
    await api.proveSignup([(link as { tokenId: string }).tokenId]);
    await api.createSignup('member', ctx());
    await api.deleteSignup('tok-id-2', ctx());
    await api.findByVerifiedEmail('a@example.test', ctx());
    await api.lookup('u1');
    await api.apply('u2', { add: ['console'] }, ctx());
    await api.apply('u1', { remove: ['developer'] }, ctx());
    await api.setDisabled('c1', true, ctx());
    await api.snapshot(ctx());
    await api.freeze('check', userCtx());
    const sent = new Set(pocket.s.seen.map((r) => shape(r.method, r.path)));
    for (const s of sent) expect(ALLOWED, s).toContain(s);
    for (const a of ALLOWED) expect([...sent], a).toContain(a);
  });

  it('the guard in pocketRequest and the route builders agree with the list', () => {
    const r = routes(layout);
    const built = [
      r.group('g1'),
      r.config,
      r.apiKeys,
      r.client('c1'),
      r.me,
      r.users('a@b.test', 1),
      r.user('u1'),
      r.userGroups('u1'),
      r.setUserGroups('u1'),
      r.signupTokens,
      r.signupToken('t1'),
      r.auditLogs(1),
    ];
    const table = allowedRoutes(layout);
    for (const path of built) {
      const pathname = path.replace(/[?].*$/, '');
      expect(
        table.some((t) => t.path.test(pathname)),
        path,
      ).toBe(true);
    }
  });

  it('allows no POST or DELETE on users, no group write and no write of config, clients or keys', () => {
    const table = allowedRoutes(layout);
    const hits = (method: string, path: string) =>
      table.filter((t) => t.method === method && t.path.test(path));
    for (const [method, path] of [
      ['POST', `${base}/users`],
      ['DELETE', `${base}/users/u1`],
      ['PUT', `${base}/users/me`],
      ['POST', `${base}/users/u1/one-time-access-token`],
      ['POST', `${base}/user-groups`],
      ['PUT', `${base}/user-groups/g1`],
      ['DELETE', `${base}/user-groups/g1`],
      ['PUT', `${base}/user-groups/g1/users`],
      ['POST', `${base}/oidc/clients`],
      ['PUT', `${base}/oidc/clients/c1`],
      ['PUT', '/api/custom-claims/user/u1'],
      ['PUT', `${base}/application-configuration`],
      ['POST', '/api/api-keys'],
      ['DELETE', '/api/api-keys/k1'],
    ] as const)
      expect(hits(method, path), `${method} ${path}`).toHaveLength(0);
  });
});

const SOURCES = import.meta.glob('../../workers/polaris-binding/src/*.ts', {
  query: '?raw',
  import: 'default',
  eager: true,
}) as Record<string, string>;
const source = (name: string) => SOURCES[`../../workers/polaris-binding/src/${name}.ts`] as string;

describe('source', () => {
  it('sends requests only through pocketRequest', () => {
    expect(source('call')).toContain('pocketRequest(env, deps');
    for (const f of ['api-accounts', 'api-directory', 'api-groups', 'health', 'groups', 'user-put'])
      expect(source(f), f).not.toMatch(/\bfetch\(|deps\.fetch/);
  });
});
