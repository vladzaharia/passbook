import { expect, type Page } from '@playwright/test';

/** Make it yours as the page wizard: Name, Look, Review, then Create template. */
export async function useBlueprintWizard(page: Page, name: string) {
  await expect(page.getByRole('heading', { level: 1, name: 'Make it yours' })).toBeVisible();
  await page.getByRole('textbox', { name: /^Name/ }).fill(name);
  await page.getByRole('button', { name: 'Next' }).click();
  await expect(page.getByRole('heading', { name: 'Logo and colour' })).toBeVisible();
  await page.getByRole('button', { name: /^(Next|Review)$/ }).click();
  await expect(page.getByRole('heading', { name: 'Check and create' })).toBeVisible();
  await page.getByRole('button', { name: 'Create template' }).click();
}
