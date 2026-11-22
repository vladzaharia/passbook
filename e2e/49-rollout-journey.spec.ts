import { expect, type Page, test } from '@playwright/test';
import { SaveVersionResponseSchema } from '../src/shared/contracts/template-versions.ts';
import {
  TemplateDetailSchema,
  TemplateVersionDetailSchema,
} from '../src/shared/contracts/templates.ts';
import { apiAs, createPass, GENERIC_BLUEPRINT, uid } from './helpers/api.ts';
import { stateFile } from './helpers/auth.ts';
import { frame, shoot, THEMES, WIDTHS } from './helpers/issuing.ts';
import {
  approveTemplateCandidate,
  createTemplateCandidate,
  publishTemplateCandidate,
  templateReviewer,
} from './helpers/releases.ts';
import { createOrgWithRoles } from './helpers/seed.ts';

// The rollout card as a story (the issuing redesign, I9): a release goes out, the card shows how
// far it has got, and the owner tells the holders who are on it.
// 42-template-rollout checks the server rules; this one follows the screen at 3 widths, 2 themes.
// It needs the rollout card, so it lands with origin/feat/template-rollout.
test.setTimeout(300_000);
test.use({ actionTimeout: 30_000 });

type Rollout = { total: number; onRelease: number; remaining: number; running: boolean };

/** Opens `url` in each frame and shoots once `ready` holds; a resize would close a dialog. */
async function sweep(
  page: Page,
  url: string,
  name: string,
  ready: () => Promise<void>,
): Promise<void> {
  for (const theme of THEMES)
    for (const width of WIDTHS) {
      await frame(page, width, theme);
      await page.goto(url);
      await ready();
      await shoot(page, name, width, theme);
    }
  await frame(page, 1440, 'light');
  await page.goto(url);
}

test('the rollout card: mid-rollout, Tell holders, then told once', async ({ browser }) => {
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
    await page.goto(url);

    // Mid-rollout: the title counts, and the bar is split by version.
    await expect(page.getByRole('heading', { name: 'Updating passes to v2' })).toBeVisible();
    await expect(page.getByText('Updating passes to v2: 2 of 5')).toBeVisible();
    await expect(page.getByText('v2 · 2')).toBeVisible();
    await expect(page.getByText('v1 · 3')).toBeVisible();
    await sweep(page, url, 'rollout-1-updating', () => expect(bar(page)).toBeVisible());

    // Tell holders names who gets it: the two on v2, not the three still moving.
    const dialog = page.getByRole('dialog', { name: 'Tell holders' });
    const open = async () => {
      await page.getByRole('button', { name: 'Tell holders' }).click();
      await expect(dialog.getByText(/2 on v2/)).toBeVisible();
      await expect(dialog.getByText(/3 passes are still updating/)).toBeVisible();
      await page.waitForTimeout(600);
    };
    for (const theme of THEMES)
      for (const width of WIDTHS) {
        await frame(page, width, theme);
        await page.goto(url);
        await open();
        await shoot(page, 'rollout-2-tell', width, theme);
      }
    await frame(page, 1440, 'light');
    await page.goto(url);
    await open();
    await dialog.getByRole('button', { name: 'Tell 2 holders' }).click();
    await expect(page.getByText('Message sent')).toBeVisible();

    // Told once: the offer is gone and the card keeps its bar. (The rebuild itself runs on the
    // platform's minute cron, which the e2e server does not tick: the 3 stay on v1.)
    await page.goto(url);
    await expect(page.getByRole('heading', { name: 'Updating passes to v2' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Tell holders' })).toHaveCount(0);
    await sweep(page, url, 'rollout-3-after-send', () => expect(bar(page)).toBeVisible());
    await reviewer.dispose();
  } finally {
    await ctx.close();
    await author.dispose();
  }
});
