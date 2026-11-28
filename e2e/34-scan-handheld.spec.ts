import { expect, type Locator, type Page, test } from '@playwright/test';
import { apiAs, createPass, uid } from './helpers/api.ts';
import { cloneMemberBarcode } from './helpers/member-barcode.ts';
import { pairScanner } from './helpers/pair.ts';
import { publishTemplateVersion } from './helpers/releases.ts';
import { readSeed } from './helpers/seed.ts';

const PHONE = { width: 390, height: 844 };

async function door(
  api: Awaited<ReturnType<typeof apiAs>>,
  settings: Record<string, unknown>,
  names: string[],
) {
  const orgId = readSeed().org.id;
  const template = await cloneMemberBarcode(api, orgId, uid('Handheld template'));
  const release = await publishTemplateVersion(
    api,
    orgId,
    template.id,
    template.versions[0].version,
  );
  const passes: { holder: string; memberId: string; id: string }[] = [];
  for (const holder of names) {
    const memberId = uid('HH').toUpperCase();
    const pass = await createPass(api, orgId, {
      memberId,
      holder,
      templateId: template.id,
      release,
    });
    passes.push({ holder, memberId, id: pass.id });
  }
  const created = await api.send('POST', '/api/v1/scanners', {
    orgId,
    name: uid('Phone door'),
    kind: 'device',
    accepts: { templateIds: [template.id] },
    timeZone: 'UTC',
    settings: { reader: 'barcode', lookup: true, ...settings },
  });
  return { orgId, passes, created };
}

async function open(page: Page, code: string) {
  await page.addInitScript(() => {
    Object.assign(window, {
      PassBookNative: {
        sent: [] as Record<string, unknown>[],
        onmessage: null,
        postMessage(message: string) {
          (this as unknown as { sent: unknown[] }).sent.push(JSON.parse(message));
        },
      },
    });
  });
  await pairScanner(page, code);
  await page.getByTestId('scan-start').click();
}

const read = (page: Page, id: string, value: string) =>
  page.evaluate(
    ({ id, value }) =>
      (
        window as unknown as { PassBookNative: { onmessage: (e: { data: string }) => void } }
      ).PassBookNative.onmessage({
        data: JSON.stringify({ version: 1, event: 'scan', source: 'barcode', id, value }),
      }),
    { id, value },
  );

/** A tap target on the phone is at least 56 px tall. */
const tall = async (locator: Locator) => {
  const box = await locator.boundingBox();
  expect(box?.height ?? 0).toBeGreaterThanOrEqual(56);
};

test('a bundle checks in from the phone dock, and one Undo takes the group back', async ({
  browser,
}) => {
  const api = await apiAs('admin');
  const { orgId, passes, created } = await door(api, {}, ['Anna Park', 'Ben Park', 'Cara Park']);
  await api.send('POST', '/api/v1/bundles', {
    orgId,
    name: uid('Parks'),
    passIds: passes.map((p) => p.id),
  });
  const context = await browser.newContext({
    reducedMotion: 'reduce',
    viewport: PHONE,
    hasTouch: true,
  });
  const page = await context.newPage();
  try {
    await open(page, created.pairing.code);
    await read(page, 'lead', passes[0]?.memberId ?? '');
    const card = page.getByTestId('scan-result');
    await expect(card).toContainText('Checked in');
    await expect(card).toContainText("1 of 3 in Anna's group");
    await expect(page.getByTestId('scan-group-row').getByRole('listitem')).toHaveCount(3);
    const cta = page.getByTestId('dock-group');
    await expect(cta).toHaveText('Check in 2 more');
    await tall(cta);
    await cta.click();
    await expect(card).toContainText('Checked in 2 more');
    await expect(card).toContainText("3 of 3 in Anna's group");
    await expect(page.getByTestId('scan-count')).toContainText('Today 3');
    await page.getByRole('button', { name: 'Undo', exact: true }).click();
    // The whole group goes; the first scan stays.
    await expect(page.getByTestId('scan-count')).toContainText('Today 1');
  } finally {
    await context.close();
    await api.dispose();
  }
});

test('a Both door cycles Auto, In, Out from the thumb row and says so in the state line', async ({
  browser,
}) => {
  const api = await apiAs('admin');
  const { created } = await door(api, { direction: 'both' }, ['Dana Out']);
  const context = await browser.newContext({
    reducedMotion: 'reduce',
    viewport: PHONE,
    hasTouch: true,
  });
  const page = await context.newPage();
  try {
    await open(page, created.pairing.code);
    const button = page.getByTestId('dock-direction');
    await expect(button).toHaveAccessibleName('Direction: Auto');
    await tall(button);
    await button.click();
    await expect(button).toHaveAccessibleName('Direction: In');
    // The direction button names the direction; the capsule does not repeat it.
    await expect(page.getByTestId('scan-capsule')).not.toContainText('· In');
    await button.click();
    await expect(button).toHaveAccessibleName('Direction: Out');
    await expect(button).toHaveAttribute('data-variant', 'filled');
    await expect(page.getByTestId('scan-capsule')).not.toContainText('· Out');
    await button.click();
    await expect(button).toHaveAccessibleName('Direction: Auto');
  } finally {
    await context.close();
    await api.dispose();
  }
});

test('a fixed Out door has the word and no button', async ({ browser }) => {
  const api = await apiAs('admin');
  const { created } = await door(api, { direction: 'out' }, ['Eli Out']);
  const context = await browser.newContext({
    reducedMotion: 'reduce',
    viewport: PHONE,
    hasTouch: true,
  });
  const page = await context.newPage();
  try {
    await open(page, created.pairing.code);
    await expect(page.getByTestId('scan-capsule')).toContainText('Scanning · Out');
    await expect(page.getByTestId('dock-direction')).toHaveCount(0);
  } finally {
    await context.close();
    await api.dispose();
  }
});

test('offline, a saved check-in shows the queue line and View opens the queue', async ({
  browser,
}) => {
  const api = await apiAs('admin');
  const { passes, created } = await door(api, { offline: true, whenOffline: 'decide' }, [
    'Fay Queue',
  ]);
  const context = await browser.newContext({
    reducedMotion: 'reduce',
    viewport: PHONE,
    hasTouch: true,
  });
  const page = await context.newPage();
  try {
    await open(page, created.pairing.code);
    await page.getByRole('button', { name: 'Look up', exact: true }).waitFor();
    await context.setOffline(true);
    await read(page, 'q1', passes[0]?.memberId ?? '');
    await page.getByRole('button', { name: 'Let in', exact: true }).click();
    await expect(page.getByTestId('scan-result')).toContainText('Not confirmed yet');
    const line = page.getByTestId('scan-last');
    await expect(line).toContainText('1 waiting to sync');
    await expect(line).toContainText('Offline since');
    const view = page.getByTestId('scan-queue-view');
    await tall(view);
    await view.click();
    const tray = page.getByRole('dialog', { name: 'This shift' });
    await expect(tray).toContainText('Staff let in');
    await expect(tray).toContainText('Code ending');
    await expect(tray.getByRole('button', { name: 'Sync now' })).toBeVisible();
    await tall(tray.getByRole('button', { name: 'Sync now' }));
  } finally {
    await context.close();
    await api.dispose();
  }
});
