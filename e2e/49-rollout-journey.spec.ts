import { expect, type Page, test } from '@playwright/test';
import { SaveVersionResponseSchema } from '../src/shared/contracts/template-versions.ts';
import {
  TemplateDetailSchema,
  TemplateVersionDetailSchema,
} from '../src/shared/contracts/templates.ts';
import { apiAs, createPass, GENERIC_BLUEPRINT, uid } from './helpers/api.ts';
import { stateFile } from './helpers/auth.ts';
import { recordRolloutFailure, runMinuteCron } from './helpers/cron.ts';
import { frame, shoot, THEMES, WIDTHS } from './helpers/issuing.ts';
import {
  approveTemplateCandidate,
  createTemplateCandidate,
  publishTemplateCandidate,
  templateReviewer,
} from './helpers/releases.ts';
import { gotoRollout } from './helpers/rollout.ts';
import { createOrgWithRoles } from './helpers/seed.ts';

// The rollout card as a story (the issuing redesign, I9): a release goes out, the card shows how
// far it has got, the owner tells the holders who are on it, and the card settles once the
// minute cron has moved the rest.
// 42-template-rollout checks the server rules; this one follows the screen at 3 widths, 2 themes.
// It needs the rollout card, so it lands with origin/feat/template-rollout.
test.setTimeout(480_000);
test.use({ actionTimeout: 30_000 });

type Rollout = {
  total: number;
  onRelease: number;
  remaining: number;
  running: boolean;
  tell: { key: string } | null;
};

/** Opens `url` in each frame and shoots once `ready` holds; a resize would close a dialog. */
/** The bar's segments by key, with their share of the bar (flex-grow is the pass count). */
const segments = (page: Page) =>
  page.getByRole('progressbar', { name: 'Passes on the release' }).locator('[data-segment]');

/** The version tab is lazy: the Versions list and the pass preview paint after the card. */
const loaded = (page: Page) => expect(page.getByRole('list', { name: 'Versions' })).toBeVisible();

async function sweep(
  page: Page,
  url: string,
  name: string,
  ready: () => Promise<void>,
): Promise<void> {
  for (const theme of THEMES)
    for (const width of WIDTHS) {
      await frame(page, width, theme);
      await gotoRollout(page, url);
      await ready();
      await shoot(page, name, width, theme);
    }
  await frame(page, 1440, 'light');
  await gotoRollout(page, url);
}

