import { expect, type Page, test } from '@playwright/test';
import type { PassDetailDto } from '../src/shared/contracts/passes.ts';
import type { SessionResponse } from '../src/shared/contracts/session.ts';
import { TemplateDetailSchema } from '../src/shared/contracts/templates.ts';
import { apiAs, GENERIC, requireActiveTemplateRelease, uid } from './helpers/api.ts';
import { stateFile } from './helpers/auth.ts';
import { templateReviewer } from './helpers/releases.ts';
import { createOrgWithRoles } from './helpers/seed.ts';

test.setTimeout(180_000);

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/;
/** Any 12+ hex run: full hashes and the short prefixes of them. */
const HASH = /\b[0-9a-f]{12,}\b/;

/** Rendered text only: a closed Technical details disclosure does not count. */
const shown = { useInnerText: true } as const;

/** Moves the new-pass wizard to the details step, choosing the org and template when asked. */
async function toDetails(page: Page, orgName: string, templateName: string) {
  const name = page.getByRole('textbox', { name: 'Name', exact: true });
  for (let step = 0; step < 4 && !(await name.isVisible()); step++) {
    const org = page.getByText(orgName, { exact: true }).first();
    const template = page.getByText(templateName, { exact: true }).first();
    if (await template.isVisible()) await template.click();
    else if (await org.isVisible()) await org.click();
    await page.getByRole('button', { name: 'Next' }).click();
  }
  await expect(name).toBeVisible();
}

