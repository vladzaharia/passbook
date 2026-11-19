import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import { zipSync } from 'fflate';
import { apiAs, BASE, uid } from './helpers/api.ts';
import { signInHolder } from './helpers/holder.ts';
import { publishTemplateVersion } from './helpers/releases.ts';
import { readSeed } from './helpers/seed.ts';
import { stubTurnstile } from './helpers/turnstile.ts';

/** starter-generic as an upload that can take public sign-ups: the barcode carries only the scan code. */
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
      manifest.inputs.properties.website.pattern = undefined;
      manifest.inputs.dependentRequired = undefined;
      manifest.bindings = manifest.bindings.filter(
        (b: { to: { pointer?: string } }) => !b.to.pointer?.startsWith('/semantics'),
      );
      for (const b of manifest.bindings)
        if (b.to.barcode === '*' && b.to.prop === 'altText') b.value = 'Member code';
      bytes = Buffer.from(JSON.stringify(manifest, null, 2));
    }
    files[entry.name] = bytes;
  }
  return Buffer.from(zipSync(files));
}

test('a join form submits in Chromium, and the card is in My passes after sign-in', async ({
  browser,
}) => {
  const admin = await apiAs('admin');
  const orgId = readSeed().org.id;
  const name = `Join ${uid('J')}`;
  const email = `${uid('joiner')}@example.test`;
  try {
    await admin.send(
      'POST',
      `/api/v1/templates/uploads?orgId=${encodeURIComponent(orgId)}&name=${encodeURIComponent(name)}`,
      joinableZip(name),
      {
        'content-type': 'application/zip',
      },
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
    const joinPath = new URL(put.link.url, BASE).pathname;

    const visitor = await browser.newContext();
    const page = await visitor.newPage();
    await stubTurnstile(page);
    const response = await page.goto(joinPath);
    // The token stays out of every Referer, and the form post still names its origin.
    expect(response?.headers()['referrer-policy']).toBe('strict-origin');
    const post = page.waitForRequest((r) => r.method() === 'POST' && r.url().includes('/j/'));
    await page.getByLabel(/name/i).first().fill('Ada');
    await page.getByLabel('Email').fill(email);
    await expect(page.locator('input[name="cf-turnstile-response"]')).not.toHaveValue('');
    await page.getByRole('button', { name: 'Get my card' }).click();
    expect((await post).headers().origin).toBe(BASE);
    await page.waitForURL((u) => u.pathname.startsWith('/p/'));
    await expect(page.getByText('Ada').first()).toBeVisible();
    await visitor.close();

    // The same address, signed in, owns the card.
    const holder = await browser.newContext();
    const portal = await holder.newPage();
    await signInHolder(portal, email);
    await expect(portal.getByRole('link', { name: 'Ada', exact: true })).toBeVisible({
      timeout: 15_000,
    });
    await holder.close();
  } finally {
    await admin.dispose();
  }
});
