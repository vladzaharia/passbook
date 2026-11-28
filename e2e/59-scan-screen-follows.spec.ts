import AxeBuilder from '@axe-core/playwright';
import { type BrowserContext, expect, type Page, test } from '@playwright/test';
import { apiAs, createPass, uid } from './helpers/api.ts';
import { stateFile } from './helpers/auth.ts';
import { pairScanner } from './helpers/pair.ts';
import { readSeed } from './helpers/seed.ts';

test('a customer screen follows only the door it is bound to', async ({ browser }) => {
  const api = await apiAs('admin');
  const contexts: BrowserContext[] = [];
  try {
    const orgId = readSeed().org.id;
    const session = await api.send('POST', '/api/v1/scanning-sessions', {
      orgId,
      name: uid('Two doors'),
      timeZone: 'UTC',
    });
    const devices = `/api/v1/scanning-sessions/${session.id}/devices`;
    const add = (name: string, surface: 'phone' | 'customer', overrides = {}) =>
      api.send('POST', devices, { name: uid(name), surface, overrides });
    const north = await add('North door', 'phone');
    const south = await add('South door', 'phone');
    const northScreen = await add('North screen', 'customer', { follows: [north.id] });
    const allScreen = await add('All screen', 'customer');
    await expect(
      api.send('PATCH', `${devices}/${allScreen.id}`, { overrides: { follows: ['elsewhere'] } }),
    ).rejects.toThrow(/SCANNING_FOLLOWS_INVALID/);
    const pair = async (code: string, width: number) => {
      const context = await browser.newContext({
        viewport: { width, height: 900 },
        reducedMotion: 'reduce',
      });
      contexts.push(context);
      const page = await context.newPage();
      await pairScanner(page, code);
      return page;
    };
    const doorN = await pair(north.pairing.code, 390);
    const doorS = await pair(south.pairing.code, 390);
    const screenN = await pair(northScreen.pairing.code, 800);
    const screenA = await pair(allScreen.pairing.code, 800);
    const checkedIn = (page: Page) =>
      page.getByRole('heading', { name: 'Checked in', exact: true });
    const enter = async (door: Page, memberId: string) => {
      await door.getByRole('button', { name: 'Look up', exact: true }).click();
      const field = door.getByRole('textbox', { name: 'Name, email or code', exact: true });
      await field.fill(memberId);
      await field.press('Enter');
      await expect(door.getByTestId('scan-result')).toBeVisible();
    };
    for (const screen of [screenN, screenA])
      await expect(screen.getByTestId('duo-customer-display')).toHaveAttribute(
        'data-status',
        'ready',
      );
    for (const door of [doorN, doorS]) await door.getByTestId('scan-start').click();
    const southId = uid('SOUTH').toUpperCase();
    await createPass(api, orgId, { holder: uid('South Guest'), memberId: southId });
    await enter(doorS, southId);
    await expect(checkedIn(screenA)).toBeVisible();
    await expect(checkedIn(screenN)).toHaveCount(0);
    const northId = uid('NORTH').toUpperCase();
    await createPass(api, orgId, { holder: uid('North Guest'), memberId: northId });
    await enter(doorN, northId);
    await expect(checkedIn(screenN)).toBeVisible();
  } finally {
    await Promise.all(contexts.map((context) => context.close()));
    await api.dispose();
  }
});

test('the admin picks the scanners a customer screen follows', async ({ browser }) => {
  const api = await apiAs('admin');
  const context = await browser.newContext({
    storageState: stateFile('admin'),
    reducedMotion: 'reduce',
  });
  const page = await context.newPage();
  try {
    const orgId = readSeed().org.id;
    const session = await api.send('POST', '/api/v1/scanning-sessions', {
      orgId,
      name: uid('Follow picker'),
      timeZone: 'UTC',
    });
    const devices = `/api/v1/scanning-sessions/${session.id}/devices`;
    const north = await api.send('POST', devices, { name: uid('North door'), surface: 'phone' });
    const south = await api.send('POST', devices, { name: uid('South door'), surface: 'phone' });
    const screen = await api.send('POST', devices, {
      name: uid('Door screen'),
      surface: 'customer',
    });
    await page.goto(`/admin/o/${orgId}/scanning/sessions/${session.id}`);
    await page
      .getByTestId('session-device')
      .filter({ hasText: screen.name })
      .getByRole('button', { name: 'Configure device', exact: true })
      .click();
    const sheet = page.getByRole('dialog', { name: `Configure ${screen.name}` });
    const sheetShots = async (name: string) => {
      const dir = process.env.SHOTS_DIR;
      if (!dir) return;
      await sheet.getByRole('heading', { name: 'Scanners shown' }).scrollIntoViewIfNeeded();
      for (const [width, height] of [
        [1440, 900],
        [834, 1112],
        [390, 844],
      ] as const)
        for (const scheme of ['light', 'dark'] as const) {
          await page.setViewportSize({ width, height });
          await page.emulateMedia({ colorScheme: scheme });
          await page.waitForTimeout(250);
          await sheet.getByRole('heading', { name: 'Scanners shown' }).scrollIntoViewIfNeeded();
          await sheet.evaluate((el) => {
            for (const n of [el, ...el.querySelectorAll('*')])
              if (
                n.scrollHeight > n.clientHeight + 10 &&
                /auto|scroll/.test(getComputedStyle(n).overflowY)
              )
                n.scrollTop = n.scrollHeight;
          });
          await page.waitForTimeout(150);
          await page.screenshot({ path: `${dir}/${name}-${width}-${scheme}.png` });
        }
      await page.setViewportSize({ width: 1280, height: 720 });
      await page.emulateMedia({ colorScheme: 'light' });
    };
    const all = sheet.getByRole('switch', { name: 'All scanners in this session' });
    await expect(all).toBeChecked();
    await sheetShots('follows-all');
    await all.click();
    await sheet.getByRole('checkbox', { name: north.name, exact: true }).click();
    await sheetShots('follows-chosen');
    for (const scheme of ['light', 'dark'] as const) {
      await page.emulateMedia({ colorScheme: scheme });
      const results = await new AxeBuilder({ page }).analyze();
      expect(results.violations, scheme).toEqual([]);
    }
    const saved = page.waitForResponse(
      (r) => r.request().method() === 'PATCH' && r.url().includes(`/devices/${screen.id}`),
    );
    await sheet.getByRole('button', { name: 'Save device', exact: true }).click();
    expect((await saved).status()).toBe(200);
    const stored = await api.get(`/api/v1/scanning-sessions/${session.id}`);
    expect(
      stored.devices.find((d: { id: string }) => d.id === screen.id).overrides.follows,
    ).toEqual([south.id]);
  } finally {
    await context.close();
    await api.dispose();
  }
});