test('author proposes, reviewer approves, publisher releases, then a pass is issued', async ({
  browser,
}) => {
  const author = await apiAs('admin');
  const reviewerApi = await apiAs('reviewer');
  const adminCtx = await browser.newContext({ storageState: stateFile('admin') });
  const reviewerCtx = await browser.newContext({ storageState: stateFile('reviewer') });
  try {
    const authorSession = await author.get<SessionResponse>('/api/v1/session');
    const reviewerSession = await reviewerApi.get<SessionResponse>('/api/v1/session');
    if (!authorSession.authenticated || !reviewerSession.authenticated)
      throw new Error('Expected signed-in author and reviewer');
    expect(reviewerSession.user.id).not.toBe(authorSession.user.id);

    // One org, two members: the admin authors and publishes, the reviewer only reviews.
    const slug = uid('review-e2e').toLowerCase();
    const org = await createOrgWithRoles(author, { slug, name: `Review ${slug}` });
    const reviewer = await templateReviewer(author, org.id);
    await reviewer.dispose();
    const templateName = uid('Reviewed card');
    const clone = TemplateDetailSchema.parse(
      await author.send('POST', `/api/v1/templates/${encodeURIComponent(GENERIC)}/clone`, {
        orgId: org.id,
        name: templateName,
      }),
    );
    expect(clone.activeVersion).toBeNull();
    const version = clone.versions[0]?.version;
    if (!version) throw new Error('The cloned template has no saved version');
    const url = `/admin/templates/${encodeURIComponent(clone.id)}?orgId=${encodeURIComponent(org.id)}&tab=versions`;

    // Author: create a candidate from the saved version.
    const authorPage = await adminCtx.newPage();
    await authorPage.goto(url);
    await authorPage.getByRole('combobox', { name: 'Saved version' }).click();
    await authorPage.getByRole('option', { name: 'Version 1', exact: true }).click();
    await authorPage.getByRole('button', { name: 'Create candidate' }).click();
    await expect(authorPage.getByText('Candidate created')).toBeVisible();
    const candidates = authorPage.getByRole('list', { name: 'Release candidates' });
    const card = candidates.getByRole('listitem').first();
    await expect(card.getByRole('heading', { name: 'Version 1' })).toBeVisible();
    await expect(card.getByText('Awaiting approval')).toBeVisible();
    if (authorSession.user.name)
      await expect(card.getByText(authorSession.user.name).first()).toBeVisible();
    await expect(card).not.toHaveText(UUID, shown);
    await expect(card).not.toHaveText(HASH, shown);

    // The author cannot approve their own candidate.
    await expect(
      card.getByText('You cannot review a candidate or version you authored.'),
    ).toBeVisible();
    const selfApprove = card.getByRole('button', { name: 'Approve candidate for Version 1' });
    if (await selfApprove.count()) await expect(selfApprove).toBeDisabled();
    await expect(
      card.getByRole('button', { name: 'Publish candidate for Version 1' }),
    ).toBeDisabled();

    // Reviewer: approves it, and cannot publish.
    const reviewerPage = await reviewerCtx.newPage();
    await reviewerPage.goto(url);
    const reviewCard = reviewerPage
      .getByRole('list', { name: 'Release candidates' })
      .getByRole('listitem')
      .first();
    await expect(reviewCard.getByRole('heading', { name: 'Version 1' })).toBeVisible();
    await expect(reviewCard).not.toHaveText(UUID, shown);
    await expect(reviewCard.getByRole('button', { name: /^Publish candidate/ })).toHaveCount(0);
    await reviewCard.getByRole('button', { name: 'Approve candidate for Version 1' }).click();
    await expect(reviewerPage.getByText('Candidate approved')).toBeVisible();
    await expect(reviewCard.getByText('Approved', { exact: true })).toBeVisible();
    if (reviewerSession.user.name)
      await expect(reviewCard.getByText(reviewerSession.user.name).first()).toBeVisible();

    // Publisher: reviews the impact in the dialog, then publishes.
    await authorPage.reload();
    await expect(authorPage.locator('main')).not.toHaveText(HASH, shown);
    await authorPage.getByRole('button', { name: 'Publish candidate for Version 1' }).click();
    const dialog = authorPage.getByRole('dialog', { name: 'Publish release' });
    const impact = dialog.getByRole('region', { name: 'Impact' });
    await expect(impact.getByText('Passes to update')).toBeVisible();
    await expect(impact.getByText('Loading impact')).toHaveCount(0);
    await expect(dialog.getByText('Approved by')).toBeVisible();
    if (reviewerSession.user.name)
      await expect(dialog.getByText(reviewerSession.user.name).first()).toBeVisible();
    await expect(dialog).not.toHaveText(UUID, shown);
    await expect(dialog).not.toHaveText(HASH, shown);
    const technical = dialog.locator('details', { hasText: 'Technical details' });
    await expect(technical).not.toHaveAttribute('open', '');
    await technical.getByText('Technical details').click();
    await expect(technical.getByText(HASH).first()).toBeVisible();
    await dialog.getByRole('button', { name: 'Confirm publish' }).click();
    await expect(dialog).toBeHidden();
    await expect(authorPage.getByText('Release published')).toBeVisible();
    await expect(authorPage.getByText('Published by', { exact: true })).toBeVisible();

    const release = await requireActiveTemplateRelease(author, org.id, clone.id, 'live');
    expect(release.version).toBe(version);

    // Issue a pass from the released template in the admin UI.
    const holder = uid('Holder');
    await authorPage.goto(`/admin/passes/new?orgId=${encodeURIComponent(org.id)}`);
    await toDetails(authorPage, org.name, templateName);
    await authorPage.getByRole('textbox', { name: 'Name', exact: true }).fill(holder);
    await authorPage
      .getByRole('textbox', { name: 'ID', exact: true })
      .fill(uid('ID').toUpperCase());
    await authorPage.getByRole('button', { name: 'Next' }).click();
    await authorPage.getByRole('button', { name: 'Next' }).click();
    const created = authorPage.waitForResponse(
      (response) =>
        new URL(response.url()).pathname === '/api/v1/passes' &&
        response.request().method() === 'POST',
    );
    await authorPage.getByRole('button', { name: /^Create/ }).click();
    const response = await created;
    expect(response.status()).toBe(201);
    expect(response.request().postDataJSON()).toMatchObject({
      orgId: org.id,
      templateId: clone.id,
      templateVersion: version,
      releaseId: release.id,
      releaseGeneration: release.generation,
    });
    const pass = (await response.json()) as PassDetailDto;
    await authorPage.waitForURL((u) => /^\/admin\/passes\/[0-9a-f-]+$/.test(u.pathname));
    await expect(authorPage.getByRole('heading', { level: 1 })).toContainText(holder);
    await expect(authorPage.getByText('Active', { exact: true }).first()).toBeVisible();
    const issued = await author.get<PassDetailDto>(`/api/v1/passes/${encodeURIComponent(pass.id)}`);
    expect(issued).toMatchObject({ status: 'active', templateVersion: version, mode: 'live' });
  } finally {
    await adminCtx.close();
    await reviewerCtx.close();
    await reviewerApi.dispose();
    await author.dispose();
  }
});
