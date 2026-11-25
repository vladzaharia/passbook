import { expect, type Route, test } from '@playwright/test';
import type { OrgMembership } from '../src/shared/contracts/org-membership.ts';
import type { SessionResponse } from '../src/shared/contracts/session.ts';
import {
  apiAs,
  createPass,
  freshAdminApi,
  requireActiveTemplateRelease,
  uid,
} from './helpers/api.ts';
import { templateFromBlueprint } from './helpers/releases.ts';
import { addOrgMember, createOrgWithRoles, readSeed } from './helpers/seed.ts';

const SCOPE = 'passbook-admin-scope';
const inOrg = (id: string, rest = '') => `/admin/o/${encodeURIComponent(id)}${rest}`;

test.describe('platform administrator', () => {
  test.use({ storageState: 'e2e/.auth/admin.json' });

  test('a single membership opens directly; a forged choice never does', async ({ page }) => {
    const org = readSeed().org;
    const api = await apiAs('admin');
    try {
      const memberships = await api.get<{ items: OrgMembership[] }>('/api/v1/orgs/memberships/me');
      expect(memberships.items).toContainEqual(
        expect.objectContaining({ orgId: org.id, revokedAt: null }),
      );
    } finally {
      await api.dispose();
    }

    // Use a real grant, but isolate it from other memberships in a persisted local database.
    await page.route('**/api/v1/orgs/memberships/me', async (route) => {
      const response = await route.fetch();
      const body = (await response.json()) as { items: OrgMembership[] };
      await route.fulfill({
        response,
        json: { ...body, items: body.items.filter((membership) => membership.orgId === org.id) },
      });
    });
    await page.goto('/admin');
    await page.evaluate((key) => localStorage.removeItem(key), SCOPE);
    const passRequests: URL[] = [];
    page.on('request', (request) => {
      const url = new URL(request.url());
      if (request.method() === 'GET' && url.pathname === '/api/v1/passes') passRequests.push(url);
    });

    // An old link without an organization opens the only one, and the path names it.
    await page.goto('/admin/passes');
    await expect(page.getByRole('heading', { name: 'Passes', level: 1 })).toBeVisible();
    await expect.poll(() => new URL(page.url()).pathname).toBe(inOrg(org.id, '/passes'));
    expect(new URL(page.url()).searchParams.has('orgId')).toBe(false);
    await expect.poll(() => passRequests.length).toBeGreaterThan(0);
    expect(passRequests.every((url) => url.searchParams.get('orgId') === org.id)).toBe(true);
    await expect
      .poll(() => page.evaluate((key) => localStorage.getItem(key), SCOPE))
      .toBe(`org:${org.id}`);

    const restoredList = page.waitForResponse((response) => {
      const url = new URL(response.url());
      return (
        response.request().method() === 'GET' &&
        url.pathname === '/api/v1/passes' &&
        url.searchParams.get('orgId') === org.id &&
        url.searchParams.get('status') === 'active'
      );
    });
    await page.goto(`${inOrg(org.id, '/passes')}?status=active`);
    expect(new URL(page.url()).searchParams.get('status')).toBe('active');
    await expect(page.getByRole('heading', { name: 'Passes', level: 1 })).toBeVisible();
    expect((await restoredList).status()).toBe(200);

    const beforeForgedUrl = passRequests.length;
    await page.goto('/admin/passes?orgId=not-a-membership');
    await expect(
      page.getByRole('heading', { name: 'You do not have access', level: 1 }),
    ).toBeVisible();
    expect(passRequests.slice(beforeForgedUrl)).toEqual([]);
    expect(new URL(page.url()).pathname).toBe(inOrg('not-a-membership', '/passes'));

    // A forged remembered scope is ignored: the only real membership opens.
    await page.evaluate((key) => localStorage.setItem(key, 'org:not-a-membership'), SCOPE);
    await page.goto('/admin/passes');
    await expect(page.getByRole('heading', { name: 'Passes', level: 1 })).toBeVisible();
    await expect.poll(() => new URL(page.url()).pathname).toBe(inOrg(org.id, '/passes'));
  });

  test('platform directories remain available without tenant grants, but a selection grants nothing', async ({
    page,
  }) => {
    const api = await apiAs('admin');
    let org: { id: string; name: string };
    try {
      const slug = uid('platform-only').toLowerCase();
      org = await api.send('POST', '/api/v1/orgs', {
        slug,
        name: `Platform only ${slug}`,
        preset: 'legacy',
        addMe: false,
      });
      const memberships = await api.get<{ items: OrgMembership[] }>('/api/v1/orgs/memberships/me');
      expect(memberships.items.some((membership) => membership.orgId === org.id)).toBe(false);
    } finally {
      await api.dispose();
    }

    await page.route('**/api/v1/orgs/memberships/me', (route) =>
      route.fulfill({ json: { items: [] } }),
    );
    const requests: string[] = [];
    page.on('request', (request) => {
      if (request.method() === 'GET') requests.push(new URL(request.url()).pathname);
    });
    const orgPath = `/api/v1/orgs/${org.id}`;
    const workspacePath = `${orgPath}/workspace`;

    await page.goto(`/admin/orgs/${encodeURIComponent(org.id)}`);
    await expect(page.getByRole('heading', { name: org.name, level: 1 })).toBeVisible();
    await expect(
      page.locator('main').getByRole('link', { name: 'Audit log', exact: true }),
    ).toBeVisible();
    await expect(page.getByRole('link', { name: 'Open workspace' })).toHaveCount(0);
    expect(requests).toContain(orgPath);
    expect(requests).not.toContain(workspacePath);
    const nav = page.getByRole('navigation', { name: 'Admin' });
    for (const name of [
      'Users',
      'Organizations',
      'Settings',
      'Status',
      'Wallet accounts',
      'API keys',
    ]) {
      await expect(nav.getByRole('link', { name, exact: true })).toBeVisible();
    }
    await expect(nav.getByRole('link', { name: 'Passes', exact: true })).toHaveCount(0);

    for (const [path, heading] of [
      ['/admin/users', 'Users'],
      ['/admin/orgs', 'Organizations'],
      ['/admin/settings', 'Platform settings'],
      ['/admin/status', 'System status'],
      ['/admin/identities', 'Wallet accounts'],
      ['/admin/api-keys', 'API keys'],
    ] as const) {
      await page.goto(path);
      await expect(page.getByRole('heading', { name: heading, level: 1 })).toBeVisible();
    }

    await page.evaluate(({ key, id }) => localStorage.setItem(key, `org:${id}`), {
      key: SCOPE,
      id: org.id,
    });
    await page.goto(`/admin/passes?orgId=${encodeURIComponent(org.id)}`);
    await expect(
      page.getByRole('heading', { name: 'You do not have access', level: 1 }),
    ).toBeVisible();
    expect(requests).not.toContain('/api/v1/passes');
    await page.goto(
      `/admin/orgs/${encodeURIComponent(org.id)}?view=workspace&orgId=${encodeURIComponent(org.id)}`,
    );
    await expect(
      page.getByRole('heading', {
        name: /Organization not found|You do not have access/,
        level: 1,
      }),
    ).toBeVisible();
    expect(requests).not.toContain(workspacePath);
    expect(requests).not.toContain(`${orgPath}/memberships`);
    expect(requests).not.toContain(`${orgPath}/invitations`);

    await page.goto(`/admin/orgs/${encodeURIComponent(org.id)}`);
    await expect(page.getByRole('heading', { name: org.name, level: 1 })).toBeVisible();
    await expect(
      page.locator('main').getByRole('link', { name: 'Audit log', exact: true }),
    ).toBeVisible();
  });

  test('workspace and pass access disappear after a real administrator membership is revoked', async ({
    page,
    browser,
  }) => {
    // Inviting an org_admin needs a recent sign-in; the stored session is minutes old by this spec.
    // A new sign-in ends the old session, so the page takes the new cookies.
    const api = await freshAdminApi(browser);
    await page.context().addCookies((await api.ctx.storageState()).cookies);
    let revoke: { orgId: string; id: string } | undefined;
    try {
      const slug = uid('shell-revocation').toLowerCase();
      const org = await createOrgWithRoles(api, { slug, name: `Shell revocation ${slug}` });
      // A second administrator keeps the revoked one from being the organization's last.
      const peer = await apiAs('user');
      try {
        await addOrgMember(api, org.id, peer, ['org_admin']);
      } finally {
        await peer.dispose();
      }
      const memberships = await api.get<{ items: OrgMembership[] }>('/api/v1/orgs/memberships/me');
      const membership = memberships.items.find((item) => item.orgId === org.id);
      if (!membership) throw new Error('Expected the created administrator membership');
      revoke = { orgId: org.id, id: membership.id };
      // Templates belong to one org: this org makes its own from the blueprint.
      const template = await templateFromBlueprint(api, org.id, 'Shell revocation');
      const pass = await createPass(api, org.id, {
        holder: uid('Revocation proof'),
        release: await requireActiveTemplateRelease(api, org.id, template.id),
      });
      const listPath = `/api/v1/passes?orgId=${encodeURIComponent(org.id)}`;
      const visible = await api.get<{ items: { id: string }[] }>(listPath);
      expect(visible.items).toContainEqual(expect.objectContaining({ id: pass.id }));
      const orgPath = `/api/v1/orgs/${org.id}`;
      const requests: string[] = [];
      page.on('request', (request) => {
        if (request.method() === 'GET') requests.push(new URL(request.url()).pathname);
      });

      await page.goto(`/admin/orgs/${encodeURIComponent(org.id)}`);
      await expect(page.getByRole('heading', { name: org.name, level: 1 })).toBeVisible();
      await expect(
        page.locator('main').getByRole('link', { name: 'Audit log', exact: true }),
      ).toBeVisible();
      expect(requests).not.toContain(`${orgPath}/workspace`);
      await page.getByRole('link', { name: 'Open workspace' }).first().click();
      await expect(page.getByRole('link', { name: 'Platform provisioning' })).toBeVisible();
      await expect.poll(() => new URL(page.url()).pathname).toBe(inOrg(org.id, '/settings'));
      expect(requests).toContain(`${orgPath}/workspace`);

      const passList = page.waitForResponse((response) => {
        const url = new URL(response.url());
        return (
          response.request().method() === 'GET' &&
          url.pathname === '/api/v1/passes' &&
          url.searchParams.get('orgId') === org.id
        );
      });
      await page.goto(`/admin/passes?orgId=${encodeURIComponent(org.id)}`);
      await expect(page.getByRole('heading', { name: 'Passes', level: 1 })).toBeVisible();
      expect((await passList).status()).toBe(200);
      await expect
        .poll(() => requests.filter((path) => path === '/api/v1/passes').length)
        .toBeGreaterThan(0);
      await api.send('DELETE', `${orgPath}/memberships/${encodeURIComponent(membership.id)}`);
      revoke = undefined;
      const after = await api.get<{ items: OrgMembership[] }>('/api/v1/orgs/memberships/me');
      expect(after.items.some((item) => item.id === membership.id)).toBe(false);
      const deniedList = await api.ctx.get(listPath);
      expect(deniedList.status()).toBe(403);
      const deniedDetail = await api.ctx.get(`/api/v1/passes/${encodeURIComponent(pass.id)}`);
      expect(deniedDetail.status()).toBe(403);

      requests.length = 0;
      await page.goto(`/admin/passes?orgId=${encodeURIComponent(org.id)}`);
      await expect(
        page.getByRole('heading', { name: 'You do not have access', level: 1 }),
      ).toBeVisible();
      expect(requests).not.toContain('/api/v1/passes');
      // A remembered organization the principal left is never reopened. With no other
      // organization (isolated from the shared database's grants) the chooser has none to offer.
      const isolate = (route: Route) => route.fulfill({ json: { items: [] } });
      await page.route('**/api/v1/orgs/memberships/me', isolate);
      await page.evaluate(({ key, id }) => localStorage.setItem(key, `org:${id}`), {
        key: SCOPE,
        id: org.id,
      });
      requests.length = 0;
      await page.goto('/admin/passes');
      await expect(page.getByRole('heading', { name: 'No organizations', level: 1 })).toBeVisible();
      expect(new URL(page.url()).pathname).toBe('/admin');
      expect(requests).not.toContain('/api/v1/passes');
      await page.unroute('**/api/v1/orgs/memberships/me', isolate);

      await page.goto(
        `/admin/orgs/${encodeURIComponent(org.id)}?view=workspace&orgId=${encodeURIComponent(org.id)}`,
      );
      await expect(
        page.getByRole('heading', {
          name: /Organization not found|You do not have access/,
          level: 1,
        }),
      ).toBeVisible();
      expect(requests).not.toContain(`${orgPath}/workspace`);
      await page.goto(`/admin/orgs/${encodeURIComponent(org.id)}`);
      await expect(page.getByRole('heading', { name: org.name, level: 1 })).toBeVisible();
      await expect(
        page.locator('main').getByRole('link', { name: 'Audit log', exact: true }),
      ).toBeVisible();
      await expect(page.getByRole('link', { name: 'Open workspace' })).toHaveCount(0);

      // Even a stale membership response carrying the revoked grant cannot restore access.
      await page.route('**/api/v1/orgs/memberships/me', (route) =>
        route.fulfill({ json: { items: [{ ...membership, revokedAt: Date.now() }] } }),
      );
      requests.length = 0;
      await page.goto(`/admin/passes?orgId=${encodeURIComponent(org.id)}`);
      await expect(
        page.getByRole('heading', { name: 'You do not have access', level: 1 }),
      ).toBeVisible();
      expect(requests).not.toContain('/api/v1/passes');
    } finally {
      try {
        if (revoke) {
          await api.send(
            'DELETE',
            `/api/v1/orgs/${encodeURIComponent(revoke.orgId)}/memberships/${encodeURIComponent(revoke.id)}`,
          );
        }
      } finally {
        await api.dispose();
      }
    }
  });
});

