import AxeBuilder from '@axe-core/playwright';
import { type BrowserContext, expect, type Page, test } from '@playwright/test';
import { type Api, apiAs, uid } from './helpers/api.ts';
import { pairScanner } from './helpers/pair.ts';
import { publishTemplateVersion } from './helpers/releases.ts';
import { readSeed } from './helpers/seed.ts';

const STORE_CARD = 'baked:starter-store-card';
test.setTimeout(150_000);

/** A store card with $42.50, a desk phone, a screen following it and a screen following another phone. */
async function rig(
  api: Api,
  browser: { newContext: (o: object) => Promise<BrowserContext> },
  showDraft?: boolean,
) {
  const orgId = readSeed().org.id;
  const contexts: BrowserContext[] = [];
  const template = await api.send(
    'POST',
    `/api/v1/templates/${encodeURIComponent(STORE_CARD)}/clone`,
    { orgId, name: uid('Draft card') },
  );
  // The starter's balance is a plain number; a prepaid card holds money.
  const detail = await api.get(
    `/api/v1/templates/${template.id}/versions/${template.versions[0].version}`,
  );
  const manifest = structuredClone(detail.manifest);
  Object.assign(manifest.inputs.properties.balance, {
    'x-format': 'currency',
    'x-currency': 'USD',
  });
  const saved = await api.send('POST', `/api/v1/templates/${template.id}/versions`, {
    manifest,
    passJson: detail.passJson,
    assets: detail.assets.map((a: { name: string; sha1: string }) => ({
      name: a.name,
      sha1: a.sha1,
    })),
  });
  if (!saved.saved) throw new Error(`Template not saved: ${JSON.stringify(saved.report)}`);
  const release = await publishTemplateVersion(api, orgId, template.id, saved.version as string);
  const pass = await api.send(
    'POST',
    '/api/v1/passes',
    {
      orgId,
      templateId: template.id,
      templateVersion: release.version,
      releaseId: release.id,
      releaseGeneration: release.generation,
      mode: 'live',
      input: {
        holder: 'Sam Draft',
        cardNumber: uid('DRAFT').toUpperCase(),
        balance: 42.5,
        currency: 'USD',
      },
    },
    { 'Idempotency-Key': uid('idem'), 'x-passbook-mode': 'live' },
  );
  const barcode = (
    await api.get<{ passJson: { barcodes?: { message?: string }[] } }>(
      `/api/v1/passes/${pass.id}?orgId=${orgId}`,
    )
  ).passJson.barcodes?.[0]?.message;
  if (!barcode) throw new Error(`Pass ${pass.id} has no barcode message`);
  const session = await api.send('POST', '/api/v1/scanning-sessions', {
    orgId,
    name: uid('Draft desk'),
    timeZone: 'UTC',
    accepts: { templateIds: [template.id] },
    settings: {
      flow: 'choose',
      reader: 'barcode',
      roleWithoutSignIn: 'desk',
      ...(showDraft === undefined ? {} : { customer: { showDraft } }),
    },
  });
  const devices = `/api/v1/scanning-sessions/${session.id}/devices`;
  const add = (name: string, surface: 'phone' | 'customer', overrides = {}) =>
    api.send('POST', devices, { name: uid(name), surface, overrides });
  const desk = await add('Desk', 'phone');
  const other = await add('Other desk', 'phone');
  const followed = await add('Desk screen', 'customer', { follows: [desk.id] });
  const apart = await add('Other screen', 'customer', { follows: [other.id] });
  const pair = async (code: string, width: number, height = 900, native = false) => {
    const context = await browser.newContext({
      viewport: { width, height },
      reducedMotion: 'reduce',
    });
    contexts.push(context);
    const page = await context.newPage();
    if (native)
      await page.addInitScript(() => {
        Object.assign(window, { PassBookNative: { onmessage: null, postMessage() {} } });
      });
    await pairScanner(page, code);
    return page;
  };
  const screen = await pair(followed.pairing.code, 800);
  const elsewhere = await pair(apart.pairing.code, 800);
  let n = 0;
  /** A desk phone with the native bridge, started, that reads the card and types an amount. */
  const startDesk = async (code: string) => {
    const page = await pair(code, 390, 844, true);
    await page.getByTestId('scan-start').click();
    const scan = () =>
      page.evaluate(
        ([value, id]) =>
          (
            window as unknown as { PassBookNative: { onmessage: (e: { data: string }) => void } }
          ).PassBookNative.onmessage({
            data: JSON.stringify({ version: 1, event: 'scan', source: 'barcode', id, value }),
          }),
        [barcode, `draft-scan-${++n}`],
      );
    const pick = page.getByTestId('scan-action-charge');
    return {
      page,
      /** Reads the card until the desk answers (the same code is ignored for a few seconds after an accepted scan). */
      read: () =>
        expect(async () => {
          await scan();
          await expect(pick).toBeVisible({ timeout: 1_000 });
        }).toPass({ timeout: 15_000 }),
      pick: () => pick.click(),
      type: (amount: string) => page.getByTestId('scan-money-input').fill(amount),
    };
  };
  const deskA = await startDesk(desk.pairing.code);
  const deskB = await startDesk(other.pairing.code);
  return {
    deskA,
    deskB,
    deskPage: deskA.page,
    screen,
    elsewhere,
    close: () => Promise.all(contexts.map((c) => c.close())),
  };
}

