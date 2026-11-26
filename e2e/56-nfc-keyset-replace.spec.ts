import { execFileSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { expect, type Page, test } from '@playwright/test';
import { type Api, apiAs, uid } from './helpers/api.ts';
import { signInAs, startOidcAs } from './helpers/auth.ts';
import { createOrgWithRoles } from './helpers/seed.ts';

const META = 'c3'.repeat(16);
const TAGS = [
  { uid: '04e100000000a1', first: 'a1b2c3d4e5f60718293a4b5c6d7e8f90' },
  { uid: '04e100000000a2', first: '0f1e2d3c4b5a69788796a5b4c3d2e1f0' },
];
const NEW_KEYS = ['5d4c3b2a190807f6e5d4c3b2a1908f7e', '9a8b7c6d5e4f30211203f4e5d6c7b8a9'];
const csv = (keys: string[]) => TAGS.map((t, i) => `${t.uid},${keys[i]}`).join('\n');

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

/** The page's own session, the way the console calls the API. */
async function sessionCall(page: Page, path: string, body: unknown) {
  const csrf = ((await (await page.request.get('/api/v1/session')).json()) as { csrfToken: string })
    .csrfToken;
  const res = await page.request.post(path, {
    data: body,
    headers: { 'X-CSRF-Token': csrf, Origin: new URL(page.url()).origin },
  });
  return { status: res.status(), json: (await res.json()) as Record<string, unknown> };
}

test('replacing tag keys on a keyset dry-runs, asks for a recent sign-in, then re-keys and audits', async ({
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
    const added = await admin.send<{ added: number }>(
      'POST',
      `/api/v1/nfc/keysets/${keysetId}/import`,
      { csv: csv(TAGS.map((t) => t.first)), dryRun: false },
    );
    expect(added.added).toBe(2);
  } finally {
    await admin.dispose();
  }
  const importUrl = `/api/v1/nfc/keysets/${keysetId}/import`;

  // A fresh browser session, then a copy of it whose sign-in time is unknown (always stale).
  await signInAs(page, 'admin', '/admin');
  await goStale(page);

  // A dry run writes nothing and asks for no sign-in.
  const dry = await sessionCall(page, importUrl, {
    csv: csv(NEW_KEYS),
    dryRun: true,
    replace: true,
  });
  expect(dry.status).toBe(200);
  expect(dry.json).toMatchObject({ dryRun: true, rows: 2, ok: 2, added: 0, problems: [] });

  // The real replace is refused until the person signs in again.
  const refused = await sessionCall(page, importUrl, {
    csv: csv(NEW_KEYS),
    dryRun: false,
    replace: true,
  });
  expect(refused.status).toBe(403);
  expect(refused.json).toMatchObject({ code: 'STEP_UP_REQUIRED' });
  const audit = (action: string) =>
    page.request.get(`/api/v1/audit?orgId=${orgId}&action=${action}`).then(async (r) => {
      return ((await r.json()) as { items: { detail: Record<string, unknown> }[] }).items;
    });
  expect(await audit('tag_keyset.rekeyed')).toHaveLength(0);

  // Step up through the real prompt=login flow, then the same replace passes.
  await startOidcAs(page, 'admin', '/admin', 'prompt=login&max_age=0&');
  await page.waitForURL(/\/admin/);
  const done = await sessionCall(page, importUrl, {
    csv: csv(NEW_KEYS),
    dryRun: false,
    replace: true,
  });
  expect(done.status).toBe(200);
  expect(done.json).toMatchObject({ dryRun: false, rows: 2, ok: 2, added: 2, problems: [] });

  // One audit row counts the re-keyed tags; the console read hides their ids and never carries a key.
  const rows = await audit('tag_keyset.rekeyed');
  expect(rows).toHaveLength(1);
  expect(rows[0]?.detail).toMatchObject({ count: 2 });
  expect(JSON.stringify(rows)).not.toContain(NEW_KEYS[0]);

  await page.goto(`/admin/platform/audit?filterOrgId=${orgId}`);
  await expect(page.getByRole('button', { name: /Tag keys replaced/ }).first()).toBeVisible();
});
