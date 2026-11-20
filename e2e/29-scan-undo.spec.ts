import { expect, test } from '@playwright/test';
import { apiAs, createPass, uid } from './helpers/api.ts';
import { cloneMemberBarcode } from './helpers/member-barcode.ts';
import { pairScanner } from './helpers/pair.ts';
import { publishTemplateVersion } from './helpers/releases.ts';
import { readSeed } from './helpers/seed.ts';

test('scanner undo reverses the check-in, frees the pass, and the next scan checks in again', async ({
  browser,
}) => {
  const api = await apiAs('admin');
  const orgId = readSeed().org.id;
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 },
    reducedMotion: 'reduce',
  });
  try {
    const template = await cloneMemberBarcode(api, orgId, uid('Undo template'));
    const release = await publishTemplateVersion(
      api,
      orgId,
      template.id,
      template.versions[0].version,
    );
    const memberId = uid('UNDO').toUpperCase();
    const pass = await createPass(api, orgId, {
      templateId: template.id,
      release,
      memberId,
      holder: 'Undo Guest',
    });
    const scanner = await api.send('POST', '/api/v1/scanners', {
      orgId,
      name: uid('Undo door'),
      kind: 'device',
      accepts: { templateIds: [template.id] },
      timeZone: 'UTC',
      settings: { reader: 'barcode' },
    });
    const page = await context.newPage();
    await page.addInitScript(() => {
      Object.assign(window, { PassBookNative: { onmessage: null, postMessage() {} } });
    });
    await pairScanner(page, scanner.pairing.code);
    await page.getByTestId('scan-start').click();
    await page.getByRole('button', { name: 'Menu', exact: true }).click();
    await page.getByRole('menuitemcheckbox', { name: 'Keep results until tapped' }).click();
    await page.keyboard.press('Escape');
    const read = (id: string) =>
      page.evaluate(
        ({ id, value }) => {
          (
            window as unknown as { PassBookNative: { onmessage: (e: { data: string }) => void } }
          ).PassBookNative.onmessage({
            data: JSON.stringify({ version: 1, event: 'scan', source: 'barcode', id, value }),
          });
        },
        { id, value: memberId },
      );
    type Row = { id: string; undoneAt: number | null };
    const outcomes = async (outcome: string): Promise<Row[]> =>
      (await api.get(`/api/v1/scans?orgId=${orgId}&passId=${pass.id}&outcome=${outcome}`)).items;
    /** An undone check-in stays in the ledger (listed as ok and as undone); only unmarked ones count. */
    const standing = async () => (await outcomes('ok')).filter((row) => row.undoneAt === null);

    await read('first');
    await expect(page.getByTestId('scan-result')).toContainText('Checked in');
    await expect(page.getByTestId('scan-count')).toContainText('Today 1');
    const [first] = await standing();
    expect(first).toBeDefined();

    await page.getByRole('button', { name: 'Undo', exact: true }).click();
    await expect(page.getByTestId('scan-count')).toContainText('Today 0');
    await expect
      .poll(async () => (await outcomes('undone')).map((row) => row.id))
      .toEqual([first?.id]);
    expect(await standing()).toHaveLength(0);

    await page.getByRole('button', { name: 'Done', exact: true }).click();
    // The reader ignores the same code for 5 s after an accepted scan (timing.ts); read until it takes.
    let attempt = 0;
    await expect(async () => {
      await read(`again-${attempt++}`);
      await expect(page.getByTestId('scan-result')).toContainText('Checked in', { timeout: 1_000 });
    }).toPass({ intervals: [1_000], timeout: 15_000 });
    await expect(page.getByTestId('scan-count')).toContainText('Today 1');
    expect(await standing()).toHaveLength(1);
  } finally {
    await context.close();
    await api.dispose();
  }
});
