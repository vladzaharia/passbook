import { expect, test } from '@playwright/test';
import { TemplateVersionDetailSchema } from '../src/shared/contracts/templates.ts';
import { type Api, apiAs, BASE, GENERIC_BLUEPRINT, uid } from './helpers/api.ts';
import { stateFile } from './helpers/auth.ts';
import { registerStubDevice } from './helpers/devices.ts';
import { templateReviewer } from './helpers/releases.ts';
import { createOrgWithRoles } from './helpers/seed.ts';
import { shoot } from './helpers/shots.ts';

test.use({ storageState: 'e2e/.auth/admin.json' });
test.setTimeout(180_000);

const TEST = { 'x-passbook-mode': 'test' };

interface Detail {
  id: string;
  versions: { version: string }[];
  release: {
    live: { version: string } | null;
    test: { version: string; state: 'following' | 'ahead' } | null;
    next: string | null;
  };
}

/** A solo org with a template made from the Generic blueprint: one saved version, nothing released. */
async function soloTemplate(api: Api, prefix: string) {
  const slug = uid(prefix).toLowerCase();
  const org = await api.send('POST', '/api/v1/orgs', {
    slug,
    name: `First pass ${slug}`,
    addMe: true,
  });
  const made = await api.send('POST', `/api/v1/templates/${GENERIC_BLUEPRINT}/use`, {
    orgId: org.id,
    name: 'Gym membership',
  });
  return { org: org as { id: string; name: string }, templateId: made.id as string };
}

const detailOf = (api: Api, orgId: string, templateId: string) =>
  api.get<Detail>(`/api/v1/templates/${templateId}?orgId=${orgId}`);

test('a new org tries its blueprint on a phone, then releases it to holders', async ({ page }) => {
  const api = await apiAs('admin');
  try {
    const { org, templateId } = await soloTemplate(api, 'fp47');
    await page.goto(`/admin/o/${org.id}/templates/${templateId}`);
    await expect(page.getByRole('region', { name: 'Release' })).toContainText('Not released');

    // Try: Test only, a Test pass from the sample, and a wait for the phone.
    await page.getByRole('button', { name: 'Try on my phone' }).first().click();
    const sheet = page.getByRole('dialog', { name: 'Try on my phone' });
    await expect(sheet.getByText('Waiting for your phone').first()).toBeVisible({
      timeout: 30_000,
    });
    await shoot(page, 'journey1-try-waiting');
    const tried = await detailOf(api, org.id, templateId);
    expect(tried.release.live).toBeNull();
    expect(tried.release.test?.state).toBe('ahead');

    // The phone adds the pass: a stub device registers with the pass's own token.
    const list = await api.send<{ items: { id: string; downloadUrl: string }[] }>(
      'GET',
      `/api/v1/passes?orgId=${org.id}`,
      undefined,
      TEST,
    );
    expect(list.items).toHaveLength(1);
    const pass = list.items[0];
    const full = await api.send<{ downloadUrl: string }>(
      'GET',
      `/api/v1/passes/${pass?.id}`,
      undefined,
      TEST,
    );
    await registerStubDevice(api, full.downloadUrl);
    await expect(sheet.getByText('On your phone').first()).toBeVisible({ timeout: 30_000 });
    await shoot(page, 'journey1-on-your-phone');

    // Release from the sheet footer: both modes, one call.
    await sheet.getByRole('button', { name: /^Release/ }).click();
    const dialog = page.getByRole('dialog', { name: /^Release v/ });
    await expect(dialog.getByText('First release')).toBeVisible();
    await shoot(page, 'journey1-release-dialog');
    // The only reviewer approves their own release (SOLE-1).
    await expect(dialog.getByText('Approve it yourself?')).toBeVisible();
    await dialog.getByRole('button', { name: 'Approve and release', exact: true }).click();
    await expect(page.getByText(/^Released v/).first()).toBeVisible();

    const released = await detailOf(api, org.id, templateId);
    const version = released.versions[0]?.version;
    expect(released.release.live?.version).toBe(version);
    expect(released.release.test?.version).toBe(version);
    expect(released.release.next).toBeNull();
    const strip = page.getByRole('region', { name: 'Release' });
    await expect(strip).toContainText('Same as Live');
    // The join link reads the release too: no stale "release it first" once Live exists.
    await expect(
      page.getByText(/Release this template in Live to turn on the join link/),
    ).toHaveCount(0);
    // The header counts Live passes and names the Test pass the Try made.
    await expect(page.getByText('· 1 in Test')).toBeVisible();
    // One count for Brand and channels: the sidebar after a release reads what Overview will.
    const todo = async () =>
      ((await page.getByRole('link', { name: /Brand and channels/ }).textContent()) ?? '').replace(
        /\D/g,
        '',
      );
    const onTemplate = await todo();
    await shoot(page, 'journey1-released');
    await page.goto(`/admin/o/${org.id}`);
    await expect(page.getByRole('region', { name: 'First pass' })).toBeVisible();
    await expect.poll(todo).toBe(onTemplate);
    await expect(page.getByRole('link', { name: 'Released v1 to Live' }).first()).toBeVisible();
    await expect(page.getByRole('link', { name: 'Released v1 to Test' }).first()).toBeVisible();
    await shoot(page, 'journey1-overview');
  } finally {
    await api.dispose();
  }
});

