import { mkdirSync } from 'node:fs';
import { expect, type Page, test } from '@playwright/test';
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
import { gotoRollout } from './helpers/rollout.ts';
import { createOrgWithRoles } from './helpers/seed.ts';

test.setTimeout(360_000);
test.use({ actionTimeout: 30_000 });

const SHOTS = process.env.ROLLOUT_SHOTS;
const SIZES = [
  [1440, 900],
  [390, 844],
] as const;

type Rollout = {
  releaseVersion: string | null;
  total: number;
  onRelease: number;
  remaining: number;
  tell: { text: string; key: string } | null;
};

async function shoot(page: Page, url: string, name: string, ready: () => Promise<void>) {
  if (!SHOTS) return;
  mkdirSync(SHOTS, { recursive: true });
  for (const colorScheme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme });
    for (const [width, height] of SIZES) {
      await page.setViewportSize({ width, height });
      await gotoRollout(page, url);
      await ready();
      // The Versions list shows a loading skeleton first: shoot once it has painted.
      await expect(page.getByRole('list', { name: 'Versions' })).toBeVisible();
      await page.screenshot({
        path: `${SHOTS}/${name}-${width}-${colorScheme}.png`,
        fullPage: true,
      });
    }
  }
}

test('Tell holders messages the passes on the release, once, and never the ones left behind', async ({
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
        {
          orgId: org.id,
          name: uid('Rollout card'),
        },
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
    const behind = [];
    for (let i = 0; i < 3; i++)
      behind.push(
        await createPass(author, org.id, { templateId: clone.id, release: v1, mode: 'live' }),
      );

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
    const v2 = await release(second, v1.generation);
    // Two holders already have a pass on v2; three are still on v1 (the rebuild is a minute away).
    const current = [];
    for (let i = 0; i < 2; i++)
      current.push(
        await createPass(author, org.id, { templateId: clone.id, release: v2, mode: 'live' }),
      );

    const rollout = () =>
      author.send<Rollout>(
        'GET',
        `${path}/rollout?orgId=${encodeURIComponent(org.id)}&mode=live`,
        undefined,
        { 'x-passbook-mode': 'live' },
      );
    const before = await rollout();
    expect(before).toMatchObject({ releaseVersion: second, total: 5, onRelease: 2, remaining: 3 });
    expect(before.tell?.key).toMatch(/^rollout-tell:/);

    const url = `/admin/templates/${encodeURIComponent(clone.id)}?orgId=${encodeURIComponent(org.id)}&tab=versions`;
    const page = await ctx.newPage();
    await gotoRollout(page, url);
    await expect(page.getByText('Updating passes to v2: 2 of 5')).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Updating passes to v2' })).toBeVisible();
    await expect(page.getByRole('progressbar', { name: 'Passes on the release' })).toBeVisible();
    await expect(page.getByRole('listitem').filter({ hasText: /^v2 · 2$/ })).toBeVisible();
    await expect(page.getByRole('listitem').filter({ hasText: /^v1 · 3$/ })).toBeVisible();

    const card = page.getByRole('progressbar', { name: 'Passes on the release' });
    await shoot(page, url, 'rollout', () => expect(card).toBeVisible());
    await page.setViewportSize({ width: 1440, height: 900 });
    await gotoRollout(page, url);

    await page.getByRole('button', { name: 'Tell holders' }).click();
    const dialog = page.getByRole('dialog', { name: 'Tell holders' });
    await expect(dialog.getByText(/2 on v2/)).toBeVisible();
    await expect(dialog.getByText(/3 passes are still updating/)).toBeVisible();
    await expect(dialog.getByText(/\/120/)).toBeVisible();
    if (SHOTS) {
      // A resize closes the dialog: each shot opens it afresh.
      for (const colorScheme of ['light', 'dark'] as const) {
        await page.emulateMedia({ colorScheme });
        for (const [width, height] of SIZES) {
          await page.setViewportSize({ width, height });
          await gotoRollout(page, url);
          await page.getByRole('button', { name: 'Tell holders' }).click();
          await expect(dialog.getByText(/2 on v2/)).toBeVisible();
          await page.waitForTimeout(600);
          await page.screenshot({ path: `${SHOTS}/dialog-${width}-${colorScheme}.png` });
        }
      }
      await page.setViewportSize({ width: 1440, height: 900 });
      await gotoRollout(page, url);
      await page.getByRole('button', { name: 'Tell holders' }).click();
      await expect(dialog.getByText(/2 on v2/)).toBeVisible();
    }
    const text = before.tell?.text ?? '';
    expect(text).toMatch(/has a new design\.$/);
    await dialog.getByRole('button', { name: 'Tell 2 holders' }).click();
    await expect(page.getByText('Message sent')).toBeVisible();

    // The holders on v2 are told; the three left on v1 are not.
    await expect
      .poll(
        async () =>
          (
            await author.send<{ items: { state: string; counts: { updated: number } }[] }>(
              'GET',
              `/api/v1/broadcasts?orgId=${encodeURIComponent(org.id)}&kind=message`,
              undefined,
              { 'x-passbook-mode': 'live' },
            )
          ).items.find((b) => b.state === 'sent')?.counts.updated,
        { timeout: 40_000 },
      )
      .toBe(2);
    for (const pass of current) {
      const events = await author.get<{ items: unknown[] }>(
        `/api/v1/passes/${pass.id}/events?kind=message.applied`,
      );
      expect(events.items).toHaveLength(1);
      const shown = await author.get<{
        passJson: { generic: { backFields: { key: string; value: unknown }[] } };
      }>(`/api/v1/passes/${pass.id}`);
      expect(shown.passJson.generic.backFields.find((f) => f.key === 'message')?.value).toBe(text);
    }
    for (const pass of behind) {
      const events = await author.get<{ items: unknown[] }>(
        `/api/v1/passes/${pass.id}/events?kind=message.applied`,
      );
      expect(events.items).toHaveLength(0);
    }
    // One send per release: the offer is gone, and so is the button.
    await expect.poll(async () => (await rollout()).tell).toBeNull();
    await gotoRollout(page, url);
    await expect(page.getByRole('progressbar', { name: 'Passes on the release' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Tell holders' })).toHaveCount(0);
    await shoot(page, url, 'after-send', () =>
      expect(page.getByRole('progressbar', { name: 'Passes on the release' })).toBeVisible(),
    );
    await reviewer.dispose();
  } finally {
    await ctx.close();
    await author.dispose();
  }
});
