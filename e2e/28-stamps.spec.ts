import { createHash } from 'node:crypto';
import { expect, test } from '@playwright/test';
import { bakedTemplates } from '../src/generated/baked-templates.ts';
import { e2eOrigin } from '../tools/lib/e2e-ports.ts';
import { apiAs, requireActiveTemplateRelease, uid } from './helpers/api.ts';
import { publishTemplateVersion } from './helpers/releases.ts';
import { readSeed } from './helpers/seed.ts';

test.use({ storageState: 'e2e/.auth/admin.json' });

const STAMP_CARD = 'baked:starter-stamp-card';
const generated = bakedTemplates.find((t) => t.id === STAMP_CARD);
test.setTimeout(120_000);
const stripSha1 = (count: number) =>
  generated?.assets.find((a) => a.name === `stamps/strips/${count}/strip@2x.png`)?.sha1;

test('issuing from the Stamp card blueprint is refused', async () => {
  const seed = readSeed();
  const api = await apiAs('admin');
  try {
    const release = await requireActiveTemplateRelease(api, seed.org.id, STAMP_CARD, 'live');
    const refused = await api.ctx.post('/api/v1/passes', {
      headers: {
        Origin: e2eOrigin,
        'X-CSRF-Token': (await (await api.ctx.get('/api/v1/session')).json()).csrfToken,
        'Idempotency-Key': uid('stamp'),
      },
      data: {
        orgId: seed.org.id,
        templateId: STAMP_CARD,
        templateVersion: release.version,
        releaseId: release.id,
        releaseGeneration: release.generation,
        mode: 'live',
        input: { holder: 'Refused', cardNumber: 'C-1', reward: 'Free coffee', stamps: 0 },
      },
    });
    expect(refused.status()).toBe(409);
    expect(await refused.json()).toMatchObject({ code: 'TEMPLATE_IS_BLUEPRINT' });
  } finally {
    await api.dispose();
  }
});

test('a template made from the Stamp card counts stamps, alerts once and serves the strip for its count', async ({
  page,
}) => {
  const seed = readSeed();
  const name = `Coffee stamps ${uid('s')}`;
  await page.goto(`/admin/blueprints?orgId=${encodeURIComponent(seed.org.id)}`);
  await page.getByRole('button', { name: 'Use Stamp card' }).click();
  // Use leads to Make it yours (the org is in scope); the designer is one button away.
  await expect(page.getByRole('heading', { level: 1, name: 'Make it yours' })).toBeVisible();
  await page.getByRole('textbox', { name: /^Name/ }).fill(name);
  await page.getByRole('button', { name: 'Open designer' }).click();
  await page.waitForURL((u) => u.pathname.endsWith('/templates/new'));
  await expect(page.getByRole('region', { name: 'Issues' }).getByRole('status')).toHaveText(
    /to review|None/,
    { timeout: 30_000 },
  );
  await page.getByRole('button', { name: 'Create template' }).click();
  await page.waitForURL((u) => /^\/admin\/o\/[^/]+\/templates\/[0-9a-f-]+$/.test(u.pathname));
  const templateId = new URL(page.url()).pathname.split('/').pop() as string;

  const api = await apiAs('admin');
  try {
    const detail = await api.get<{ versions: { version: string }[] }>(
      `/api/v1/templates/${templateId}?orgId=${encodeURIComponent(seed.org.id)}`,
    );
    const version = detail.versions[0]?.version;
    if (!version) throw new Error('The new template has no version');
    const release = await publishTemplateVersion(api, seed.org.id, templateId, version);
    const pass = await api.send(
      'POST',
      '/api/v1/passes',
      {
        orgId: seed.org.id,
        templateId,
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
