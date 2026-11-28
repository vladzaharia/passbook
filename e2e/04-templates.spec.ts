import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import { zipSync } from 'fflate';
import { e2eOrigin } from '../tools/lib/e2e-ports.ts';
import { apiAs, uid } from './helpers/api.ts';
import { readSeed } from './helpers/seed.ts';

test.use({ storageState: 'e2e/.auth/admin.json' });

/** Walks a directory and returns files keyed by their zip path. */
function walk(dir: string, prefix = ''): Record<string, Uint8Array> {
  const files: Record<string, Uint8Array> = {};
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) Object.assign(files, walk(path, `${prefix}${entry.name}/`));
    else if (entry.isFile()) files[`${prefix}${entry.name}`] = readFileSync(path);
  }
  return files;
}

/** Zips templates/starter-generic, wallet art included, with a new display name, minus what uploads may not use. */
function variantZip(name: string): Buffer {
  const files = walk('templates/starter-generic');
  const manifest = JSON.parse(
    Buffer.from(files['wallet.template.json'] as Uint8Array).toString('utf8'),
  );
  manifest.name = name;
  // Only built-in packages are blueprints.
  manifest.blueprint = undefined;
  // Uploads are untrusted: baked-only schema keywords and /semantics bindings are rejected.
  manifest.inputs.properties.website.pattern = undefined;
  manifest.inputs.dependentRequired = undefined;
  manifest.bindings = manifest.bindings.filter(
    (b: { to: { pointer?: string } }) => !b.to.pointer?.startsWith('/semantics'),
  );
  files['wallet.template.json'] = Buffer.from(JSON.stringify(manifest, null, 2));
  return Buffer.from(zipSync(files));
}

test('uploads a template variant, sees it done in the list, then deletes it', async ({ page }) => {
  const seed = readSeed();
  const name = `E2E Variant ${uid('t')}`;
  await page.goto(`/admin/templates/upload?orgId=${encodeURIComponent(seed.org.id)}`);
  await page.getByRole('combobox', { name: 'Organization', exact: true }).click();
  await page.getByRole('option', { name: seed.org.name }).click();
  await page.getByLabel('Name', { exact: true }).fill(name);
  await page.locator('input[type=file]').setInputFiles({
    name: 'variant.zip',
    mimeType: 'application/zip',
    buffer: variantZip(name),
  });
  await page.getByRole('button', { name: 'Upload', exact: true }).click();
  // A finished import opens the new template, which says so.
  await expect(page.getByRole('heading', { level: 1, name })).toBeVisible({ timeout: 60_000 });
  await expect(page.getByText('Template imported')).toBeVisible();

  // Import creates a draft, not an issuable release. This test deletes it without issuing.
  const templateId = new URL(page.url()).pathname.split('/').pop();
  if (!templateId) throw new Error('Imported template URL has no ID');
  const api = await apiAs('admin');
  try {
    const template = await api.get<{
      orgId: string;
      activeVersion: string | null;
      versions: { version: string; active: boolean }[];
    }>(`/api/v1/templates/${encodeURIComponent(templateId)}`);
    expect(template.orgId).toBe(seed.org.id);
    expect(template.activeVersion).toBeNull();
    expect(template.versions).toEqual([
      expect.objectContaining({ version: expect.any(String), active: false }),
    ]);
    const releases = await api.get(
      `/api/v1/templates/${encodeURIComponent(templateId)}/releases?orgId=${encodeURIComponent(seed.org.id)}&mode=live&provider=apple`,
    );
    expect(releases).toMatchObject({ active: null, items: [] });
  } finally {
    await api.dispose();
  }

  await page.goto(`/admin/templates?orgId=${encodeURIComponent(seed.org.id)}`);
  await expect(page.getByRole('link', { name })).toBeVisible();

  await page.getByRole('link', { name }).click();
  await expect(page.getByText('Uploaded', { exact: true }).first()).toBeVisible();
  await page.getByRole('button', { name: 'More' }).click();
  await page.getByRole('menuitem', { name: 'Delete' }).click();
  await page.getByRole('alertdialog').getByRole('button', { name: 'Delete' }).click();
  await expect
    .poll(() => new URL(page.url()).pathname)
    .toBe(`/admin/o/${encodeURIComponent(seed.org.id)}/templates`);
  await expect(page.getByRole('link', { name })).toHaveCount(0);
});

test('a blueprint is locked, opens as a blueprint, and the API refuses to delete it', async ({
  page,
}) => {
  const seed = readSeed();
  await page.goto(
    `/admin/templates/baked:starter-generic?orgId=${encodeURIComponent(seed.org.id)}`,
  );
  await expect
    .poll(() => decodeURIComponent(new URL(page.url()).pathname))
    .toBe(`/admin/o/${seed.org.id}/blueprints/baked:starter-generic`);
  await expect(page.getByText('Blueprint', { exact: true }).first()).toBeVisible();
  await expect(page.getByRole('button', { name: 'Delete' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Use blueprint' })).toBeVisible();

  const api = await apiAs('admin');
  const res = await api.ctx.fetch('/api/v1/templates/baked%3Astarter-generic', {
    method: 'DELETE',
    headers: {
      Origin: e2eOrigin,
      'X-CSRF-Token': (await (await api.ctx.get('/api/v1/session')).json()).csrfToken,
    },
  });
  expect(res.status()).toBe(403);
  const body = await res.json();
  expect(body.code).toBe('TEMPLATE_BAKED');
  expect(body.detail).toBe('Baked templates cannot be changed. Clone it first.');
  await api.dispose();
});
