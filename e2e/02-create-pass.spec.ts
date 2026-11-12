import { expect, test } from '@playwright/test';
import { apiAs, requireActiveTemplateRelease, uid } from './helpers/api.ts';
import { MAC_SAFARI } from './helpers/devices.ts';
import { readPkpass } from './helpers/pkpass.ts';
import { addOrgMember } from './helpers/seed.ts';

// A Mac, so the public page offers the badge (the download) beside its QR.
test.use({ storageState: 'e2e/.auth/admin.json', userAgent: MAC_SAFARI });

test("admin creates a Henry's pass with the wizard and downloads a valid .pkpass", async ({
  page,
  context,
}) => {
  // The baked Henry's organization is separate from the freshly created seed organization.
  const admin = await apiAs('admin');
  const templateId = 'baked:henrys-blue';
  let orgId: string;
  let release: { id: string; generation: number; version: string };
  try {
    const orgs = await admin.get<{ items: { id: string; slug: string }[] }>(
      '/api/v1/orgs?q=henrys',
    );
    const henrys = orgs.items.find((org) => org.slug === 'henrys');
    if (!henrys) throw new Error("The baked Henry's organization is missing");
    await addOrgMember(admin, henrys.id, admin, ['org_admin']);
    orgId = henrys.id;
    release = await requireActiveTemplateRelease(admin, orgId, templateId, 'live');
  } finally {
    await admin.dispose();
  }

  const memberId = uid('E2E').toUpperCase();
  const memberName = `Wizard ${memberId}`;
  const holder = `${memberId.toLowerCase()}@example.test`;

  await page.goto('/admin/passes/new');
  await page
    .getByText(/^Henry/)
    .first()
    .click();
  await expect.poll(() => new URL(page.url()).searchParams.get('orgId')).toBe(orgId);
  await page.getByRole('button', { name: 'Next' }).click();
  await page.getByText('Blue Entrance', { exact: true }).click();
  await page.getByRole('button', { name: 'Next' }).click();

  await page.getByLabel('Member name').fill(memberName);
  await page.getByLabel('Member number').fill(memberId);
  await page.getByRole('textbox', { name: 'Membership' }).fill('E2E Plan');
  // Live preview follows the form (debounced).
  const preview = page.getByRole('region', { name: /preview/i }).or(page.locator('main'));
  await expect(preview.getByText(memberName).first()).toBeVisible();
  await page.getByRole('button', { name: 'Next' }).click();

  await page.getByLabel('Holder email').fill(holder);
  await page.getByRole('button', { name: 'Next' }).click();
  const creation = page.waitForResponse(
    (response) =>
      new URL(response.url()).pathname === '/api/v1/passes' &&
      response.request().method() === 'POST',
  );
  await page.getByRole('button', { name: 'Create and send' }).click();
  const response = await creation;
  expect(response.status()).toBe(201);
  expect(response.request().postDataJSON()).toMatchObject({
    orgId,
    templateId,
    mode: 'live',
    templateVersion: release.version,
    releaseId: release.id,
    releaseGeneration: release.generation,
  });
  expect(await response.json()).toMatchObject({
    orgId,
    templateId,
    mode: 'live',
    templateVersion: release.version,
  });

  await page.waitForURL((url) => /^\/admin\/passes\/[0-9a-f-]+$/.test(url.pathname));
  expect(new URL(page.url()).searchParams.get('orgId')).toBe(orgId);
  await expect(page.getByRole('heading', { level: 1 })).toContainText(memberName);
  // Front and back faces are both rendered by PassCard.
  await expect(page.locator('main').getByText(memberName).first()).toBeVisible();
  await page.getByRole('tab', { name: 'Holder' }).click();
  await expect(page.getByText(holder).first()).toBeVisible();

  // The public page is the UI route to the download.
  const popupPromise = context.waitForEvent('page');
  await page.getByRole('link', { name: 'Open public page' }).click();
  const popup = await popupPromise;
  await popup.waitForLoadState();
  const downloadPromise = popup.waitForEvent('download');
  await popup.getByRole('link', { name: 'Add to Apple Wallet' }).click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toMatch(/\.pkpass$/);

  const { names, passJson } = await readPkpass(download);
  expect(names).toEqual(expect.arrayContaining(['pass.json', 'manifest.json', 'signature']));
  expect(passJson.passTypeIdentifier).toBe('pass.im.plrs.wallet');
  expect(JSON.stringify(passJson)).toContain(memberName);
});
