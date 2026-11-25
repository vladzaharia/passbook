import { mkdirSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, type Page, test } from '@playwright/test';
import { zipSync, zlibSync } from 'fflate';
import { apiAs, BASE, createPass, uid } from './helpers/api.ts';
import { MAC_SAFARI } from './helpers/devices.ts';
import { publishTemplateVersion } from './helpers/releases.ts';
import { readSeed } from './helpers/seed.ts';

/** A transparent 360x96 logo: a ring and two bars in the brand red, enough to see where it sits. */
function logoPng(): Buffer {
  const [w, h] = [360, 96];
  const raw = Buffer.alloc(h * (1 + w * 4));
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const dx = x - 48;
      const dy = y - 48;
      const d = Math.hypot(dx, dy);
      const ring = d < 44 && d > 26;
      const bar =
        (x > 112 && x < 300 && y > 28 && y < 46) || (x > 112 && x < 232 && y > 58 && y < 70);
      if (!ring && !bar) continue;
      const at = y * (1 + w * 4) + 1 + x * 4;
      raw.set([180, 35, 44, 255], at);
    }
  }
  const crcTable = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc = (b: Buffer) => {
    let c = 0xffffffff;
    for (const x of b) c = (crcTable[(c ^ x) & 0xff] as number) ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type: string, data: Buffer) => {
    const body = Buffer.concat([Buffer.from(type), data]);
    const out = Buffer.alloc(8 + data.length + 4);
    out.writeUInt32BE(data.length, 0);
    body.copy(out, 4);
    out.writeUInt32BE(crc(body), 8 + data.length);
    return out;
  };
  const head = Buffer.alloc(13);
  head.writeUInt32BE(w, 0);
  head.writeUInt32BE(h, 4);
  head.set([8, 6, 0, 0, 0], 8);
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', head),
    chunk('IDAT', Buffer.from(zlibSync(raw))),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

const WIDTHS = [1440, 820, 390] as const;
const SHOTS = process.env.MT7_SHOTS;

/** Screenshots at three widths in both themes when MT7_SHOTS names a folder. */
async function shoot(page: Page, name: string) {
  if (!SHOTS) return;
  mkdirSync(SHOTS, { recursive: true });
  for (const theme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme: theme });
    for (const width of WIDTHS) {
      await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
      await page.waitForTimeout(250);
      await page.screenshot({ path: `${SHOTS}/${name}-${width}-${theme}.png`, fullPage: true });
    }
  }
}

type Api = Awaited<ReturnType<typeof apiAs>>;
interface PlanItems {
  preset: string;
  revision: number;
  items: { key: string; value: unknown; source: string; note: string | null }[];
}

/** Sets the org's `brand.mark` plan value (`null` removes it), keeping its other overrides. */
async function markPlan(admin: Api, orgId: string, value: 'none' | 'quiet' | null) {
  const path = `/api/v1/platform/orgs/${orgId}/entitlements`;
  const plan = await admin.get<PlanItems>(path);
  const overrides: Record<string, { value: unknown; note?: string }> = {};
  for (const i of plan.items)
    if (i.source === 'override' && i.key !== 'brand.mark')
      overrides[i.key] = { value: i.value, ...(i.note ? { note: i.note } : {}) };
  if (value) overrides['brand.mark'] = { value };
  await admin.send('PUT', path, {
    expectedRevision: plan.revision,
    preset: plan.preset,
    overrides,
  });
}

