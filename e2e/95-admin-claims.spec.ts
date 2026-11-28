import { expect, type Page, test } from '@playwright/test';
import { axeShots } from './helpers/axe-shots.ts';

// The claims routes want a Polaris ID sign-in from the last ten minutes. The user and group pages ask only when the
// session qualifies; otherwise the card says what to do. No 403 reaches the console or the network on either page.
test.use({ storageState: 'e2e/.auth/admin.json' });

const MIN = 60_000;
const STATES = [
  { state: 'fresh', amr: 'oidc', age: 0, line: 'passbook_plan', asks: 1 },
  { state: 'stale', amr: 'oidc', age: 11 * MIN, line: 'Sign in again to see claims.', asks: 0 },
  {
    state: 'break-glass',
    amr: 'breakglass',
    age: 0,
    line: 'Not available with break-glass.',
    asks: 0,
  },
] as const;

const role = (name: string) => ({
  role: name,
  wanted: false,
  present: false,
  presence: 'none',
  held: false,
  memberships: [],
  sponsorships: [],
  grantedAt: null,
  error: null,
});
const group = {
  key: 'partners',
  kind: 'custom',
  name: 'passbook_g_partners',
  friendlyName: 'Partner apps',
  members: 0,
  claims: [],
  otherClients: 0,
  flags: [],
  rules: 0,
  manual: 0,
};
const claims = { claims: { passbook_plan: { type: 'text', value: 'gold' } }, otherKeys: 1 };
const idp = {
  connected: true,
  mode: 'live',
  frozen: false,
  keyExpiresAt: null,
  problems: [],
  budget: {},
  lastScimAt: null,
  drift: {},
  breakerOpen: false,
};

async function watch(page: Page) {
  const bad: string[] = [];
  page.on('console', (m) => {
    if (m.type() === 'error' && /403/.test(m.text())) bad.push(`console: ${m.text()}`);
  });
  page.on('response', (r) => {
    if (r.status() === 403) bad.push(`network: ${r.url()}`);
  });
  return bad;
}

async function mockSession(page: Page, amr: string, age: number) {
  await page.route('**/api/v1/session', async (route) => {
    const body = await (await route.fetch()).json();
    await route.fulfill({ json: { ...body, amr, authTime: Date.now() - age } });
  });
}

for (const s of STATES) {
  test(`user detail claims, ${s.state}`, async ({ page }) => {
    const bad = await watch(page);
    await page.goto('/admin');
    const list = await page.evaluate(async () => (await fetch('/api/v1/users?limit=5')).json());
    const id: string = list.items[0].id;
    await mockSession(page, s.amr, s.age);
    let asked = 0;
    await page.route(`**/api/v1/users/${id}/access`, (r) =>
      r.fulfill({
        json: {
          userId: id,
          connected: true,
          platformAdmin: false,
          disabled: false,
          linked: true,
          account: { class: 'created', disabledInIdp: false },
          roles: [role('console'), role('developer'), role('support')],
        },
      }),
    );
    await page.route('**/api/v1/platform/idp/groups*', (r) =>
      r.fulfill({ json: { items: [], nextCursor: null } }),
    );
    await page.route(`**/api/v1/users/${id}/claims`, (r) => {
      asked++;
      return r.fulfill({ json: claims });
    });
    await page.goto(`/admin/users/${id}`);
    await expect(page.getByRole('heading', { name: 'Claims', exact: true })).toBeVisible();
    await expect(page.getByText(s.line)).toBeVisible();
    if (s.state === 'stale') {
      await page.getByRole('button', { name: 'Sign in', exact: true }).click();
      await expect(page.getByRole('alertdialog', { name: "Confirm it's you" })).toBeVisible();
      await page.keyboard.press('Escape');
    }
    expect(asked).toBe(s.asks);
    expect(bad).toEqual([]);
    await axeShots(page, `user-claims-${s.state}`);
  });

  test(`group detail claims, ${s.state}`, async ({ page }) => {
    const bad = await watch(page);
    await mockSession(page, s.amr, s.age);
    let asked = 0;
    const key = group.key;
    const base = `**/api/v1/platform/idp`;
    await page.route(`${base}`, (r) => r.fulfill({ json: idp }));
    await page.route(`${base}/groups`, (r) =>
      r.fulfill({ json: { items: [group], nextCursor: null } }),
    );
    for (const part of ['rules', 'members'])
      await page.route(`${base}/groups/${key}/${part}`, (r) =>
        r.fulfill({ json: { items: [], nextCursor: null } }),
      );
    await page.route(`${base}/groups/${key}/claims`, (r) => {
      asked++;
      return r.fulfill({ json: claims });
    });
    await page.goto(`/admin/platform/groups/${key}`);
    await expect(page.getByRole('heading', { name: 'Claims', exact: true })).toBeVisible();
    await expect(page.getByText(s.line)).toBeVisible();
    expect(asked).toBe(s.asks);
    expect(bad).toEqual([]);
    await axeShots(page, `group-claims-${s.state}`);
  });
}
