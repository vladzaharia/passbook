import { type Browser, type BrowserContext, expect, type Page, test } from '@playwright/test';
import { type Api, freshAdminApi, uid } from './helpers/api.ts';
import { stateFile } from './helpers/auth.ts';
import { snapshotMail } from './helpers/mail.ts';
import {
  apiSignedInAs,
  drainUntil,
  finishOperation,
  nextInvite,
  POLARIS_ORIGIN,
  polaris,
  polarisGroups,
  signInLinkAs,
  snapshotWindow,
} from './helpers/polaris.ts';
import { readSeed } from './helpers/seed.ts';
import { stubTurnstile } from './helpers/turnstile.ts';

/**
 * Polaris access, end to end (pocketid-binding-design.md section 9, PB-E): the real Polaris ID binding Worker runs beside the app
 * over a mock Polaris ID (test/mock-oidc/admin-api.ts), writes are live, and the minute cron drains. Journeys run in order on one
 * person, then on groups, claims, platform invitations, the operations and the SCIM breaker. Freeze is last: the binding has
 * no thaw, so a rerun needs a fresh server (tools/e2e-server.ts starts one).
 */
test.describe.configure({ mode: 'serial' });

const run = uid('pa').replace(/[^a-z0-9]/g, '');
const email = (who: string) => `${who}.${run}@example.com`;
let admin: Api;
let org: { id: string; slug: string };

/** The admin signed in just now: platform writes need a recent sign-in. */
async function freshAdmin(browser: Browser) {
  await admin?.dispose();
  admin = await freshAdminApi(browser);
  return admin;
}
async function adminPage(browser: Browser): Promise<{ page: Page; context: BrowserContext }> {
  await freshAdmin(browser);
  const context = await browser.newContext({ storageState: stateFile('admin') });
  return { page: await context.newPage(), context };
}

/** The person follows an invitation link: makes a Polaris ID in the tab the page opens, signs in, and accepts. */
async function createAndAccept(
  page: Page,
  context: BrowserContext,
  secret: string,
  address: string,
) {
  await stubTurnstile(page);
  await page.goto(`/invite#${secret}`);
  // The signup link leaves for Polaris ID; the mock answers the page, and the account is made by the control below.
  await context.route(`${POLARIS_ORIGIN}/**`, (route) =>
    route.fulfill({
      contentType: 'text/html',
      body: '<title>Polaris ID</title><h1>Create your Polaris ID</h1>',
    }),
  );
  const tab = context.waitForEvent('page');
  await page.getByRole('button', { name: 'Create a Polaris ID' }).click();
  const opened = await tab;
  await opened.waitForURL(`${POLARIS_ORIGIN}/**`);
  const link = opened.url();
  const token = decodeURIComponent(new URL(link).pathname.replace('/st/', ''));
  expect(link.startsWith(POLARIS_ORIGIN)).toBe(true);
  const { sub } = await polaris<{ sub: string }>('signup', {
    token,
    email: address,
    name: 'Pat Person',
  });
  return sub;
}

test.beforeAll(async ({ browser }) => {
  org = readSeed().org;
  await freshAdmin(browser);
});
test.afterAll(async () => await admin?.dispose());

