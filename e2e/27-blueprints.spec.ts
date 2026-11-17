import { expect, test } from '@playwright/test';
import { apiAs, requireActiveTemplateRelease, uid } from './helpers/api.ts';
import { publishTemplateVersion } from './helpers/releases.ts';
import { readSeed } from './helpers/seed.ts';

test.use({ storageState: 'e2e/.auth/admin.json' });
test.setTimeout(120_000);

const BALANCE = 'baked:starter-store-card';

test('issuing from a blueprint is refused; a template made from it issues', async () => {
  const seed = readSeed();
  const api = await apiAs('admin');
  try {
    // The blueprint keeps its system release for older passes, but never issues a new one.
    const release = await requireActiveTemplateRelease(api, seed.org.id, BALANCE, 'live');
    const refused = await api.ctx.post('/api/v1/passes', {
      headers: {
        Origin: 'http://localhost:5173',
        'X-CSRF-Token': (await (await api.ctx.get('/api/v1/session')).json()).csrfToken,
        'Idempotency-Key': uid('bp'),
      },
      data: {
        orgId: seed.org.id,
        templateId: BALANCE,
        templateVersion: release.version,
        releaseId: release.id,
        releaseGeneration: release.generation,
        mode: 'live',
        input: { holder: 'Refused', cardNumber: 'CARD-1', balance: 5, currency: 'USD' },
      },
    });
    expect(refused.status()).toBe(409);
    expect(await refused.json()).toMatchObject({ code: 'TEMPLATE_IS_BLUEPRINT' });
  } finally {
    await api.dispose();
  }
});

test('Use blueprint: designer draft, Create template, release, then a pass', async ({ page }) => {
  const seed = readSeed();
  const name = `Gym balance ${uid('b')}`;
  await page.goto(`/admin/blueprints?orgId=${encodeURIComponent(seed.org.id)}`);
  await expect(page.getByRole('heading', { level: 1, name: 'Blueprints' })).toBeVisible();
  await page.getByRole('button', { name: 'Use Balance card' }).click();
  const dialog = page.getByRole('dialog', { name: 'Use blueprint' });
  await dialog.getByRole('combobox', { name: /^Organization/ }).click();
  await page.getByRole('option', { name: seed.org.name }).click();
  await dialog.getByRole('textbox', { name: /^Name/ }).fill(name);
  await dialog.getByRole('button', { name: 'Continue' }).click();

  await page.waitForURL((u) => u.pathname === '/admin/templates/new');
  await expect(page.getByRole('heading', { level: 1, name: `Design ${name}` })).toBeVisible();
  await expect(page.getByText('Not saved', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Create template' }).click();
  await page.waitForURL((u) => /^\/admin\/templates\/[0-9a-f-]+$/.test(u.pathname));
  await expect(
    page.getByText(/Template created · Version 1, from the Balance card blueprint/),
  ).toBeVisible();
  const templateId = new URL(page.url()).pathname.split('/').pop() as string;

  const api = await apiAs('admin');
  try {
    const detail = await api.get<{
      fromBlueprint: { id: string };
      versions: { version: string }[];
    }>(`/api/v1/templates/${templateId}?orgId=${encodeURIComponent(seed.org.id)}`);
    expect(detail.fromBlueprint.id).toBe(BALANCE);
    const version = detail.versions[0]?.version;
    if (!version) throw new Error('The new template has no version');
    // Release review applies as to any template: another user approves before it issues.
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
        input: { holder: 'Alex Morgan', cardNumber: uid('CARD'), balance: 25, currency: 'USD' },
      },
      { 'Idempotency-Key': uid('bp-pass') },
    );
    expect(pass).toMatchObject({ templateId, orgId: seed.org.id, status: 'active' });
  } finally {
    await api.dispose();
  }
});