test('the org brand leads holder pages, and the mark follows its level', async ({ browser }) => {
  const admin = await apiAs('admin');
  const orgId = readSeed().org.id;
  const q = `?orgId=${encodeURIComponent(orgId)}`;

  // The seed plan shows PassBook in full only; this plan may show it small.
  await markPlan(admin, orgId, 'quiet');
  await admin.send('PUT', `/api/v1/brand/web-logo${q}`, { png: logoPng().toString('base64') });
  await admin.send('PATCH', `/api/v1/brand${q}`, { accent: '#b4232c', mark: 'full' });
  const kit = await admin.get(`/api/v1/brand${q}`);
  expect(kit.webLogo.url).toMatch(new RegExp(`^/brand/${orgId}/[0-9a-f]{64}\\.png$`));
  expect(kit.markAllowed).toEqual(['small', 'full']);

  const pass = await createPass(admin, orgId, { holder: `Brand ${uid('B')}` });
  const detail = await admin.get(`/api/v1/passes/${pass.id}`);
  const publicPath = new URL(detail.publicUrl, BASE).pathname;
  const bundle = await admin.send('POST', '/api/v1/bundles', {
    orgId,
    passIds: [pass.id],
    name: `Brand ${uid('T')}`,
  });

  const anon = await browser.newContext({ userAgent: MAC_SAFARI });
  const page = await anon.newPage();
  await page.goto(publicPath);
  const logo = page.locator('header img.org-logo');
  await expect(logo).toBeVisible();
  await expect(logo).toHaveAttribute('src', kit.webLogo.url);
  expect(await logo.evaluate((img: HTMLImageElement) => img.naturalWidth)).toBeGreaterThan(0);
  await expect(page.getByText('Issued with')).toBeVisible();
  await shoot(page, 'pass-full');

  // The logo is a public, content-addressed image; nothing else lives under /brand.
  const asset = await anon.request.get(kit.webLogo.url);
  expect(asset.headers()['content-type']).toBe('image/png');
  expect(asset.headers()['content-security-policy']).toBe("default-src 'none'");
  expect((await anon.request.get(`/brand/${orgId}/${'0'.repeat(64)}.png`)).status()).toBe(404);

  await page.goto(new URL(bundle.url, BASE).pathname);
  await expect(page.locator('header img.org-logo')).toBeVisible();
  await shoot(page, 'bundle-full');

  await admin.send('PATCH', `/api/v1/brand${q}`, { mark: 'small' });
  await page.goto(publicPath);
  await expect(page.getByText('Powered by PassBook')).toBeVisible();
  await expect(page.getByText('Issued with')).toHaveCount(0);
  await shoot(page, 'pass-small');

  // `none` is not in this plan.
  await expect(admin.send('PATCH', `/api/v1/brand${q}`, { mark: 'none' })).rejects.toThrow('403');

  const preview = await admin.ctx.get(`/api/v1/orgs/${orgId}/email-preview`);
  expect(await preview.text()).toContain(kit.webLogo.url);

  await admin.send('PATCH', `/api/v1/brand${q}`, { mark: 'full' });
  await page.goto(`${publicPath}/barcode`);
  await expect(page.locator('header img.org-logo, .brand img.org-logo')).toBeVisible();
  await shoot(page, 'present-full');

  const adminCtx = await browser.newContext({ storageState: 'e2e/.auth/admin.json' });
  const staff = await adminCtx.newPage();
  await staff.goto(`/api/v1/passes/${pass.id}/print`);
  await expect(staff.locator('.brand img.org-logo')).toBeVisible();
  await shoot(staff, 'print-full');
  await staff.goto(`/api/v1/orgs/${orgId}/email-preview`);
  await expect(staff.locator('img[src*="/brand/"]')).toBeVisible();
  await shoot(staff, 'email-full');
  await adminCtx.close();

  await anon.close();
  await markPlan(admin, orgId, null);
  await admin.dispose();
});

test('admin sets the brand from Brand and channels', async ({ browser }) => {
  const orgId = readSeed().org.id;
  const admin = await apiAs('admin');
  const q = `?orgId=${encodeURIComponent(orgId)}`;
  await markPlan(admin, orgId, 'quiet');
  await admin.send('PUT', `/api/v1/brand/web-logo${q}`, { png: logoPng().toString('base64') });
  await admin.send('PATCH', `/api/v1/brand${q}`, { accent: '#b4232c', mark: 'full' });
  await admin.dispose();
  const ctx = await browser.newContext({ storageState: 'e2e/.auth/admin.json' });
  const page = await ctx.newPage();
  await page.goto(`/admin/o/${orgId}/brand`);
  await expect(page.getByRole('heading', { name: 'Brand and channels', level: 1 })).toBeVisible();
  const brand = page.getByRole('region', { name: 'Brand', exact: true });
  await expect(brand.getByRole('radio', { name: 'No PassBook footer' })).toHaveCount(0);
  await brand.getByRole('radio', { name: 'Powered by PassBook' }).check();
  await page.getByRole('button', { name: 'Review', exact: true }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog.getByText('PassBook footer')).toBeVisible();
  await dialog.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(dialog).toBeHidden();
  // The bar's "Saved" and the toast are both brief; the saved level is the durable proof.
  await expect(brand.getByRole('radio', { name: 'Powered by PassBook' })).toBeChecked();
  await expect(page.getByRole('region', { name: 'Unsaved changes' })).toBeHidden();
  await shoot(page, 'admin-brand');
  await ctx.close();
  const reset = await apiAs('admin');
  await markPlan(reset, orgId, null);
  await reset.dispose();
});

