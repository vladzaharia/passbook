import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { makeSession, makeUser } from '../../../../test/helpers/index.ts';
import type { OperationDto } from '../../../shared/contracts/operations.ts';
import { createApp } from '../../app.ts';
import { grantKitMembership } from '../passes/apple-release-test-fixtures.ts';
import { type Kit, setupKit } from '../passes/pass-test-fixtures.ts';
import { setupTenantTestAuth, type TenantTestAuth } from '../passes/tenant-test-fixtures.ts';
import {
  ORG_KIND,
  PLATFORM_KIND,
  registerTestKinds,
  STARTER_KIND,
} from './operations-test-fixtures.ts';
import { startOperation } from './start.ts';

const ORIGIN = 'https://wallet.test';
const TRAY = '?active=true&mine=true';
let kit: Kit;
let auth: TenantTestAuth;
let app: ReturnType<typeof createApp>;
let undo: () => void;

beforeEach(async () => {
  kit = await setupKit();
  auth = await setupTenantTestAuth(kit);
  app = createApp({ stores: auth.stores, clock: kit.clock });
  undo = registerTestKinds();
});
afterEach(() => undo());

const call = (path: string, headers: Record<string, string>, env = kit.env) =>
  app.request(`${ORIGIN}/api/v1/operations${path}`, { headers }, env);

async function signedIn(
  amr: 'oidc' | 'magic_link',
  roles: ('admin' | 'user' | 'developer' | 'console')[],
  orgRoles?: Parameters<typeof grantKitMembership>[3],
) {
  const user = await makeUser(kit.fx);
  const s = await makeSession(kit.fx, { userId: user.id, roles, amr });
  if (orgRoles) await grantKitMembership(kit, kit.org.id, user.id, orgRoles);
  return { userId: user.id, headers: { ...s.headers, origin: ORIGIN } };
}

const started = (userId: string) =>
  startOperation(kit.ctx, {
    kind: STARTER_KIND.kind,
    session: 'sess',
    actor: { type: 'user', id: userId },
  });

const ids = async (res: Response) =>
  ((await res.json()) as { items: OperationDto[] }).items.map((o) => o.id);

describe('the tray poll answers 2xx for every shell and role', () => {
  it('portal holder on an email link lists what they started', async () => {
    const holder = await signedIn('magic_link', ['user']);
    const mine = await started(holder.userId);
    await started((await signedIn('magic_link', ['user'])).userId);
    const res = await call(TRAY, holder.headers);
    expect(res.status).toBe(200);
    expect(await ids(res)).toEqual([mine.id]);
    expect((await call(`/${mine.id}`, holder.headers)).status).toBe(200);
  });

  it('portal holder with no operations gets an empty list', async () => {
    const holder = await signedIn('magic_link', ['user']);
    const res = await call(TRAY, holder.headers);
    expect(res.status).toBe(200);
    expect(await ids(res)).toEqual([]);
  });

  it('portal holder on Polaris ID without the console group, with the group required', async () => {
    const holder = await signedIn('oidc', ['user']);
    const env = { ...kit.env, OIDC_CONSOLE_GROUP_REQUIRED: 'true' };
    expect((await call(TRAY, holder.headers, env)).status).toBe(200);
  });

  it('admin, org member without operation permissions', async () => {
    const member = await signedIn('oidc', ['user'], ['template_reviewer']);
    expect((await call(TRAY, member.headers)).status).toBe(200);
  });

  it('admin, org admin', async () => {
    const admin = await signedIn('oidc', ['user'], ['org_admin']);
    const op = await startOperation(kit.ctx, {
      kind: ORG_KIND.kind,
      org: { orgId: kit.org.id, mode: 'live' },
      actor: { type: 'user', id: admin.userId },
      subject: { k: 'x' },
    });
    const res = await call(`${TRAY}&orgId=${kit.org.id}`, admin.headers);
    expect(res.status).toBe(200);
    expect(await ids(res)).toEqual([op.id]);
    expect((await call(TRAY, admin.headers)).status).toBe(200);
  });

  it('developer site, developer without the console group', async () => {
    const dev = await signedIn('oidc', ['user', 'developer']);
    const env = { ...kit.env, OIDC_CONSOLE_GROUP_REQUIRED: 'true' };
    expect((await call(TRAY, dev.headers, env)).status).toBe(200);
  });

  it('platform admin', async () => {
    expect((await call(TRAY, auth.admin())).status).toBe(200);
  });
});

describe('a session without console access lists only its own', () => {
  it('refuses every other filter with 403', async () => {
    const holder = await signedIn('magic_link', ['user']);
    for (const q of ['', '?active=true', '?mine=true&kind=test.org', '?mine=true&target=a:b'])
      expect((await call(q, holder.headers)).status).toBe(403);
    expect((await call(`?mine=true&orgId=${kit.org.id}`, holder.headers)).status).toBe(403);
  });

  it('never reaches org or platform rows, even with an admin role on an email link', async () => {
    const link = await signedIn('magic_link', ['admin', 'user'], ['org_admin']);
    await startOperation(kit.ctx, {
      kind: PLATFORM_KIND.kind,
      actor: { type: 'user', id: link.userId },
    });
    const org = await startOperation(kit.ctx, {
      kind: ORG_KIND.kind,
      org: { orgId: kit.org.id, mode: 'live' },
      actor: { type: 'user', id: link.userId },
      subject: { k: 'y' },
    });
    expect(await ids(await call(TRAY, link.headers))).toEqual([]);
    expect((await call(`/${org.id}`, link.headers)).status).toBe(404);
  });

  it('keeps the rest of the routes at console level', async () => {
    const holder = await signedIn('magic_link', ['user']);
    const op = await started(holder.userId);
    const res = await app.request(
      `${ORIGIN}/api/v1/operations/${op.id}/cancel`,
      { method: 'POST', headers: holder.headers },
      kit.env,
    );
    expect(res.status).toBe(403);
  });
});
