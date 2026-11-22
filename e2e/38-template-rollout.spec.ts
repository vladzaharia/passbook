import { mkdirSync } from 'node:fs';
import { expect, test } from '@playwright/test';
import { SaveVersionResponseSchema } from '../src/shared/contracts/template-versions.ts';
import {
  TemplateDetailSchema,
  TemplateVersionDetailSchema,
} from '../src/shared/contracts/templates.ts';
import { apiAs, createPass, GENERIC_BLUEPRINT, uid } from './helpers/api.ts';
import { stateFile } from './helpers/auth.ts';
import {
  approveTemplateCandidate,
  createTemplateCandidate,
  publishTemplateCandidate,
  templateReviewer,
} from './helpers/releases.ts';
import { createOrgWithRoles } from './helpers/seed.ts';

test.setTimeout(180_000);

const SHOTS = process.env.ROLLOUT_SHOTS;

test('the Versions tab shows how far a release has reached the live passes', async ({
  browser,
}) => {
  const author = await apiAs('admin');
  const ctx = await browser.newContext({ storageState: stateFile('admin') });
  try {
    const slug = uid('rollout-e2e').toLowerCase();
    const org = await createOrgWithRoles(author, { slug, name: `Rollout ${slug}` });
    const reviewer = await templateReviewer(author, org.id);
    const clone = TemplateDetailSchema.parse(
      await author.send(
        'POST',
        `/api/v1/templates/${encodeURIComponent(GENERIC_BLUEPRINT)}/clone`,
        { orgId: org.id, name: uid('Rollout card') },
      ),
    );
    const first = clone.versions[0]?.version;
    if (!first) throw new Error('The clone has no version');
    const path = `/api/v1/templates/${encodeURIComponent(clone.id)}`;

    const release = async (version: string, generation: number) => {
      const candidate = await createTemplateCandidate(author, org.id, clone.id, version, 'live');
      const approval = await approveTemplateCandidate(reviewer, candidate);
      return publishTemplateCandidate(author, candidate, approval, generation);
    };
    const v1 = await release(first, 0);
    for (let i = 0; i < 3; i++)
      await createPass(author, org.id, { templateId: clone.id, release: v1, mode: 'live' });

    const rollout = () =>
      author.send<{
        releaseVersion: string | null;
        total: number;
        onRelease: number;
        remaining: number;
      }>('GET', `${path}/rollout?orgId=${encodeURIComponent(org.id)}&mode=live`, undefined, {
        'x-passbook-mode': 'live',
      });
    expect(await rollout()).toMatchObject({
      releaseVersion: first,
      total: 3,
      onRelease: 3,
      remaining: 0,
    });

    const detail = TemplateVersionDetailSchema.parse(
      await author.get(`${path}/versions/${encodeURIComponent(first)}`),
    );
    const saved = SaveVersionResponseSchema.parse(
      await author.send('POST', `${path}/versions`, {
        manifest: detail.manifest,
        passJson: { ...detail.passJson, description: 'Second release' },
        assets: detail.assets.map(({ name, sha1 }) => ({ name, sha1 })),
      }),
    );
    const second = saved.version;
    if (!second) throw new Error('The second version was not saved');
    await release(second, v1.generation);
    expect(await rollout()).toMatchObject({
      releaseVersion: second,
      total: 3,
      onRelease: 0,
      remaining: 3,
    });

    const page = await ctx.newPage();
    await page.goto(
      `/admin/templates/${encodeURIComponent(clone.id)}?orgId=${encodeURIComponent(org.id)}&tab=versions`,
    );
    await expect(page.getByRole('heading', { name: 'Updating passes to v2' })).toBeVisible();
    await expect(page.getByRole('progressbar', { name: 'Passes on the release' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Tell holders' })).toBeVisible();
    await expect(page.getByText('Updating 3')).toBeVisible();

    if (SHOTS) {
      mkdirSync(SHOTS, { recursive: true });
      for (const colorScheme of ['light', 'dark'] as const) {
        await page.emulateMedia({ colorScheme });
        for (const width of [1440, 820, 390]) {
          await page.setViewportSize({ width, height: 900 });
          await page.goto(
            `/admin/templates/${encodeURIComponent(clone.id)}?orgId=${encodeURIComponent(org.id)}&tab=versions`,
          );
          await expect(
            page.getByRole('progressbar', { name: 'Passes on the release' }),
          ).toBeVisible();
          await page.screenshot({
            path: `${SHOTS}/rollout-${width}-${colorScheme}.png`,
            fullPage: true,
          });
        }
      }
      await page.setViewportSize({ width: 1440, height: 900 });
      await page.getByRole('button', { name: 'Tell holders' }).click();
      await page.screenshot({ path: `${SHOTS}/rollout-dialog-1440-dark.png` });
    }

    const confirm = page.getByRole('button', { name: /^Tell 3 holders$/ });
    if (!(await confirm.isVisible()))
      await page.getByRole('button', { name: 'Tell holders' }).click();
    await confirm.click();
    await expect(page.getByText('Holders will be told as their passes update')).toBeVisible();
    await reviewer.dispose();
  } finally {
    await ctx.close();
    await author.dispose();
  }
});
