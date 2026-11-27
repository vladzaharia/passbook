import { expect, type Page } from '@playwright/test';

const next = (page: Page) => page.getByRole('button', { name: 'Next', exact: true }).click();

/**
 * The outbound path of the Connections wizard up to the Test step: URL, events (the defaults),
 * review, Create, copy the secret, verify.
 */
export async function addEndpoint(page: Page, org: string, url: string): Promise<void> {
  await page.goto(`/admin/o/${org}/connections/new?source=outbound`);
  await page.getByRole('textbox', { name: /URL/ }).fill(url);
  await page.getByRole('textbox', { name: /URL/ }).blur();
  await next(page);
  await expect(page.getByRole('heading', { name: 'Choose events', level: 2 })).toBeVisible();
  await next(page);
  await page.getByRole('button', { name: 'Add endpoint', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Copy the secret', level: 2 })).toBeVisible();
  await page.getByRole('checkbox', { name: 'I saved the secret' }).check();
  await next(page);
  await expect(page.getByRole('heading', { name: 'Check the signature', level: 2 })).toBeVisible();
  await next(page);
  await expect(page.getByRole('heading', { name: 'Send a test', level: 2 })).toBeVisible();
}
