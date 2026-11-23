import { type BrowserContext, expect, type Page, test } from '@playwright/test';
import { apiAs, createPass, uid } from './helpers/api.ts';
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
      await door.getByRole('button', { name: 'Enter code', exact: true }).click();
      const field = door.getByRole('textbox', { name: 'Name, email or code', exact: true });
      await field.fill(memberId);
      await field.press('Enter');
      await expect(door.getByTestId('scan-result')).toBeVisible();
    };
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