test.describe('organization member', () => {
  test.use({ storageState: 'e2e/.auth/user.json' });

  test('a non-admin member can enter its authorized workspace but not platform or ungranted routes', async ({
    page,
  }) => {
    const admin = await apiAs('admin');
    const member = await apiAs('user');
    let revoke: { orgId: string; id: string } | undefined;
    try {
      const session = await member.get<SessionResponse>('/api/v1/session');
      expect(session.authenticated).toBe(true);
      if (!session.authenticated) throw new Error('Expected an authenticated member');
      expect(session.roles).not.toContain('admin');
      const slug = uid('shell-member').toLowerCase();
      const org = await createOrgWithRoles(admin, { slug, name: `Shell member ${slug}` });
      const membership = await addOrgMember(admin, org.id, member, ['pass_operator']);
      revoke = { orgId: org.id, id: membership.id };
      expect(membership.capabilities).toContain('passes:read');
      expect(membership.capabilities).not.toContain('integrations:read');
      const requests: string[] = [];
      page.on('request', (request) => {
        if (request.method() === 'GET') requests.push(new URL(request.url()).pathname);
      });

      await page.goto(`/admin/passes?orgId=${encodeURIComponent(org.id)}`);
      await expect(page.getByRole('heading', { name: 'Passes', level: 1 })).toBeVisible();
      await expect.poll(() => requests.includes('/api/v1/passes')).toBe(true);
      const nav = page.getByRole('navigation', { name: 'Admin' });
      await expect(nav.getByRole('link', { name: 'Users', exact: true })).toHaveCount(0);
      await expect(nav.getByRole('link', { name: 'Connections', exact: true })).toHaveCount(0);

      await page.goto(`/admin/connections?orgId=${encodeURIComponent(org.id)}`);
      await expect(
        page.getByRole('heading', { name: 'You do not have access', level: 1 }),
      ).toBeVisible();
      expect(requests).not.toContain('/api/v1/connections');
      await page.goto(
        `/admin/orgs/${encodeURIComponent(org.id)}?view=workspace&orgId=${encodeURIComponent(org.id)}`,
      );
      // Settings is a section page: the h1 is "Settings"; the scope names the org.
      await expect(page.getByRole('heading', { name: 'Settings', level: 1 })).toBeVisible();
      await expect.poll(() => requests.includes(`/api/v1/orgs/${org.id}/workspace`)).toBe(true);

      requests.length = 0;
      await page.goto(`/admin/orgs/${encodeURIComponent(org.id)}`);
      await expect(
        page.getByRole('heading', {
          name: /Organization not found|You do not have access/,
          level: 1,
        }),
      ).toBeVisible();
      expect(requests).not.toContain(`/api/v1/orgs/${org.id}/workspace`);
      await page.goto('/admin/users');
      await expect(
        page.getByRole('heading', { name: 'You do not have access', level: 1 }),
      ).toBeVisible();
    } finally {
      try {
        if (revoke) {
          await admin.send(
            'DELETE',
            `/api/v1/orgs/${encodeURIComponent(revoke.orgId)}/memberships/${encodeURIComponent(revoke.id)}`,
          );
        }
      } finally {
        await member.dispose();
        await admin.dispose();
      }
    }
  });
});
