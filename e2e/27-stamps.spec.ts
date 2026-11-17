import { createHash } from 'node:crypto';
import { expect, test } from '@playwright/test';
import { bakedTemplates } from '../src/generated/baked-templates.ts';
import { apiAs, requireActiveTemplateRelease, uid } from './helpers/api.ts';
import { readSeed } from './helpers/seed.ts';

test.use({ storageState: 'e2e/.auth/admin.json' });

const STAMP_CARD = 'baked:starter-stamp-card';
const generated = bakedTemplates.find((t) => t.id === STAMP_CARD);
const stripSha1 = (count: number) =>
  generated?.assets.find((a) => a.name === `stamps/strips/${count}/strip@2x.png`)?.sha1;

test('a Stamp card counts stamps, alerts once and serves the strip for its count', async ({
  page,
}) => {
  const seed = readSeed();
  const api = await apiAs('admin');
  try {
    const release = await requireActiveTemplateRelease(api, seed.org.id, STAMP_CARD, 'live');
    const pass = await api.send(
      'POST',
      '/api/v1/passes',
      {
        orgId: seed.org.id,
        templateId: STAMP_CARD,
        templateVersion: release.version,
        releaseId: release.id,
        releaseGeneration: release.generation,
        mode: 'live',
        input: { holder: 'Alex Morgan', cardNumber: uid('C'), reward: 'Free coffee', stamps: 9 },
      },
      { 'Idempotency-Key': uid('idem'), 'x-passbook-mode': 'live' },
    );
    expect(pass.stamps).toMatchObject({ goal: 10, count: 9, ready: false });
    const header = (detail: { passJson: { storeCard: { headerFields: object[] } } }) =>
      detail.passJson.storeCard.headerFields[0];
    expect(header(pass)).toMatchObject({ value: '9 of 10' });

    const ready = await api.send('POST', `/api/v1/passes/${pass.id}/stamps`, { action: 'add' });
    expect(ready.stamps).toMatchObject({ count: 10, ready: true });
    expect(header(ready)).toMatchObject({ value: 'Reward ready', changeMessage: '%@' });

    const strip = await api.ctx.get(`${ready.publicUrl}/assets/strip@2x.png`);
    expect(strip.status()).toBe(200);
    const sha1 = createHash('sha1')
      .update(await strip.body())
      .digest('hex');
    expect(sha1).toBe(stripSha1(10));

    await page.goto(`/admin/passes/${pass.id}?orgId=${encodeURIComponent(seed.org.id)}`);
    await expect(page.getByText('10 of 10')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Redeem reward' })).toBeEnabled();
    await page.getByRole('button', { name: 'Redeem reward' }).click();
    await expect(page.getByText('0 of 10')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Redeem reward' })).toBeDisabled();
  } finally {
    await api.dispose();
  }
});