/** Saves one more immutable version of the template; the description makes it differ. */
async function saveVersion(api: Api, templateId: string, from: string, note: string) {
  const base = TemplateVersionDetailSchema.parse(
    await api.get(`/api/v1/templates/${templateId}/versions/${from}`),
  );
  const saved = await api.send<{ version?: string }>(
    'POST',
    `/api/v1/templates/${templateId}/versions`,
    {
      manifest: base.manifest,
      passJson: { ...base.passJson, description: note },
      assets: base.assets.map(({ name, sha1 }) => ({ name, sha1 })),
    },
  );
  if (!saved.version) throw new Error('The version was not saved');
  return saved.version;
}

/** One release call with its status, headers and body, for the answers a refusal carries. */
async function release(
  api: Api,
  templateId: string,
  body: Record<string, unknown>,
  key = uid('rel'),
  query = '',
) {
  const session = (await (await api.ctx.get('/api/v1/session')).json()) as { csrfToken: string };
  const res = await api.ctx.post(`/api/v1/templates/${templateId}/release${query}`, {
    headers: { Origin: BASE, 'X-CSRF-Token': session.csrfToken, 'Idempotency-Key': key },
    data: body,
  });
  return { status: res.status(), headers: res.headers(), json: await res.json() };
}

test('a team asks for review, a reviewer approves and releases, and the author sees it live', async ({
  browser,
}) => {
  const author = await apiAs('admin');
  const reviewerCtx = await browser.newContext({ storageState: stateFile('reviewer') });
  try {
    const slug = uid('team47').toLowerCase();
    const org = await createOrgWithRoles(author, { slug, name: `Team ${slug}` });
    const reviewerApi = await templateReviewer(author, org.id, [
      'template_reviewer',
      'template_publisher',
    ]);
    await reviewerApi.dispose();
    const made = await author.send('POST', `/api/v1/templates/${GENERIC_BLUEPRINT}/use`, {
      orgId: org.id,
      name: 'Team pass',
    });
    const templateId = made.id as string;
    const version = (made.versions[0] as { version: string }).version;

    // The author cannot release alone in a team: the answer says why, and carries the plan.
    const refused = await release(author, templateId, { orgId: org.id, version });
    expect(refused.status).toBe(409);
    expect(refused.json.code).toBe('TEMPLATE_REVIEW_REQUIRED');
    expect(refused.json.plan.modes.live.approval.action).toBe('needed');

    // Request review: candidates exist, reviewers are told, nothing is released to Live.
    const requested = await author.send(
      'POST',
      `/api/v1/templates/${templateId}/review-requests`,
      { orgId: org.id, version },
      { 'Idempotency-Key': uid('req') },
    );
    expect(requested.modes.live.outcome).toBe('review_requested');
    const waiting = await detailOf(author, org.id, templateId);
    expect(waiting.release.live).toBeNull();
    expect(waiting.release.next).toBe('wait');

    // The reviewer's inbox lists it; the review page offers Approve and release.
    const page = await reviewerCtx.newPage();
    await page.goto(`/admin/o/${org.id}/templates`);
    const inbox = page.getByRole('region', { name: /Needs your review/ });
    await expect(inbox).toContainText('Team pass');
    await expect(page.getByText('Needs review', { exact: true })).toBeVisible();
    await shoot(page, 'journey2-reviewer-inbox');
    await inbox.getByRole('link', { name: /Review/ }).click();
    const review = page.getByRole('dialog', { name: `Review v1` });
    await expect(review).toBeVisible();
    await expect(review.getByRole('button', { name: 'Approve and release' })).toBeVisible();
    // A first release shows the pass, as the release dialog does, and no empty fields.
    await expect(review.getByText('First release')).toBeVisible();
    await expect(review.getByText('Back: Note')).toHaveCount(0);
    await expect(review).not.toContainText('rgb(');
    await shoot(page, 'journey2-review-dialog');
    await review.getByRole('button', { name: 'Approve and release' }).click();
    await expect(page.getByText('Released v1').first()).toBeVisible();
    await shoot(page, 'journey2-released');

    const done = await detailOf(author, org.id, templateId);
    expect(done.release.live?.version).toBe(version);
    expect(done.release.test?.version).toBe(version);
    expect(done.release.next).toBeNull();
    const inboxAfter = await author.get<{ items: unknown[] }>(
      `/api/v1/template-reviews?orgId=${org.id}`,
    );
    expect(inboxAfter.items).toHaveLength(0);
  } finally {
    await reviewerCtx.close();
    await author.dispose();
  }
});

