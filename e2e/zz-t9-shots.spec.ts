import { mkdirSync } from 'node:fs';
import { expect, type Page, test } from '@playwright/test';
import { apiAs, GENERIC_BLUEPRINT, uid } from './helpers/api.ts';
import { stateFile } from './helpers/auth.ts';
import { templateReviewer } from './helpers/releases.ts';
import { createOrgWithRoles } from './helpers/seed.ts';

test.setTimeout(900_000);
const OUT = '/Users/vlad/Repos/wallet/.wrangler/agent-logs/rel-t9-shots';
mkdirSync(OUT, { recursive: true });
const SIZES = [
  [1440, 900],
  [820, 1100],
  [390, 844],
] as const;

async function shoot(page: Page, name: string, ready?: () => Promise<void>) {
  for (const scheme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme: scheme, reducedMotion: 'reduce' });
    for (const [w, h] of SIZES) {
      await page.setViewportSize({ width: w, height: h });
      if (ready) await ready();
      await page.waitForTimeout(500);
      await page.screenshot({ path: `${OUT}/${name}-${w}-${scheme}.png` });
    }
  }
}

test('shots', async ({ browser }) => {
  const api = await apiAs('admin');
  const adminCtx = await browser.newContext({ storageState: stateFile('admin') });
  const reviewerCtx = await browser.newContext({ storageState: stateFile('reviewer') });
  const org = await createOrgWithRoles(api, {
    slug: uid('t9').toLowerCase(),
    name: 'Acme Fitness',
  });
  const reviewer = await templateReviewer(api, org.id);
  await reviewer.dispose();
  const clone = await api.send<{ id: string }>(
    'POST',
    `/api/v1/templates/${encodeURIComponent(GENERIC_BLUEPRINT)}/clone`,
    { orgId: org.id, name: 'Gym membership' },
  );
  const url = `/admin/templates/${clone.id}?orgId=${org.id}`;
  const author = await adminCtx.newPage();
  await author.goto(url);
  const strip = author.getByRole('region', { name: 'Release' });
  await strip.getByRole('button', { name: 'Request review' }).click();
  await author.getByRole('dialog').getByRole('button', { name: 'Request review' }).click();
  await expect(strip).toContainText('In review', { timeout: 15000 });
  await author.waitForTimeout(1200);
  await shoot(author, 'r1-author-in-review');

  const rev = await reviewerCtx.newPage();
  // The reviewer cannot read the plan (publish scope), so the diff shows a sample for the frame.
  await rev.route('**/release?dryRun=true', async (route) => {
    const res = await route.fetch().catch(() => null);
    const plan = res?.ok()
      ? await res.json()
      : {
          version: 'x',
          fromVersion: 'y',
          state: {
            live: null,
            test: null,
            draft: null,
            review: { state: 'none' },
            alone: false,
            next: null,
          },
          modes: {},
        };
    plan.modes = plan.modes?.test
      ? plan.modes
      : {
          test: {
            outcome: 'review_required',
            from: 'a',
            expectedGeneration: 1,
            candidate: { action: 'reuse', id: null },
            approval: { action: 'needed', kind: null },
            impact: { passes: { count: 12, capped: false }, devices: { count: 9, capped: false } },
          },
          live: {
            outcome: 'review_required',
            from: 'a',
            expectedGeneration: 1,
            candidate: { action: 'reuse', id: null },
            approval: { action: 'needed', kind: null },
            impact: { passes: { count: 12, capped: false }, devices: { count: 9, capped: false } },
          },
        };
    plan.diff = [
      {
        group: 'colors',
        more: 0,
        rows: [
          {
            label: 'Background',
            kind: 'changed',
            from: { type: 'color', color: '#0F766E' },
            to: { type: 'color', color: '#4338CA' },
          },
        ],
      },
      {
        group: 'front',
        more: 0,
        rows: [
          {
            label: 'Label',
            kind: 'changed',
            from: { type: 'text', text: 'Paid through' },
            to: { type: 'text', text: 'Member until' },
          },
        ],
      },
      {
        group: 'back',
        more: 0,
        rows: [
          {
            label: 'Contact',
            kind: 'added',
            from: null,
            to: { type: 'text', text: 'Front desk 555-0100' },
          },
        ],
      },
    ];
    await route.fulfill({ status: 200, json: plan });
  });
  await rev.goto(`/admin/o/${org.id}/templates`);
  await expect(rev.getByRole('region', { name: /Needs your review/ })).toBeVisible();
  await shoot(rev, 'r2-reviewer-inbox');
  await rev.goto(url);
  await expect(rev.getByRole('button', { name: /^Review v/ })).toBeVisible();
  await shoot(rev, 'r3-reviewer-page');
  await rev.getByRole('button', { name: /^Review v/ }).click();
  const dialog = rev.getByRole('dialog', { name: /^Review v/ });
  await expect(dialog.getByRole('button', { name: 'Approve', exact: true })).toBeEnabled();
  await expect(dialog).toContainText('Member until');
  await shoot(rev, 'r4-review-dialog', async () => {
    if (!(await dialog.isVisible())) await rev.getByRole('button', { name: /^Review v/ }).click();
  });
  await rev.keyboard.press('Escape');
  await rev.goto(url);
  await rev.getByRole('button', { name: /^Review v/ }).click();
  await rev.getByRole('dialog').getByRole('button', { name: 'Approve', exact: true }).click();
  await expect(rev.getByText(/^Approved v/)).toBeVisible();
  await author.reload();
  await expect(strip.getByRole('button', { name: 'Release', exact: true })).toBeVisible();
  await shoot(author, 'r5-author-approved');
});
