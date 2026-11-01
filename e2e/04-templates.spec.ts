import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import { zipSync } from 'fflate';
import { apiAs, uid } from './helpers/api.ts';
import { readSeed } from './helpers/seed.ts';

test.use({ storageState: 'e2e/.auth/admin.json' });

/** Zips templates/starter-generic with a new display name, minus what uploads may not use. */
function variantZip(name: string): Buffer {
  const dir = 'templates/starter-generic';
  const files: Record<string, Uint8Array> = {};
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isFile()) continue;
    let bytes: Uint8Array = readFileSync(join(dir, entry.name));
    if (entry.name === 'wallet.template.json') {
      const manifest = JSON.parse(Buffer.from(bytes).toString('utf8'));
      manifest.name = name;
      // Uploads are untrusted: baked-only schema keywords and /semantics bindings are rejected.
      manifest.inputs.properties.website.pattern = undefined;
      manifest.inputs.dependentRequired = undefined;
      manifest.bindings = manifest.bindings.filter(
        (b: { to: { pointer?: string } }) => !b.to.pointer?.startsWith('/semantics'),
      );
      bytes = Buffer.from(JSON.stringify(manifest, null, 2));
    }
    files[entry.name] = bytes;
  }
  return Buffer.from(zipSync(files));
}

test('uploads a template variant, sees it done in the list, then deletes it', async ({ page }) => {
  const seed = readSeed();
  const name = `E2E Variant ${uid('t')}`;
  await page.goto('/admin/templates/upload');
  await page.getByRole('combobox', { name: 'Organization', exact: true }).click();
  await page.getByRole('option', { name: seed.org.name }).click();
  await page.getByLabel('Name', { exact: true }).fill(name);
  await page.locator('input[type=file]').setInputFiles({
    name: 'variant.zip',
    mimeType: 'application/zip',
    buffer: variantZip(name),
  });
  await page.getByRole('button', { name: 'Upload', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Import complete' })).toBeVisible({
    timeout: 60_000,
  });

  await page.goto('/admin/templates');
  await expect(page.getByRole('link', { name })).toBeVisible();

  await page.getByRole('link', { name }).click();
  await expect(page.getByText('Uploaded', { exact: true }).first()).toBeVisible();
  await page.getByRole('button', { name: 'More' }).click();
  await page.getByRole('menuitem', { name: 'Delete' }).click();
  await page.getByRole('alertdialog').getByRole('button', { name: 'Delete' }).click();
  await expect(page).toHaveURL(/\/admin\/templates$/);
  await expect(page.getByRole('link', { name })).toHaveCount(0);
});

test('baked templates are locked and the API refuses to delete them', async ({ page }) => {
  await page.goto('/admin/templates/baked:starter-generic');
  await expect(page.getByText('Baked', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Delete' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Customize' })).toBeVisible();

  const api = await apiAs('admin');
  const res = await api.ctx.fetch('/api/v1/templates/baked%3Astarter-generic', {
    method: 'DELETE',
    headers: {
      Origin: 'http://localhost:5173',
      'X-CSRF-Token': (await (await api.ctx.get('/api/v1/session')).json()).csrfToken,
    },
  });
  expect(res.status()).toBe(403);
  const body = await res.json();
  expect(body.code).toBe('TEMPLATE_BAKED');
  expect(body.detail).toBe('Baked templates cannot be changed. Clone it first.');
  await api.dispose();
});
