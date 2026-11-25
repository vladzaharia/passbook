import type { Page } from '@playwright/test';

/** The signed-in person's developer sandbox: admin does not list it, so its URL is built from this. */
export async function sandboxOrgId(page: Page): Promise<string> {
  const id = await page.evaluate(async () => {
    const res = await fetch('/api/v1/orgs/memberships/me');
    const body = (await res.json()) as { items: { orgId: string; testOnly?: boolean }[] };
    return body.items.find((m) => m.testOnly)?.orgId ?? '';
  });
  if (!id) throw new Error('This person has no developer sandbox.');
  return id;
}