test.describe('connected', () => {
  test('Settings and Groups show Polaris ID access', async ({ browser }) => {
    const { page, context } = await adminPage(browser);
    await page.goto('/admin/platform/settings');
    await expect(page.getByRole('heading', { name: 'Polaris ID access' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Check now' })).toBeEnabled();
    await page.goto('/admin/platform/groups');
    await expect(page.getByRole('heading', { name: 'Groups' }).first()).toBeVisible();
    await context.close();
  });

  test('hide Polaris ID when the binding is absent', async ({ browser }) => {
    const { page, context } = await adminPage(browser);
    // The binding answers like the real absence: IDP_UNAVAILABLE on the status read.
    await page.route('**/api/v1/platform/idp', (route) =>
      route.fulfill({
        status: 503,
        contentType: 'application/problem+json',
        body: JSON.stringify({ status: 503, code: 'IDP_UNAVAILABLE', title: 'Unavailable' }),
      }),
    );
    await page.goto('/admin/platform/settings');
    await expect(page.getByRole('heading', { name: 'Settings' }).first()).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Polaris ID access' })).toHaveCount(0);
    await expect(page.getByRole('link', { name: 'Groups' })).toHaveCount(0);
    await context.close();
  });
});

test.describe('a member joins, is paused, restored and offboarded', () => {
  let sub = '';
  let userId = '';
  let membershipId = '';
  const address = email('pat');

  test('invite, Create a Polaris ID, sign in, accept', async ({ browser }) => {
    const before = snapshotMail();
    await admin.send('POST', `/api/v1/orgs/${org.id}/invitations`, {
      email: address,
      roles: ['read_only'],
    });
    const secret = await nextInvite(before, 'm_');
    const context = await browser.newContext();
    const page = await context.newPage();
    sub = await createAndAccept(page, context, secret, address);
    await signInLinkAs(page, sub);
    await page.getByRole('link', { name: 'Sign in with Polaris ID' }).click();
    await page.getByRole('button', { name: /^Accept/ }).click();
    await expect(page.getByRole('heading', { name: /joined|welcome/i })).toBeVisible();
    const me = await apiSignedInAs(sub);
    const memberships = await me.get<{ items: { id: string; orgId: string; userId: string }[] }>(
      '/api/v1/orgs/memberships/me',
    );
    const mine = memberships.items.find((m) => m.orgId === org.id);
    expect(mine).toBeDefined();
    membershipId = mine?.id ?? '';
    userId = mine?.userId ?? '';
    await context.close();
    // The console group came with the signup link and stays while the membership lives.
    await drainUntil(
      async () => (await polarisGroups(sub)).includes('passbook_console'),
      'console',
    );
  });

  test('the owner takes the role: the badge shows and Restore puts it back', async ({
    browser,
  }) => {
    // One Check now a minute is the binding's budget: the run waits for its window.
    test.setTimeout(180_000);
    await polaris('owner-remove', { sub, group: 'passbook_console' });
    await freshAdmin(browser);
    await snapshotWindow();
    const check = await admin.send<{ operation: { id: string } }>(
      'POST',
      '/api/v1/platform/idp/reconcile',
      {},
    );
    expect((await finishOperation(admin, check.operation.id)).status).toBe('succeeded');
    const { page, context } = await adminPage(browser);
    await page.goto(`/admin/o/${org.id}/members`);
    await expect(page.getByText('Access paused')).toBeVisible();
    await page.goto(`/admin/users/${userId}`);
    await expect(page.getByText('Paused in Polaris ID')).toBeVisible();
    await page.getByRole('button', { name: 'Restore' }).click();
    await page.getByRole('alertdialog').getByRole('button', { name: 'Restore' }).click();
    await expect
      .poll(async () => polarisGroups(sub), { timeout: 60_000 })
      .toContain('passbook_console');
    await context.close();
  });

  test('offboard shows its plan first and ends exactly that', async ({ browser }) => {
    await freshAdmin(browser);
    const plan = await admin.send<{ plan: { memberships: { membershipId: string }[] } }>(
      'POST',
      `/api/v1/users/${userId}/offboard`,
      { dryRun: true },
    );
    expect(plan.plan.memberships.map((m) => m.membershipId)).toContain(membershipId);
    const { page, context } = await adminPage(browser);
    await page.goto(`/admin/users/${userId}`);
    await page.getByRole('button', { name: 'Offboard' }).first().click();
    const dialog = page.getByRole('dialog');
    await expect(dialog.getByRole('listitem').first()).toBeVisible();
    await dialog
      .getByLabel(/^Type .* to confirm/)
      .fill(
        await dialog
          .getByText(/^Type .* to confirm/)
          .evaluate((el) => el.textContent?.match(/Type (.+?) to/)?.[1] ?? ''),
      );
    await dialog.getByRole('button', { name: 'Offboard' }).click();
    await expect
      .poll(async () => polarisGroups(sub), { timeout: 90_000 })
      .not.toContain('passbook_console');
    const access = await admin.get<{ disabled: boolean }>(`/api/v1/users/${userId}/access`);
    expect(access.disabled).toBe(true);
    await context.close();
  });
});

test.describe('an existing Polaris ID claims an invitation', () => {
  test('I have a Polaris ID finds the account and accepts', async ({ browser }) => {
    const address = email('eve');
    const { sub } = await polaris<{ sub: string }>('account', {
      sub: `eve-${run}`,
      email: address,
      name: 'Eve Existing',
    });
    const before = snapshotMail();
    await admin.send('POST', `/api/v1/orgs/${org.id}/invitations`, {
      email: address,
      roles: ['read_only'],
    });
    const secret = await nextInvite(before, 'm_');
    const context = await browser.newContext();
    const page = await context.newPage();
    await stubTurnstile(page);
    await page.goto(`/invite#${secret}`);
    // The claim gives the account its group, then the page sends the person to sign in: the link must be set first.
    await signInLinkAs(page, sub);
    await page.getByRole('button', { name: 'I have a Polaris ID' }).click();
    await page.getByRole('button', { name: /^Accept/ }).click();
    await expect
      .poll(async () => polarisGroups(sub), { timeout: 60_000 })
      .toContain('passbook_console');
    await context.close();
  });
});

test.describe('groups, rules, members and claims', () => {
  const key = `crew_${run}`.slice(0, 30);

  test('create a group with a rule, add a member, set a claim', async ({ browser }) => {
    await freshAdmin(browser);
    await admin.send('POST', '/api/v1/platform/idp/groups', {
      key,
      friendlyName: 'Crew',
      rules: [{ orgId: org.id }],
    });
    const { page, context } = await adminPage(browser);
    await page.goto(`/admin/platform/groups/${key}`);
    await expect(page.getByRole('heading', { name: 'Crew' }).first()).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Rules' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Members' })).toBeVisible();
    await page.getByRole('button', { name: 'Add claim' }).click();
    const dialog = page.getByRole('dialog', { name: 'Add claim' });
    await dialog.getByLabel(/^Key/).fill('passbook_seats');
    await dialog.getByLabel(/^Value/).fill('twelve');
    await dialog.getByRole('button', { name: 'Save claim' }).click();
    await expect(page.getByText('passbook_seats')).toBeVisible();
    await context.close();
    const claims = await admin.get<{ claims: Record<string, { value: unknown }> }>(
      `/api/v1/platform/idp/groups/${key}/claims`,
    );
    expect(claims.claims.passbook_seats?.value).toBe('twelve');
  });

  test('delete refuses a group that still has a rule', async () => {
    await expect(admin.send('DELETE', `/api/v1/platform/idp/groups/${key}`)).rejects.toThrow(
      / 409 /,
    );
  });
});