test('the rollout card: mid-rollout, Tell holders, settled, then told', async ({ browser }) => {
  const author = await apiAs('admin');
  const ctx = await browser.newContext({ storageState: stateFile('admin') });
  try {
    const slug = uid('rollout-j').toLowerCase();
    const org = await createOrgWithRoles(author, { slug, name: `Rollout ${slug}` });
    const reviewer = await templateReviewer(author, org.id);
    const clone = TemplateDetailSchema.parse(
      await author.send(
        'POST',
        `/api/v1/templates/${encodeURIComponent(GENERIC_BLUEPRINT)}/clone`,
        {
          orgId: org.id,
          name: uid('Rollout journey'),
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
    for (let i = 0; i < 3; i++)
      await createPass(author, org.id, { templateId: clone.id, release: v1, mode: 'live' });

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
    for (let i = 0; i < 2; i++)
      await createPass(author, org.id, { templateId: clone.id, release: v2, mode: 'live' });

    const rollout = () =>
      author.send<Rollout>(
        'GET',
        `${path}/rollout?orgId=${encodeURIComponent(org.id)}&mode=live`,
        undefined,
        { 'x-passbook-mode': 'live' },
      );
    expect(await rollout()).toMatchObject({ total: 5, onRelease: 2, remaining: 3 });

    const url = `/admin/templates/${encodeURIComponent(clone.id)}?orgId=${encodeURIComponent(org.id)}&tab=versions`;
    const bar = (page: Page) => page.getByRole('progressbar', { name: 'Passes on the release' });
    const page = await ctx.newPage();
    await gotoRollout(page, url);

    // Mid-rollout: the title counts, and the bar is split by version.
    await expect(page.getByRole('heading', { name: 'Updating passes to v2' })).toBeVisible();
    await expect(page.getByText('Updating passes to v2: 2 of 5')).toBeVisible();
    await expect(page.getByText('v2 · 2')).toBeVisible();
    await expect(page.getByText('v1 · 3')).toBeVisible();
    // One segment for the release, one for the version still moving, sized by their passes.
    await expect(segments(page)).toHaveCount(2);
    await expect(page.locator('[data-segment="release"]')).toHaveCSS('flex-grow', '2');
    await expect(segments(page).nth(1)).toHaveCSS('flex-grow', '3');
    await sweep(page, url, 'rollout-1-updating', async () => {
      await expect(bar(page)).toBeVisible();
      await loaded(page);
    });

    // Tell holders names who gets it: the two on v2, not the three still moving.
    const dialog = page.getByRole('dialog', { name: 'Tell holders' });
    const open = async () => {
      await loaded(page);
      await page.getByRole('button', { name: 'Tell holders' }).click();
      await expect(dialog.getByText(/2 on v2/)).toBeVisible();
      await expect(dialog.getByText(/3 passes are still updating/)).toBeVisible();
      await page.waitForTimeout(600);
    };
    for (const theme of THEMES)
      for (const width of WIDTHS) {
        await frame(page, width, theme);
        await gotoRollout(page, url);
        await open();
        await shoot(page, 'rollout-2-tell', width, theme);
      }

    // The rebuild runs on the minute cron, a quiet minute after the release: tick it until the
    // three passes on v1 have moved.
    await expect
      .poll(
        async () => {
          await runMinuteCron();
          return (await rollout()).remaining;
        },
        { timeout: 300_000, intervals: [15_000] },
      )
      .toBe(0);
    const settled = page.getByRole('heading', { name: 'All passes are on v2' });
    await frame(page, 1440, 'light');
    await gotoRollout(page, url);
    await expect(settled).toBeVisible();
    await expect(page.getByText('5 of 5')).toBeVisible();
    // Only the release is left: the bar is one segment.
    await expect(segments(page)).toHaveCount(1);
    await expect(page.locator('[data-segment="release"]')).toHaveCSS('flex-grow', '5');
    await sweep(page, url, 'rollout-3-settled', async () => {
      await expect(settled).toBeVisible();
      await loaded(page);
    });

    // Everyone is on v2 now, so the offer names all five. Told once, the card has nothing left to say.
    await page.getByRole('button', { name: 'Tell holders' }).click();
    await expect(dialog.getByText(/5 on v2/)).toBeVisible();
    await dialog.getByRole('button', { name: 'Tell 5 holders' }).click();
    await expect(page.getByText('Message sent')).toBeVisible();
    await expect.poll(async () => (await rollout()).tell).toBeNull();
    await gotoRollout(page, url);
    await expect(page.getByRole('list', { name: 'Versions' })).toBeVisible();
    await loaded(page);
    await expect(settled).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Tell holders' })).toHaveCount(0);
    await sweep(page, url, 'rollout-4-told', async () => {
      await expect(page.getByRole('list', { name: 'Versions' })).toBeVisible();
      await loaded(page);
    });
    await reviewer.dispose();
  } finally {
    await ctx.close();
    await author.dispose();
  }
});

test("the rollout card: a pass that can't take the release is named, with the reason", async ({
  browser,
}) => {
  const author = await apiAs('admin');
  const ctx = await browser.newContext({ storageState: stateFile('admin') });
  try {
    const slug = uid('rollout-c').toLowerCase();
    const org = await createOrgWithRoles(author, { slug, name: `Rollout ${slug}` });
    const reviewer = await templateReviewer(author, org.id);
    const clone = TemplateDetailSchema.parse(
      await author.send(
        'POST',
        `/api/v1/templates/${encodeURIComponent(GENERIC_BLUEPRINT)}/clone`,
        {
          orgId: org.id,
          name: uid('Rollout left behind'),
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
    const stuck = await createPass(author, org.id, {
      templateId: clone.id,
      release: v1,
      mode: 'live',
      holder: 'Too many stamps',
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
    if (!saved.version) throw new Error('The second version was not saved');
    const v2 = await release(saved.version, v1.generation);
    await createPass(author, org.id, { templateId: clone.id, release: v2, mode: 'live' });
    // The rebuild could not move one card: the row it writes for the rollout view.
    recordRolloutFailure({
      passId: stuck.id,
      releaseId: v2.id,
      code: 'STAMPS_ABOVE_MAX',
      message: 'The card has 9 stamps; this version allows 5. Raise the maximum or redeem first.',
    });

    const url = `/admin/templates/${encodeURIComponent(clone.id)}?orgId=${encodeURIComponent(org.id)}&tab=versions`;
    const page = await ctx.newPage();
    const heading = page.getByRole('heading', { name: "1 pass can't move to v2" });
    const ready = async () => {
      await expect(heading).toBeVisible();
      await loaded(page);
    };
    await frame(page, 1440, 'light');
    await gotoRollout(page, url);
    await ready();
    // The bar names the pass left behind in its own segment, beside the release.
    await expect(page.locator('[data-segment="release"]')).toHaveCSS('flex-grow', '1');
    await expect(page.locator('[data-segment="left"]')).toHaveCSS('flex-grow', '1');
    await expect(page.getByText("Can't update · 1")).toBeVisible();
    const show = page.getByRole('button', { name: "Show 1 that can't update" });
    await show.click();
    const list = page.getByRole('list', { name: "Passes that can't update" });
    await expect(list.getByText('Too many stamps')).toBeVisible();
    await expect(list.getByText(/9 stamps; this version allows 5/)).toBeVisible();
    await sweep(page, url, 'rollout-5-cant', async () => {
      await ready();
      // The list opens on a click and a navigation keeps it open: open it only if it is shut.
      const shut = page.getByRole('button', { name: "Show 1 that can't update" });
      if (await shut.isVisible()) await shut.click();
      await expect(list.getByText('Too many stamps')).toBeVisible();
    });
    await reviewer.dispose();
  } finally {
    await ctx.close();
    await author.dispose();
  }
});
