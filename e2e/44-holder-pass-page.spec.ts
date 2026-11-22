import { expect, test } from '@playwright/test';
import { apiAs, createPass, uid } from './helpers/api.ts';
import { AGENTS, type AgentId, pathOf, shoot, withAgent } from './helpers/holder-agents.ts';
import { readSeed } from './helpers/seed.ts';
import { stubTurnstile } from './helpers/turnstile.ts';

// H1 and H5: what each device leads with, and the pass page's way into My passes.

async function publicPass(email?: string) {
  const admin = await apiAs('admin');
  const pass = await createPass(admin, readSeed().org.id, {
    holder: `Page ${uid('P')}`,
    ...(email ? { email } : {}),
  });
  const detail = await admin.get(`/api/v1/passes/${pass.id}`);
  await admin.dispose();
  return { id: pass.id as string, path: pathOf(detail.publicUrl) };
}

const APPLE_ADD = 'a[href$="/pass.pkpass"]';
const QR_LINE = 'Scan with your iPhone camera.';

test.describe('the pass page leads with the way that fits the agent', () => {
  const email = `${uid('lead')}@example.test`;
  let target: { id: string; path: string };
  test.beforeAll(async () => {
    target = await publicPass(email);
  });

  test('iPhone Safari leads with the Apple Wallet badge and no QR', async ({ playwright }) => {
    await withAgent(playwright, 'iphone', async (page) => {
      await page.goto(target.path);
      await expect(page.locator(APPLE_ADD)).toBeVisible();
      await expect(page.getByText(QR_LINE)).toBeHidden();
      await expect(page.getByRole('link', { name: 'Save to this phone' })).toHaveCount(0);
      // Other ways still has the door view.
      await expect(page.getByRole('link', { name: 'Show barcode' })).toHaveAttribute(
        'href',
        `${target.path}/barcode`,
      );
      await shoot(page, 'pass-iphone');
    });
  });

  test('Mac Safari leads with the QR and offers the badge for this Mac', async ({ playwright }) => {
    await withAgent(playwright, 'mac', async (page) => {
      await page.goto(target.path);
      await expect(page.getByText(QR_LINE)).toBeVisible();
      await expect(page.getByText('Or on this Mac')).toBeVisible();
      await expect(page.locator(APPLE_ADD)).toBeVisible();
      await shoot(page, 'pass-mac');
    });
  });

  test('Windows Chrome leads with the QR and has no Apple badge', async ({ playwright }) => {
    await withAgent(playwright, 'windows', async (page) => {
      await page.goto(target.path);
      await expect(page.getByText(QR_LINE)).toBeVisible();
      await expect(page.getByText('Or on this Mac')).toBeHidden();
      await expect(page.locator(APPLE_ADD)).toHaveCount(0);
      await shoot(page, 'pass-windows');
    });
  });

  for (const id of ['android', 'galaxy'] as const satisfies AgentId[]) {
    test(`${AGENTS[id].label} leads with Save to this phone while wallets are dark`, async ({
      playwright,
    }) => {
      await withAgent(playwright, id, async (page) => {
        await page.goto(target.path);
        await expect(page.getByRole('link', { name: 'Save to this phone' }).first()).toBeVisible();
        // No Apple parts for Android: the way is named as text, with no QR or badge.
        await expect(
          page.getByText('For Apple Wallet, open this page on an iPhone.'),
        ).toBeVisible();
        await expect(page.getByText(QR_LINE)).toBeHidden();
        await expect(page.locator(APPLE_ADD)).toHaveCount(0);
        await shoot(page, `pass-${id}`);
      });
    });
  }
});

test('the header carries no My passes link, and Other ways has the row only with a holder email', async ({
  playwright,
}) => {
  const withEmail = await publicPass(`${uid('row')}@example.test`);
  const without = await publicPass();
  await withAgent(playwright, 'android', async (page) => {
    await page.goto(withEmail.path);
    await expect(page.getByRole('banner').getByRole('link', { name: 'My passes' })).toHaveCount(0);
    const row = page.getByRole('link', { name: 'My passes' });
    await expect(row).toHaveCount(1);
    await expect(row).toHaveAttribute('href', `/passes/${withEmail.id}`);
    await page.goto(without.path);
    await expect(page.getByRole('link', { name: 'My passes' })).toHaveCount(0);
  });
});

test('signed out, the My passes row asks for the email the pass was sent to', async ({
  playwright,
}) => {
  const target = await publicPass(`${uid('reason')}@example.test`);
  await withAgent(playwright, 'android', async (page) => {
    // The real widget cannot load on localhost; its error would replace the reason line.
    await stubTurnstile(page);
    await page.goto(target.path);
    await page.getByRole('link', { name: 'My passes' }).click();
    await page.waitForURL((u) => u.pathname === '/login');
    const url = new URL(page.url());
    expect(url.searchParams.get('next')).toBe(`/passes/${target.id}`);
    expect(url.searchParams.get('reason')).toBe('pass');
    await expect(page.getByText('Use the email this pass was sent to.')).toBeVisible();
    await shoot(page, 'login-reason-pass');
  });
});

test('every device sees the pass page in both themes without horizontal scroll', async ({
  playwright,
}) => {
  const target = await publicPass(`${uid('theme')}@example.test`);
  for (const theme of ['light', 'dark'] as const) {
    for (const id of ['iphone', 'android', 'mac'] as const) {
      await withAgent(
        playwright,
        id,
        async (page) => {
          await page.goto(target.path);
          const scheme = await page.evaluate(
            () => getComputedStyle(document.documentElement).colorScheme,
          );
          expect(scheme).toContain(theme);
          const overflow = await page.evaluate(
            () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
          );
          expect(overflow).toBeLessThanOrEqual(0);
          if (id === 'iphone') await shoot(page, 'pass-themed', theme);
        },
        { theme },
      );
    }
  }
});