test('a release replayed with its key answers the same and releases nothing twice', async () => {
  const api = await apiAs('admin');
  try {
    const { org, templateId } = await soloTemplate(api, 'replay47');
    const version = (await detailOf(api, org.id, templateId)).versions[0]?.version ?? '';
    const body = { orgId: org.id, version };
    const key = uid('replay');

    const first = await release(api, templateId, body, key);
    expect(first.status).toBe(200);
    expect(first.json.modes.live.outcome).toBe('released');
    expect(first.headers['idempotent-replayed']).toBeUndefined();

    const again = await release(api, templateId, body, key);
    expect(again.status).toBe(200);
    expect(again.headers['idempotent-replayed']).toBe('true');
    expect(again.json).toEqual(first.json);

    // A fresh key for the same version is a no-op: the heads are already there.
    const fresh = await release(api, templateId, body);
    expect(fresh.json.modes.live.outcome).toBe('current');
    expect(fresh.json.modes.test.outcome).toBe('current');

    // The key belongs to its body.
    const reused = await release(api, templateId, { ...body, modes: ['test'] }, key);
    expect(reused.status).toBe(422);
    expect(reused.json.code).toBe('IDEMPOTENCY_KEY_REUSED');

    // A key is required to release, and a dry run needs none.
    const session = (await (await api.ctx.get('/api/v1/session')).json()) as { csrfToken: string };
    const headers = { Origin: BASE, 'X-CSRF-Token': session.csrfToken };
    const keyless = await api.ctx.post(`/api/v1/templates/${templateId}/release`, {
      headers,
      data: body,
    });
    expect(keyless.status()).toBe(400);
    expect((await keyless.json()).code).toBe('IDEMPOTENCY_KEY_REQUIRED');
    const dry = await api.ctx.post(`/api/v1/templates/${templateId}/release?dryRun=true`, {
      headers,
      data: body,
    });
    expect(dry.status()).toBe(200);

    // Two releases happened per mode: the first. Replays and no-ops wrote no more.
    const list = await api.send<{ items: unknown[] }>(
      'GET',
      `/api/v1/templates/${templateId}/releases?orgId=${org.id}&mode=live&provider=apple`,
      undefined,
      { 'x-passbook-mode': 'live' },
    );
    expect(list.items).toHaveLength(1);
  } finally {
    await api.dispose();
  }
});

test('Test follows Live, and runs ahead when a version is tried', async ({ page }) => {
  const api = await apiAs('admin');
  try {
    const { org, templateId } = await soloTemplate(api, 'ahead47');
    const v1 = (await detailOf(api, org.id, templateId)).versions[0]?.version ?? '';
    const at = (v: string, extra: Record<string, unknown> = {}) => ({
      orgId: org.id,
      version: v,
      ...extra,
    });

    // Test follows: a release moves both heads together.
    const first = await release(api, templateId, at(v1));
    expect(first.json.modes.test.outcome).toBe('released');
    const v2 = await saveVersion(api, templateId, v1, 'Second');
    const second = await release(api, templateId, at(v2));
    expect(second.json.modes.test.outcome).toBe('released');
    expect(second.json.state.test).toMatchObject({ version: v2, state: 'following' });

    // Test ahead: a Try puts only Test on the newest version.
    const v3 = await saveVersion(api, templateId, v2, 'Third');
    const v4 = await saveVersion(api, templateId, v3, 'Fourth');
    const tried = await release(api, templateId, at(v4, { modes: ['test'] }));
    expect(tried.json.modes.live).toBeUndefined();
    expect(tried.json.state.live.version).toBe(v2);
    expect(tried.json.state.test).toMatchObject({ version: v4, state: 'ahead' });

    // Releasing an older version leaves the newer Test head where it is.
    const plan = await release(api, templateId, at(v3), uid('dry'), '?dryRun=true');
    expect(plan.json.modes.test.outcome).toBe('kept');
    const older = await release(api, templateId, at(v3));
    expect(older.json.modes.test.outcome).toBe('kept');
    expect(older.json.modes.live.outcome).toBe('released');
    expect(older.json.state.test).toMatchObject({ version: v4, state: 'ahead' });

    // The page shows both heads: Test trying v4 beside Live on v3, and v4 ready to release.
    await page.goto(`/admin/o/${org.id}/templates/${templateId}`);
    const strip = page.getByRole('region', { name: 'Release' });
    await expect(strip).toContainText('Trying');
    await expect(page.getByRole('button', { name: /^Release v/ }).first()).toBeVisible();
    await shoot(page, 'journey3-test-ahead');
    await page
      .getByRole('button', { name: /^Release v/ })
      .first()
      .click();
    const dialog = page.getByRole('dialog', { name: /^Release v/ });
    await expect(dialog.getByRole('list', { name: 'Modes' })).toContainText('already');
    await shoot(page, 'journey3-release-test-already');
    // The only reviewer approves their own release (SOLE-1).
    await expect(dialog.getByText('Approve it yourself?')).toBeVisible();
    await dialog.getByRole('button', { name: 'Approve and release', exact: true }).click();
    await expect(page.getByText(/^Released v/).first()).toBeVisible();
    const done = await detailOf(api, org.id, templateId);
    expect(done.release.live?.version).toBe(v4);
    expect(done.release.test).toMatchObject({ version: v4, state: 'following' });
  } finally {
    await api.dispose();
  }
});