type Desk = Awaited<ReturnType<typeof rig>>['deskA'];
/** Reads the card at a desk and types an amount into the charge. */
async function charge(d: Desk, amount: string) {
  await d.read();
  await d.pick();
  await d.type(amount);
}

const status = (page: Page, value: string) =>
  expect(page.getByTestId('duo-customer-display')).toHaveAttribute('data-status', value);

const SIZES = [
  [390, 844],
  [834, 1112],
  [1440, 900],
  [667, 375],
  [568, 320],
] as const;

/** Axe in both themes always; shots at four sizes in both themes when SHOTS_DIR is set. */
async function look(
  page: Page,
  name: string,
  sizes: readonly (readonly [number, number])[] = SIZES,
) {
  const dir = process.env.SHOTS_DIR;
  for (const [width, height] of sizes)
    for (const scheme of ['light', 'dark'] as const) {
      await page.setViewportSize({ width, height });
      await page.emulateMedia({ colorScheme: scheme });
      await page.evaluate(() => Promise.all(document.getAnimations().map((a) => a.finished)));
      if (dir) await page.screenshot({ path: `${dir}/${name}-${width}x${height}-${scheme}.png` });
    }
  for (const scheme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme: scheme });
    const results = await new AxeBuilder({ page }).analyze();
    expect(results.violations, `${name} ${scheme}`).toEqual([]);
  }
}

test('a followed screen shows the amount, then the receipt; a desk cancel keeps the card and a re-pick shows again', async ({
  browser,
}) => {
  const api = await apiAs('admin');
  const r = await rig(api, browser);
  try {
    await status(r.screen, 'ready');
    await charge(r.deskA, '12.00');
    const draft = r.screen.getByTestId('customer-draft');
    await expect(draft).toContainText('To pay $12.00');
    await expect(r.screen.getByText('Balance after: $30.50')).toBeVisible();
    await expect(r.screen.getByText('Hi, Sam')).toBeVisible();
    await expect(r.deskPage.getByTestId('scan-draft-onscreen')).toBeVisible();

    // A live draft at the other desk reaches only the screen that follows it.
    await charge(r.deskB, '3.00');
    await expect(r.elsewhere.getByTestId('customer-draft')).toContainText('To pay $3.00');
    await expect(draft).toContainText('To pay $12.00');
    await expect(r.elsewhere.getByText('$12.00')).toHaveCount(0);
    await look(r.screen, 'customer-review');
    await look(r.deskPage, 'scanner-reviewing', [[390, 844]]);

    await r.deskPage.getByTestId('scan-picker-commit').click();
    const display = r.screen.getByTestId('duo-customer-display');
    await expect(display).toContainText('Paid $12.00', { timeout: 10_000 });
    await expect(display).toContainText('Balance $30.50');
    await expect(draft).toHaveCount(0);
    await r.deskPage.getByTestId('dock-primary').click();

    // Cancel closes the amount field: the amount goes, the desk card stays, and a re-pick shows again.
    await charge(r.deskA, '7.00');
    await expect(draft).toContainText('To pay $7.00');
    await r.deskPage.getByRole('button', { name: 'Cancel', exact: true }).click();
    await expect(draft).toHaveCount(0);
    await expect(r.screen.getByRole('heading', { name: 'Hi, Sam' })).toBeVisible();
    await r.deskA.pick();
    await r.deskA.type('9.00');
    await expect(draft).toContainText('To pay $9.00');
    // Leaving the read clears both.
    await r.deskPage.getByRole('button', { name: 'Cancel', exact: true }).click();
    await r.deskPage.getByTestId('dock-primary').click();
    await expect(draft).toHaveCount(0);
    await status(r.screen, 'ready');
    await expect(r.screen.getByText('Hi, Sam')).toHaveCount(0);
  } finally {
    await r.close();
    await api.dispose();
  }
});

test('showDraft off shows no amount', async ({ browser }) => {
  const api = await apiAs('admin');
  const r = await rig(api, browser, false);
  try {
    await status(r.screen, 'ready');
    const sent = r.deskPage.waitForResponse(
      (res) => res.url().endsWith('/api/v1/scan/draft') && res.request().method() === 'PUT',
    );
    await charge(r.deskA, '12.00');
    await expect(r.deskPage.getByTestId('scan-picker-change')).toContainText('$30.50');
    const body = await (await sent).json();
    expect(body.screens).toBe(0);
    await expect(r.deskPage.getByTestId('scan-draft-onscreen')).toHaveCount(0);
    await expect(r.screen.getByTestId('customer-draft')).toHaveCount(0);
    await expect(r.screen.getByText('$12.00')).toHaveCount(0);
  } finally {
    await r.close();
    await api.dispose();
  }
});
