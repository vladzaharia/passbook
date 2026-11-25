import { expect, type Page, test } from '@playwright/test';
import type { PassDetailDto } from '../src/shared/contracts/passes.ts';
import type { SessionResponse } from '../src/shared/contracts/session.ts';
import { TemplateDetailSchema } from '../src/shared/contracts/templates.ts';
import { apiAs, GENERIC_BLUEPRINT, requireActiveTemplateRelease, uid } from './helpers/api.ts';
import { stateFile } from './helpers/auth.ts';
import { templateReviewer } from './helpers/releases.ts';
import { createOrgWithRoles } from './helpers/seed.ts';

test.setTimeout(180_000);

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/;
/** Any 12+ hex run: full hashes and the short prefixes of them. */
const HASH = /\b[0-9a-f]{12,}\b/;

/** Rendered text only: a closed Technical details sheet does not count. */
const shown = { useInnerText: true } as const;

/** Moves the new-pass wizard to the details step, choosing the org first when it is not already chosen. */
async function toDetails(page: Page, orgName: string, templateName: string) {
  const name = page.getByRole('textbox', { name: 'Name', exact: true });
  // The org radio, not its name: the page's breadcrumb carries the org name as a link to Overview.
  const org = page.getByRole('radio', { name: orgName });
  const template = page.getByText(templateName, { exact: true }).first();
  const next = page.getByRole('button', { name: 'Next' });
  // The steps load before they show: wait for the org or the template tile, never click through a skeleton.
  await expect(template.or(org).first()).toBeVisible();
  if (!(await template.isVisible())) {
    await org.click();
    await expect(next).toBeEnabled();
    await next.click();
  }
  await template.click();
  await expect(next).toBeEnabled();
  await next.click();
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
      await author.send(
        'POST',
        `/api/v1/templates/${encodeURIComponent(GENERIC_BLUEPRINT)}/clone`,
        {
          orgId: org.id,
          name: templateName,
        },
      ),
    );
    expect(clone.activeVersion).toBeNull();
    const version = clone.versions[0]?.version;
    if (!version) throw new Error('The cloned template has no saved version');
    const url = `/admin/templates/${encodeURIComponent(clone.id)}?orgId=${encodeURIComponent(org.id)}&tab=versions`;

    // Author: requests review from the strip; the draft shows as in review.
    const authorPage = await adminCtx.newPage();
    await authorPage.goto(url);
    const strip = authorPage.getByRole('region', { name: 'Release' });
    await expect(strip).toContainText('Draft');
    await strip.getByRole('button', { name: 'Request review' }).click();
    const request = authorPage.getByRole('dialog');
    await expect(request).not.toHaveText(UUID, shown);
    await request.getByRole('button', { name: 'Request review' }).click();
    await expect(authorPage.getByText('Review requested')).toBeVisible();
    await expect(strip).toContainText('In review');
    await expect(authorPage.getByRole('button', { name: /^Review v/ })).toHaveCount(0);
    await expect(authorPage.locator('main')).not.toHaveText(HASH, shown);

    // Reviewer: the inbox lists it, the review shows the changes, and Approve does not release.
    const reviewerPage = await reviewerCtx.newPage();
    await reviewerPage.goto(`/admin/o/${encodeURIComponent(org.id)}/templates`);
    const inbox = reviewerPage.getByRole('region', { name: /Needs your review/ });
    await expect(inbox).toContainText(templateName);
    await inbox.getByRole('link', { name: new RegExp(`Review.*${templateName}`) }).click();
    const review = reviewerPage.getByRole('dialog', { name: 'Review v1' });
    await expect(review).toBeVisible();
    await expect(review).not.toHaveText(UUID, shown);
    await expect(review).not.toHaveText(HASH, shown);
    await expect(review.getByRole('button', { name: 'Approve and release' })).toHaveCount(0);
    await review.getByRole('button', { name: 'Approve', exact: true }).click();
    await expect(reviewerPage.getByText('Approved v1')).toBeVisible();
    await expect(review).toBeHidden();

    // Publisher: releases the approved version from the dialog.
    await authorPage.reload();
    await authorPage.getByRole('button', { name: 'Release v1' }).first().click();
    const dialog = authorPage.getByRole('dialog');
    await expect(dialog).not.toHaveText(UUID, shown);
    await expect(dialog).not.toHaveText(HASH, shown);
    await dialog.getByRole('button', { name: 'Release', exact: true }).click();
    await expect(authorPage.getByText('Released v1')).toBeVisible();
    await expect(dialog).toBeHidden();

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
    await authorPage.waitForURL((u) => /^\/admin\/o\/[^/]+\/passes\/[0-9a-f-]+$/.test(u.pathname));
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
