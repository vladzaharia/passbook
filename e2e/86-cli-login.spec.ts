import AxeBuilder from '@axe-core/playwright';
import { expect, type Page, request, test } from '@playwright/test';
import { shots } from './helpers/shots.ts';
import { stubTurnstile } from './helpers/turnstile.ts';

/** `passbook login`'s approve page (design §3.7, L20): the code is typed, never carried by a URL. Needs `WALLET_E2E_PREVIEW=1`. */
const CLIENT = { name: 'passbook-cli', version: '0.2.0', os: 'macOS' };

async function signIn(page: Page) {
  await stubTurnstile(page);
  await page.route('**/auth/oidc/start*', async (route) => {
    const response = await route.fetch({ maxRedirects: 0 });
    const target = response.headers().location;
    if (!target) return route.fulfill({ response });
    const location = new URL(target);
    location.searchParams.set('login_hint', 'e2e-builder');
    return route.fulfill({
      response,
      headers: { ...response.headers(), location: location.toString() },
    });
  });
  await page.goto('/workbench/quickstart');
  await page.locator('main').getByRole('link', { name: 'Sign in with Polaris ID' }).click();
  await page.waitForURL((u) => u.pathname === '/workbench/quickstart');
  await page.setViewportSize({ width: 1440, height: 900 });
  const create = page.getByRole('button', { name: 'Create sandbox' });
  await create.or(page.getByRole('radio', { name: 'Run here' })).waitFor();
  if (await create.isVisible({ timeout: 3000 }).catch(() => false)) {
    await create.click();
    await expect(page.locator('.qs-env-v')).toContainText(/PASSBOOK_KEY=pbp_test_/);
  }
}

/** A CLI's own start: no cookie, and (when `ip` is given) the network it says it came from. */
async function start(page: Page, ip?: string) {
  const res = await page.request.post('/api/v1/cli/sessions', {
    data: { client: CLIENT },
    ...(ip ? { headers: { 'cf-connecting-ip': ip } } : {}),
  });
  expect(res.status(), await res.text()).toBe(201);
  return (await res.json()) as { deviceCode: string; userCode: string; verificationUri: string };
}

async function serious(page: Page) {
  const { violations } = await new AxeBuilder({ page }).analyze();
  return violations.filter((v) => v.impact === 'serious' || v.impact === 'critical');
}

test('L20: a code in the URL fills nothing, and the person types it, approves after 3 seconds and gets one token', async ({
  page,
}) => {
  test.setTimeout(150_000);
  await signIn(page);
  const urls: string[] = [];
  page.on('request', (r) => urls.push(r.url()));
  const s = await start(page);
  const bare = s.userCode.replace('-', '');

  // The link an attacker sends: the query and the hash are dropped, and the field stays empty.
  await page.goto(`/workbench/cli?code=${bare}#code=${bare}`);
  await page.waitForURL((u) => u.pathname === '/workbench/cli' && !u.search && !u.hash);
  const field = page.getByLabel('Code from your terminal');
  await expect(field).toBeVisible();
  await expect(field).toHaveValue('');
  expect(page.url()).not.toContain(bare);
  await shots(page, 'cli-enter');
  expect(await serious(page)).toEqual([]);

  // Typed by hand, in lower case with a space: the lookup carries it in the body.
  await field.fill(s.userCode.replace('-', ' ').toLowerCase());
  await page.getByRole('button', { name: 'Continue' }).click();
  await expect(page.getByText('Reported by the device')).toBeVisible();
  await expect(page.getByText('passbook-cli 0.2.0 on macOS')).toBeVisible();
  await expect(page.getByText(/different network/)).toHaveCount(0);
  const approve = page.getByRole('button', { name: /^Approve/ });
  await expect(approve).toBeDisabled();
  await expect(approve).toBeEnabled({ timeout: 8_000 });
  expect(await serious(page)).toEqual([]);
  await approve.click();
  await expect(page.getByText('Approved. Return to your terminal.')).toBeVisible();
  await shots(page, 'cli-done');

  // Past the attacker's own link (the one request that has it), no request URL carried the code.
  expect(urls.filter((u) => u.includes(bare) || u.includes(s.userCode))).toEqual([
    `${new URL(page.url()).origin}/workbench/cli?code=${bare}`,
  ]);

  // The CLI's side: one token, Test only, with its own short list of routes.
  const cli = await request.newContext({ baseURL: new URL(page.url()).origin });
  const poll = await cli.post('/api/v1/cli/sessions/token', { data: { deviceCode: s.deviceCode } });
  expect(poll.status(), await poll.text()).toBe(200);
  const issued = (await poll.json()) as { token: string; tokenId: string; orgId: string };
  expect(issued.token).toMatch(/^pbcli_test_/);
  const bearer = { authorization: `Bearer ${issued.token}` };
  expect((await cli.get('/api/v1/passes', { headers: bearer })).status()).toBe(200);
  const refused = await cli.get(`/api/v1/api-keys?orgId=${issued.orgId}`, { headers: bearer });
  expect(refused.status()).toBe(403);
  expect(((await refused.json()) as { code: string }).code).toBe('CLI_TOKEN_NOT_ALLOWED');
  expect(
    (await cli.post('/api/v1/cli/sessions/token', { data: { deviceCode: s.deviceCode } })).status(),
  ).toBe(400);
  const out = await cli.delete(`/api/v1/cli/tokens/${issued.tokenId}`, { headers: bearer });
  expect(out.status()).toBe(200);
  expect((await cli.get('/api/v1/passes', { headers: bearer })).status()).toBe(401);
  await cli.dispose();
});

test('a different network warns, and Deny ends the sign-in', async ({ page }) => {
  test.setTimeout(150_000);
  await signIn(page);
  const s = await start(page, '203.0.113.9');
  await page.goto('/workbench/cli');
  await page.getByLabel('Code from your terminal').fill(s.userCode);
  await page.getByRole('button', { name: 'Continue' }).click();
  await expect(page.getByText(/This was started on a different network/)).toBeVisible();
  await expect(
    page.getByRole('link', { name: 'Not you? Sign in as someone else' }),
  ).toHaveAttribute('href', /prompt=login/);
  await shots(page, 'cli-review');
  expect(await serious(page)).toEqual([]);
  await page.getByRole('button', { name: 'Deny' }).click();
  await expect(page.getByText('Denied.')).toBeVisible();
  const cli = await request.newContext({ baseURL: new URL(page.url()).origin });
  const poll = await cli.post('/api/v1/cli/sessions/token', { data: { deviceCode: s.deviceCode } });
  expect(((await poll.json()) as { code: string }).code).toBe('CLI_CODE_DENIED');
  await cli.dispose();
});

test('a wrong code says so once and keeps the field', async ({ page }) => {
  await signIn(page);
  await page.goto('/workbench/cli');
  const field = page.getByLabel('Code from your terminal');
  await field.fill('BBBB-BBBB');
  await page.getByRole('button', { name: 'Continue' }).click();
  await expect(page.getByText(/No such code/)).toBeVisible();
  await expect(field).toHaveValue('BBBB-BBBB');
});