/** starter-generic as an upload that can take public sign-ups (as 31-join-submit). */
function joinableZip(name: string): Buffer {
  const dir = 'templates/starter-generic';
  const files: Record<string, Uint8Array> = {};
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isFile()) continue;
    let bytes: Uint8Array = readFileSync(join(dir, entry.name));
    if (entry.name === 'wallet.template.json') {
      const manifest = JSON.parse(Buffer.from(bytes).toString('utf8'));
      manifest.name = name;
      manifest.blueprint = undefined;
      // The zip copies top-level files only, so the art the wallets block names is not in it.
      manifest.wallets = undefined;
      manifest.inputs.properties.website.pattern = undefined;
      manifest.inputs.dependentRequired = undefined;
      manifest.bindings = manifest.bindings.filter(
        (b: { to: { pointer?: string } }) => !b.to.pointer?.startsWith('/semantics'),
      );
      manifest.scan.lookup = undefined;
      for (const b of manifest.bindings)
        if (b.to.barcode === '*' && b.to.prop === 'altText') b.value = 'Member code';
      bytes = Buffer.from(JSON.stringify(manifest, null, 2));
    }
    files[entry.name] = bytes;
  }
  return Buffer.from(zipSync(files));
}

test('the join page carries the org brand', async ({ browser }) => {
  const admin = await apiAs('admin');
  const orgId = readSeed().org.id;
  const name = `Join ${uid('J')}`;
  const brandQuery = `?orgId=${encodeURIComponent(orgId)}`;
  await admin.send('PUT', `/api/v1/brand/web-logo${brandQuery}`, {
    png: logoPng().toString('base64'),
  });
  await admin.send('PATCH', `/api/v1/brand${brandQuery}`, { accent: '#b4232c', mark: 'full' });
  await admin.send(
    'POST',
    `/api/v1/templates/uploads?orgId=${encodeURIComponent(orgId)}&name=${encodeURIComponent(name)}`,
    joinableZip(name),
    { 'content-type': 'application/zip' },
  );
  let template: { id: string; versions: { version: string }[] } | undefined;
  await expect
    .poll(
      async () => {
        const list = await admin.get<{ items: { id: string; name: string }[] }>(
          `/api/v1/templates?orgId=${encodeURIComponent(orgId)}&limit=100`,
        );
        const found = list.items.find((t) => t.name === name);
        if (!found) return false;
        template = await admin.get(`/api/v1/templates/${found.id}`);
        return (template?.versions.length ?? 0) > 0;
      },
      { timeout: 60_000 },
    )
    .toBe(true);
  if (!template) throw new Error('The upload did not import.');
  await publishTemplateVersion(admin, orgId, template.id, template.versions[0]?.version ?? '');
  const q = `/api/v1/join-links/${template.id}?orgId=${encodeURIComponent(orgId)}`;
  const state = await admin.get(q);
  const put = await admin.send('PUT', q, {
    enabled: true,
    askEmail: true,
    revision: state.link?.revision ?? 0,
  });
  const visitor = await browser.newContext();
  const page = await visitor.newPage();
  await page.goto(new URL(put.link.url, BASE).pathname);
  await expect(page.locator('header img.org-logo')).toBeVisible();
  await expect(page.getByText('Issued with')).toBeVisible();
  await shoot(page, 'join-full');
  await visitor.close();
  await admin.dispose();
});