test.describe('platform invitations', () => {
  const group = `guests_${run}`.slice(0, 30);

  test('a matching address joins the group; a forwarded link enrols nobody else', async ({
    browser,
  }) => {
    await freshAdmin(browser);
    await admin.send('POST', '/api/v1/platform/idp/groups', { key: group, friendlyName: 'Guests' });
    const polarisGroup = `passbook_g_${group}`;
    for (const [who, signupAddress, outcome, developer] of [
      ['match', null, 'joined', false],
      ['mismatch', email('other'), 'refused', false],
      ['devmismatch', email('devother'), 'refused', true],
    ] as const) {
      const invited = email(who);
      const before = snapshotMail();
      await admin.send('POST', '/api/v1/platform/invitations', {
        email: invited,
        groups: [group],
        developer,
      });
      const secret = await nextInvite(before, 'p_');
      const context = await browser.newContext();
      const page = await context.newPage();
      const sub = await createAndAccept(page, context, secret, signupAddress ?? invited);
      // A stranger with their own address holds no group the moment the account exists: the token carries none.
      if (outcome === 'refused') {
        expect(await polarisGroups(sub)).not.toContain(polarisGroup);
        // Nor the developer role: a developer invitation's token carries none either.
        expect(await polarisGroups(sub)).not.toContain('passbook_developers');
      }
      const res = await context.request.post('/api/v1/invitations/confirm', {
        data: { token: secret },
      });
      if (outcome === 'joined') {
        expect(res.ok()).toBe(true);
        expect(await polarisGroups(sub)).toContain(polarisGroup);
      } else {
        expect(res.ok()).toBe(false);
        expect(await polarisGroups(sub)).not.toContain(polarisGroup);
        // The drain settles the refused account and still gives it nothing.
        await drainUntil(
          async () => (await admin.get<{ breakerOpen: boolean }>('/api/v1/platform/idp')) !== null,
          'the refused account is settled',
        );
        expect(await polarisGroups(sub)).not.toContain(polarisGroup);
      }
      await context.close();
    }
  });
});

test.describe('developer platform invitation', () => {
  test('a person with no Polaris ID signs up, is let in, accepts and holds the group', async ({
    browser,
  }) => {
    await freshAdmin(browser);
    // The group the invitations above made: group writes have a small daily budget.
    const group = `guests_${run}`.slice(0, 30);
    const invited = email('newdev');
    const before = snapshotMail();
    await admin.send('POST', '/api/v1/platform/invitations', {
      email: invited,
      groups: [group],
      developer: true,
    });
    const secret = await nextInvite(before, 'p_');
    const context = await browser.newContext();
    const page = await context.newPage();
    const sub = await createAndAccept(page, context, secret, invited);
    // The new account holds no group yet, so the PassBook client would refuse it.
    expect(await polarisGroups(sub)).not.toContain('passbook_developers');
    const done = await context.request.post('/api/v1/invitations/confirm', {
      data: { token: secret },
    });
    expect(done.status()).toBe(403);
    expect(await done.json()).toMatchObject({ code: 'IDP_SIGN_IN_REQUIRED' });
    // Done gave developer only: the sign-in works, and the accept adds the group.
    const groups = await polarisGroups(sub);
    expect(groups).toContain('passbook_developers');
    expect(groups).not.toContain(`passbook_g_${group}`);
    const me = await apiSignedInAs(sub);
    await me.send('POST', '/api/v1/invitations/accept', { token: secret });
    expect(await polarisGroups(sub)).toContain(`passbook_g_${group}`);
    await context.close();
  });
});

