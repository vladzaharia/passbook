import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { type Browser, expect, test } from '@playwright/test';
import { zipSync } from 'fflate';
import { HOLDER_COPY } from '../src/shared/copy/holder.ts';
import { type Api, apiAs, BASE, uid } from './helpers/api.ts';
import { signInHolder } from './helpers/holder.ts';
import { publishTemplateVersion } from './helpers/releases.ts';
import { readSeed } from './helpers/seed.ts';
import { stubTurnstile } from './helpers/turnstile.ts';

/**
 * starter-generic as an upload that can take public sign-ups: the barcode carries only the scan code.
 * With `lookup` it keeps its desk lookup (generated for a joiner, replaced on attach); without, it drops it.
 */
function joinableZip(name: string, lookup: boolean): Buffer {
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
      if (!lookup) manifest.scan.lookup = undefined;
      for (const b of manifest.bindings)
        if (b.to.barcode === '*' && b.to.prop === 'altText') b.value = 'Member code';
      bytes = Buffer.from(JSON.stringify(manifest, null, 2));
    }
    files[entry.name] = bytes;
  }
  return Buffer.from(zipSync(files));
}

/** Uploads, publishes and opens a join link for a joinable variant; returns the public path. */
async function joinLinkPath(admin: Api, orgId: string, name: string, lookup: boolean) {
  await admin.send(
    'POST',
    `/api/v1/templates/uploads?orgId=${encodeURIComponent(orgId)}&name=${encodeURIComponent(name)}`,
    joinableZip(name, lookup),
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
  return new URL(put.link.url, BASE).pathname;
}

/** A visitor submits the join form in Chromium; the token stays out of Referer and the POST names its origin. Returns the card path. */
async function submitJoin(browser: Browser, joinPath: string, email: string) {
  const visitor = await browser.newContext();
  const page = await visitor.newPage();
  await stubTurnstile(page);
  const response = await page.goto(joinPath);
  expect(response?.headers()['referrer-policy']).toBe('strict-origin');
  const post = page.waitForRequest((r) => r.method() === 'POST' && r.url().includes('/j/'));
  await page.getByLabel(/name/i).first().fill('Ada');
  await page.getByLabel('Email').fill(email);
  await expect(page.locator('input[name="cf-turnstile-response"]')).not.toHaveValue('');
  await page.getByRole('button', { name: 'Get my card' }).click();
  expect((await post).headers().origin).toBe(BASE);
  await page.waitForURL((u) => u.pathname.startsWith('/p/'));
  await expect(page.getByText('Ada').first()).toBeVisible();
  const cardPath = new URL(page.url()).pathname;
  await visitor.close();
  return cardPath;
}

test('a join form submits in Chromium, and the card is in My passes after sign-in', async ({
  browser,
}) => {
  const admin = await apiAs('admin');
  const name = `Join ${uid('J')}`;
  const email = `${uid('joiner')}@example.test`;
  try {
    const joinPath = await joinLinkPath(admin, readSeed().org.id, name, false);
    await submitJoin(browser, joinPath, email);
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

test('a joined card on a lookup template is in My passes after sign-in, and the joiner link stops', async ({
  browser,
}) => {
  const admin = await apiAs('admin');
  const name = `Join ${uid('L')}`;
  const email = `${uid('joiner')}@example.test`;
  try {
    const joinPath = await joinLinkPath(admin, readSeed().org.id, name, true);
    const cardPath = await submitJoin(browser, joinPath, email);
    const holder = await browser.newContext();
    const portal = await holder.newPage();
    await signInHolder(portal, email);
    await expect(portal.getByRole('link', { name: 'Ada', exact: true })).toBeVisible({
      timeout: 15_000,
    });
    await expect(portal.getByRole('heading', { name: HOLDER_COPY.reissueTitle })).toHaveCount(0);
    // The link the joiner holds opens nothing: the credentials rotated with the attach.
    expect((await holder.request.get(cardPath)).status()).toBe(404);
    await holder.close();
  } finally {
    await admin.dispose();
  }
});
