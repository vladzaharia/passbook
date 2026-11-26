import { execFileSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import AxeBuilder from '@axe-core/playwright';
import { expect, type Page, test } from '@playwright/test';
import { type Api, apiAs, uid } from './helpers/api.ts';
import { signInAs, startOidcAs } from './helpers/auth.ts';
import { createOrgWithRoles } from './helpers/seed.ts';
import { shots } from './helpers/shots.ts';

const META = 'c4'.repeat(16);
const TAGS = [
  { uid: '04e200000000b1', first: 'a1b2c3d4e5f60718293a4b5c6d7e8f90' },
  { uid: '04e200000000b2', first: '0f1e2d3c4b5a69788796a5b4c3d2e1f0' },
];
const NEW_KEYS = ['5d4c3b2a190807f6e5d4c3b2a1908f7e', '9a8b7c6d5e4f30211203f4e5d6c7b8a9'];
const CSV = `uid,key\n${TAGS.map((t, i) => `${t.uid},${NEW_KEYS[i]}`).join('\n')}\n`;

/**
 * Swaps the page's session for a copy whose sign-in time is unknown, which the step-up check always
 * treats as stale. A session's auth_time cannot be updated (a trigger forbids it), so this adds a row.
 * Local database only.
 */
async function goStale(page: Page): Promise<void> {
  const cookies = await page.context().cookies();
  const sid = cookies.find((c) => c.name === '__Host-wallet_sid');
  if (!sid) throw new Error('No session cookie to copy');
  const token = `e2e-stale-${randomBytes(16).toString('hex')}`;
  const hash = createHash('sha256').update(token).digest('hex');
  const old = createHash('sha256').update(sid.value).digest('hex');
  execFileSync(
    'npx',
    [
      'wrangler',
      'd1',
      'execute',
      'passbook-platform',
      '--local',
      '--persist-to',
      '.wrangler/e2e-state',
      '--command',
      `INSERT INTO sessions (id_hash, user_id, amr, roles, csrf_secret, created_at, last_seen_at, idle_expires_at, expires_at, ip_prefix, user_agent, auth_time)
       SELECT '${hash}', user_id, amr, roles, csrf_secret, created_at, last_seen_at, idle_expires_at, expires_at, ip_prefix, user_agent, NULL
       FROM sessions WHERE id_hash = '${old}'`,
    ],
    { stdio: 'pipe' },
  );
  await page.context().addCookies([{ ...sid, value: token }]);
}

async function axeBothThemes(page: Page) {
  for (const scheme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme: scheme });
    const results = await new AxeBuilder({ page }).analyze();
    expect(results.violations, scheme).toEqual([]);
  }
  await page.emulateMedia({ colorScheme: 'light' });
}

test('the console replaces tag keys: dry run, confirm, step-up, re-key, then the audit lists the tags', async ({
  page,
}) => {
  const admin: Api = await apiAs('admin');
  let orgId = '';
  let keysetId = '';
  try {
    const slug = uid('nfc').toLowerCase();
    orgId = (await createOrgWithRoles(admin, { slug, name: `E2E ${slug}` })).id;
    const made = await admin.send<{ id: string }>(
      'POST',
      `/api/v1/nfc/keysets?orgId=${orgId}`,
      { name: 'Supplier tags', perTag: true, metaKey: META },
      { 'Idempotency-Key': uid('keyset') },
    );
    keysetId = made.id;
    const csv = TAGS.map((t) => `${t.uid},${t.first}`).join('\n');
    const added = await admin.send<{ added: number }>(
      'POST',
      `/api/v1/nfc/keysets/${keysetId}/import`,
      { csv, dryRun: false },
    );
    expect(added.added).toBe(2);
  } finally {
    await admin.dispose();
  }

  await signInAs(page, 'admin', '/admin');
  await goStale(page);
  const keysetUrl = `/admin/scanning?orgId=${orgId}&tab=tags&tagView=keys&keyset=${keysetId}`;

  async function openReplace() {
    await page.goto(keysetUrl);
    await page.getByRole('button', { name: 'Import tags', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: /^Import tags to/ });
    await dialog.locator('input[type="file"]').setInputFiles({
      name: 'tags.csv',
      mimeType: 'text/csv',
      buffer: Buffer.from(CSV),
    });
    await dialog
      .getByRole('checkbox', { name: 'Replace keys for tags already on this keyset' })
      .click();
    const next = dialog.getByRole('button', { name: 'Next', exact: true });
    await expect(next).not.toHaveAttribute('aria-disabled', 'true');
    await next.click();
    await expect(dialog.getByText('2 of 2 rows will re-key a tag')).toBeVisible();
    return dialog;
  }

  // A stale session: the confirm goes through, the server asks for a recent sign-in.
  let dialog = await openReplace();
  await shots(page, 'nfc-replace-dialog');
  await axeBothThemes(page);
  await expect(dialog.getByText(/Taps with the old keys stop working/)).toBeVisible();
  await page.waitForTimeout(400);
  await shots(page, 'nfc-replace-confirm');
  await axeBothThemes(page);
  await dialog.getByRole('button', { name: 'Re-key 2 tags' }).click();
  const stepUp = page.getByRole('alertdialog', { name: "Confirm it's you" });
  await expect(stepUp).toBeVisible();
  await page.waitForTimeout(400);
  await shots(page, 'nfc-replace-step-up');
  await axeBothThemes(page);

  // Sign in again (prompt=login), then the same replace passes.
  await startOidcAs(page, 'admin', '/admin', 'prompt=login&max_age=0&');
  await page.waitForURL(/\/admin/);
  dialog = await openReplace();
  await dialog.getByRole('button', { name: 'Re-key 2 tags' }).click();
  await expect(page.getByText('2 tags re-keyed')).toBeVisible();

  // The audit entry lists the re-keyed tags, never a key.
  await page.goto(`/admin/platform/audit?filterOrgId=${orgId}`);
  await page
    .getByRole('button', { name: /Tag keys replaced/ })
    .first()
    .click();
  const drawer = page.getByRole('region', { name: 'Tags re-keyed' });
  await expect(drawer.getByRole('heading', { name: '2 tags re-keyed' })).toBeVisible();
  await expect(drawer.getByRole('listitem')).toHaveCount(2);
  await expect(page.locator('body')).not.toContainText(NEW_KEYS[0] as string);
  await page.waitForTimeout(400);
  await shots(page, 'nfc-replace-audit-drawer');
  await axeBothThemes(page);
});
