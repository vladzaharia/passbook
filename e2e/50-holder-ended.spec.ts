import { expect, test } from '@playwright/test';
import { apiAs, createPass, uid } from './helpers/api.ts';
import { type AgentId, pathOf, shoot, withAgent } from './helpers/holder-agents.ts';
import { nextSignInMail, snapshotMail } from './helpers/mail.ts';
import { readSeed } from './helpers/seed.ts';
import { stubTurnstile } from './helpers/turnstile.ts';

// H4: the ended card (voided, expired, removed), "Email me my passes", and the dead-link page.

async function endedPass(
  how: 'voided' | 'removed' | 'expired',
  opts: { email?: string | null; message?: string; expires?: string } = {},
) {
  const admin = await apiAs('admin');
  const email = opts.email === null ? undefined : (opts.email ?? `${uid('end')}@example.test`);
  const pass = await createPass(admin, readSeed().org.id, {
    holder: `Ended ${uid('E')}`,
    ...(email ? { email } : {}),
    ...(opts.expires ? { input: { expirationDate: opts.expires } } : {}),
  });
  if (how === 'voided')
    await admin.send('POST', `/api/v1/passes/${pass.id}/void`, { reason: 'e2e' });
  if (how === 'removed')
    await admin.send('POST', `/api/v1/passes/${pass.id}/remove`, {
      ...(opts.message ? { message: opts.message } : {}),
    });
  const detail = await admin.get(`/api/v1/passes/${pass.id}`);
  await admin.dispose();
  return { id: pass.id as string, email, path: pathOf(detail.publicUrl) };
}

const orgName = () => readSeed().org.name;

test('a voided pass says when, and "Email me my passes" mails a holder sign-in link', async ({
  playwright,
}) => {
  const target = await endedPass('voided');
  await withAgent(playwright, 'android', async (page) => {
    await page.goto(target.path);
    await expect(page.getByText(/^This pass was voided on \w{3} \d{1,2}, \d{4}\.$/)).toBeVisible();
    // No org contact here, so the way in is the only button.
    await expect(page.getByRole('link', { name: `Contact ${orgName()}` })).toHaveCount(0);
    await shoot(page, 'ended-voided');
    const before = snapshotMail();
    await page.getByRole('button', { name: 'Email me my passes' }).click();
    await page.waitForURL((u) => u.search.includes('signin=sent'));
    await expect(page.getByText('Sent. Check your email.')).toBeVisible();
    // The address is never on the page.
    await expect(page.locator('body')).not.toContainText(target.email as string);
    const mail = await nextSignInMail(before);
    expect(mail.link).toContain('/auth/magic');
    await shoot(page, 'ended-voided-sent');
  });
});

test('an ended pass leads with Contact when the org has a support link', async ({ playwright }) => {
  const admin = await apiAs('admin');
  const orgId = readSeed().org.id;
  const target = await endedPass('voided');
  await admin.send('PUT', '/api/v1/settings', {
    scope: `org:${orgId}`,
    values: { 'support.url': 'https://example.test/help' },
  });
  try {
    await withAgent(playwright, 'windows', async (page) => {
      await page.goto(target.path);
      const contact = page.getByRole('link', { name: `Contact ${orgName()}` });
      await expect(contact).toHaveAttribute('href', 'https://example.test/help');
      await expect(page.getByRole('button', { name: 'Email me my passes' })).toBeVisible();
      await shoot(page, 'ended-contact');
    });
  } finally {
    await admin.send('PUT', '/api/v1/settings', {
      scope: `org:${orgId}`,
      values: { 'support.url': null },
    });
    await admin.dispose();
  }
});

test('a removed pass shows the org note and the way back in', async ({ playwright }) => {
  const target = await endedPass('removed', { message: 'Replaced by a new pass.' });
  await withAgent(playwright, 'android', async (page) => {
    await page.goto(target.path);
    await expect(page.getByText('This pass was removed.')).toBeVisible();
    await expect(page.getByRole('status').getByText('Replaced by a new pass.')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Email me my passes' })).toBeVisible();
    await shoot(page, 'ended-removed');
  });
});

test('an ended pass with no holder email and no contact asks the org, with no dead end button', async ({
  playwright,
}) => {
  const target = await endedPass('voided', { email: null });
  await withAgent(playwright, 'android', async (page) => {
    await page.goto(target.path);
    await expect(page.getByText(`Ask ${orgName()} for a new pass.`)).toBeVisible();
    await expect(page.getByRole('button', { name: 'Email me my passes' })).toHaveCount(0);
  });
});

test('an expired pass names the day it expired, west and east of the server', async ({
  playwright,
}) => {
  const target = await endedPass('expired', { expires: '2026-06-15T12:00:00Z' });
  // Noon UTC is the same calendar day from Honolulu (UTC-10) to Auckland (UTC+12).
  for (const timezoneId of ['Pacific/Honolulu', 'Pacific/Auckland']) {
    await withAgent(
      playwright,
      'android',
      async (page) => {
        await page.goto(target.path);
        await expect(page.getByText('This pass expired on Jun 15, 2026.')).toBeVisible();
        await shoot(page, 'ended-expired');
      },
      { timezoneId },
    );
  }
});

for (const id of ['iphone', 'mac'] as const satisfies AgentId[]) {
  test(`${id}: the ended card reads the same and offers the way in`, async ({ playwright }) => {
    const target = await endedPass('voided');
    await withAgent(playwright, id, async (page) => {
      await page.goto(target.path);
      await expect(page.getByText(/^This pass was voided on /)).toBeVisible();
      await expect(page.getByRole('button', { name: 'Email me my passes' })).toBeVisible();
      await expect(page.getByRole('link', { name: 'Save to this phone' })).toHaveCount(0);
      await shoot(page, `ended-${id}`);
    });
  });
}

test('a dead pass link explains itself and opens sign-in with the reason', async ({
  playwright,
}) => {
  await withAgent(playwright, 'android', async (page) => {
    await stubTurnstile(page);
    const res = await page.goto(`/p/${'x'.repeat(43)}`);
    expect(res?.status()).toBe(404);
    await expect(page.getByRole('heading', { name: 'This pass link does not work' })).toBeVisible();
    await shoot(page, 'dead-pass');
    await page.getByRole('link', { name: 'Email me my passes' }).click();
    await page.waitForURL((u) => u.pathname === '/login');
    expect(new URL(page.url()).searchParams.get('reason')).toBe('link');
    await expect(
      page.getByText('That pass link does not work. Sign in to see your current passes.'),
    ).toBeVisible();
    await shoot(page, 'dead-pass-login');
  });
});

test('a failed browser check shows beside the reason line, not instead of it', async ({
  playwright,
}) => {
  await withAgent(playwright, 'android', async (page) => {
    await page.route('https://challenges.cloudflare.com/**', (route) => route.abort());
    await page.goto('/login?reason=link');
    await expect(
      page.getByText('Could not verify this browser. Reload and try again.'),
    ).toBeVisible();
    await expect(
      page.getByText('That pass link does not work. Sign in to see your current passes.'),
    ).toBeVisible();
  });
});

test('a dead bundle link says bundle', async ({ playwright }) => {
  await withAgent(playwright, 'windows', async (page) => {
    await page.goto(`/b/${'y'.repeat(43)}`);
    await expect(
      page.getByRole('heading', { name: 'This bundle link does not work' }),
    ).toBeVisible();
    await shoot(page, 'dead-bundle');
  });
});