test.describe('operations', () => {
  test('Check now and Dry run finish; a failed read shows Retry and succeeds again', async ({
    browser,
  }) => {
    test.setTimeout(300_000);
    const { page, context } = await adminPage(browser);
    await page.goto('/admin/platform/settings');
    await snapshotWindow();
    await page.getByRole('button', { name: 'Check now' }).click();
    await page.getByRole('alertdialog').getByRole('button', { name: 'Check now' }).click();
    await expect(page.getByRole('button', { name: 'Done' })).toBeVisible({ timeout: 90_000 });
    await page.getByRole('button', { name: 'Done' }).click();
    await page.getByRole('button', { name: 'Dry run' }).click();
    await page.getByRole('alertdialog').getByRole('button', { name: 'Run' }).click();
    await expect(page.getByRole('button', { name: 'Done' })).toBeVisible({ timeout: 90_000 });
    await page.getByRole('button', { name: 'Done' }).click();
    await polaris('fail', { match: '^GET /api/user-groups', status: 500 });
    await snapshotWindow();
    await page.getByRole('button', { name: 'Check now' }).click();
    await page.getByRole('alertdialog').getByRole('button', { name: 'Check now' }).click();
    const retry = page.getByRole('button', { name: /retry/i });
    await expect(retry).toBeVisible({ timeout: 60_000 });
    await polaris('fail', {});
    await snapshotWindow();
    await retry.click();
    await expect(page.getByRole('button', { name: 'Done' })).toBeVisible({ timeout: 90_000 });
    await context.close();
  });
});

test.describe('the SCIM breaker', () => {
  test('21 session endings latch it and Clear breaker clears it', async ({ browser }) => {
    test.setTimeout(240_000);
    const subs: string[] = [];
    for (let i = 0; i < 22; i++) {
      const { sub } = await polaris<{ sub: string }>('account', {
        sub: `scim-${run}-${i}`,
        email: email(`scim${i}`),
        name: `Scim ${i}`,
        // Signing in needs a PassBook group, as the PassBook client is restricted to them.
        groups: ['passbook_console'],
      });
      await (await apiSignedInAs(sub)).dispose();
      subs.push(sub);
    }
    for (const sub of subs) await polaris('disable', { sub });
    for (const sub of subs) await polaris('scim', { op: 'deactivate', sub });
    await freshAdmin(browser);
    await expect
      .poll(
        async () => (await admin.get<{ breakerOpen: boolean }>('/api/v1/platform/idp')).breakerOpen,
        { timeout: 30_000 },
      )
      .toBe(true);
    const { page, context } = await adminPage(browser);
    await page.goto('/admin/platform/settings');
    await expect(page.getByText('SCIM breaker tripped')).toBeVisible();
    await page.getByRole('button', { name: 'Clear breaker' }).click();
    await page.getByRole('alertdialog').getByRole('button', { name: 'Clear' }).click();
    await expect(page.getByText('SCIM breaker tripped')).toHaveCount(0, { timeout: 60_000 });
    await context.close();
  });
});

test.describe('freeze', () => {
  test('Pause changes stops writes and disables Check now', async ({ browser }) => {
    const { page, context } = await adminPage(browser);
    await page.goto('/admin/platform/settings');
    await page.getByRole('button', { name: 'Pause changes' }).click();
    const dialog = page.getByRole('dialog');
    await dialog.getByLabel(/^Reason/).fill('End-to-end freeze');
    await dialog.getByRole('button', { name: 'Pause changes' }).click();
    await expect(page.getByRole('button', { name: 'Check now' })).toBeDisabled();
    await expect(page.getByRole('button', { name: 'Pause changes' })).toHaveCount(0);
    await context.close();
    const status = await admin.get<{ frozen: boolean }>('/api/v1/platform/idp');
    expect(status.frozen).toBe(true);
  });
});
