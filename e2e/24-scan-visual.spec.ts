import { expect, type Page, test } from '@playwright/test';

const passes = [
  'event',
  'boarding',
  'identity',
  'membership',
  'loyalty',
  'wallet',
  'coupon',
  'generic',
];
const viewports = [
  { width: 320, height: 640, scheme: 'light' as const },
  { width: 390, height: 844, scheme: 'light' as const },
  { width: 820, height: 1180, scheme: 'light' as const },
  { width: 1366, height: 900, scheme: 'dark' as const },
  { width: 1366, height: 480, scheme: 'dark' as const },
];
const logo = `<svg xmlns="http://www.w3.org/2000/svg" width="480" height="150" viewBox="0 0 480 150"><rect width="480" height="150" rx="28" fill="#0f766e"/><circle cx="76" cy="75" r="38" fill="#d9f4ef"/><path d="M58 75h36M76 57v36" stroke="#0f766e" stroke-width="8" stroke-linecap="round"/><text x="136" y="91" fill="#fff" font-family="sans-serif" font-size="46" font-weight="700">Northwind</text></svg>`;

async function serveVisualLogo(page: Page) {
  await page.route('**/api/v1/scan/branding/logo*', (route) =>
    route.fulfill({ status: 200, contentType: 'image/svg+xml', body: logo }),
  );
}

async function expectNoHorizontalOverflow(page: Page) {
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - window.innerWidth,
  );
  expect(overflow).toBeLessThanOrEqual(1);
}

async function expectWithinViewport(page: Page, selector: string) {
  const box = await page.locator(selector).boundingBox();
  const viewport = page.viewportSize();
  expect(box).not.toBeNull();
  expect(viewport).not.toBeNull();
  if (!box || !viewport) return;
  expect(box.x).toBeGreaterThanOrEqual(-1);
  expect(box.y).toBeGreaterThanOrEqual(-1);
  expect(box.x + box.width).toBeLessThanOrEqual(viewport.width + 1);
  expect(box.y + box.height).toBeLessThanOrEqual(viewport.height + 1);
}

test('scanner and operator pass layouts stay readable at phone, tablet and desk sizes', async ({
  page,
}) => {
  test.setTimeout(180_000);
  await serveVisualLogo(page);
  for (const surface of ['scanner', 'operator']) {
    for (const pass of passes) {
      for (const viewport of viewports) {
        await page.setViewportSize({ width: viewport.width, height: viewport.height });
        await page.emulateMedia({ colorScheme: viewport.scheme, reducedMotion: 'no-preference' });
        await page.goto(`/scan?visual=1&surface=${surface}&pass=${pass}`);
        const card = page.getByTestId('scan-result');
        await expect(card).toBeVisible();
        await expect(page.getByRole('heading', { level: 1 }).first()).toBeVisible();
        await expect(page.locator('.scan-buddy-seat')).toHaveCSS('opacity', '0');
        await expectWithinViewport(page, '.scan-result');
        await expectNoHorizontalOverflow(page);
        if (pass === 'generic' && viewport.height <= 650) {
          const body = page.locator('.scan-result-body');
          for (const value of ['Saturday eve', 'Gallery wing']) {
            const field = page.getByText(value, { exact: true });
            await field.scrollIntoViewIfNeeded();
            await expect(field).toBeInViewport({ ratio: 1 });
          }
          await body.evaluate((element) => {
            element.scrollTop = 0;
          });
        }
        if (pass === 'identity' && viewport.height <= 650) {
          const eyebrow = await page
            .locator('.scan-result-band .scan-verdict-eyebrow')
            .boundingBox();
          const title = await page.locator('.scan-result-band h1').boundingBox();
          expect(eyebrow).not.toBeNull();
          expect(title).not.toBeNull();
          if (eyebrow && title) expect(title.y).toBeGreaterThanOrEqual(eyebrow.y + eyebrow.height);
        }
        if (surface === 'operator' && viewport.width >= 900) {
          const resultBox = await card.boundingBox();
          const lookupBox = await page.getByRole('region', { name: 'Find a pass' }).boundingBox();
          expect(resultBox).not.toBeNull();
          expect(lookupBox).not.toBeNull();
          if (resultBox && lookupBox)
            expect(resultBox.x).toBeGreaterThanOrEqual(lookupBox.x + lookupBox.width - 1);
        }
        if (surface === 'operator') {
          await expect(page.getByRole('complementary', { name: 'Operator view' })).toBeVisible();
          await expect(page.getByRole('region', { name: 'Session activity' })).toBeHidden();
        }
        await page.screenshot({
          path: `test-results/scan-visual-${surface}-${pass}-${viewport.width}x${viewport.height}.png`,
        });
      }
      await page.setViewportSize({ width: 390, height: 844 });
      await page.emulateMedia({ colorScheme: 'light', reducedMotion: 'no-preference' });
      await page.goto(`/scan?visual=1&surface=${surface}&pass=${pass}`);
      await page.getByRole('button', { name: 'View pass', exact: true }).click();
      const preview = page.locator('.scan-detail-sheet');
      await expect(preview).toBeVisible();
      await expect
        .poll(async () => (await preview.boundingBox())?.x ?? Infinity)
        .toBeLessThanOrEqual(1);
      await expectWithinViewport(page, '.scan-detail-sheet');
      await expect(page.locator('.pc-root')).toHaveAttribute('data-face', 'front');
      await expectNoHorizontalOverflow(page);
      await page.screenshot({
        path: `test-results/scan-visual-${surface}-${pass}-wallet-front.png`,
      });
      await page.getByRole('button', { name: 'Details', exact: true }).click();
      await expect(page.locator('.pc-root')).toHaveAttribute('data-face', 'back');
      await page.screenshot({
        path: `test-results/scan-visual-${surface}-${pass}-wallet-back.png`,
      });
    }
  }
});

test('scan details remain reachable on compact screens', async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 640 });
  await page.goto('/scan?visual=1&surface=scanner&pass=generic');
  const body = page.locator('.scan-result-body');
  const note = page.getByText('If the printed name differs, check with a supervisor.');
  await expect(note).toBeVisible();
  const sizes = await body.evaluate((element) => ({
    client: element.clientHeight,
    scroll: element.scrollHeight,
  }));
  if (sizes.scroll > sizes.client) await note.scrollIntoViewIfNeeded();
  await expect(note).toBeInViewport({ ratio: 1 });
  await expectNoHorizontalOverflow(page);
  await page.screenshot({
    animations: 'disabled',
    path: 'test-results/scan-visual-generic-320x640-details-scroll.png',
  });
  await page.goto('/scan?visual=1&surface=scanner&pass=identity');
  const memberId = page.getByText('NW-2048-771', { exact: true });
  await expect(memberId).toBeVisible();
  await memberId.scrollIntoViewIfNeeded();
  await expect(memberId).toBeInViewport({ ratio: 1 });
  await expectNoHorizontalOverflow(page);
});
test('scan verdict motion respects the reduced-motion preference', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await page.goto('/scan?visual=1&surface=scanner&pass=event&phase=rising');
  const animationName = () =>
    page.locator('.scan-result').evaluate((element) => getComputedStyle(element).animationName);
  await expect.poll(animationName).toBe('scan-result-rise');
  await page.screenshot({ path: 'test-results/scan-visual-verdict-motion.png' });
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await expect.poll(animationName).toBe('scan-card-fade');
});

test('customer screens stay pass-agnostic and legible across sizes', async ({ page }) => {
  test.setTimeout(180_000);
  await serveVisualLogo(page);
  for (const pass of passes) {
    for (const viewport of viewports) {
      await page.setViewportSize({ width: viewport.width, height: viewport.height });
      await page.emulateMedia({ colorScheme: viewport.scheme, reducedMotion: 'no-preference' });
      await page.goto(`/scan?visual=1&surface=customer&pass=${pass}`);
      await expect(page.getByTestId('scan-live')).toHaveAttribute('data-view', 'customer');
      await expect(page.getByRole('heading', { name: 'Checked in', exact: true })).toBeVisible();
      await expect(page.getByRole('button', { name: 'Refresh setup' })).toHaveCount(0);
      await expect(page.getByTestId('scan-live')).not.toContainText('Private pass holder');
      await expectWithinViewport(page, '.scan-live-welcome');
      await expectWithinViewport(page, '.scan-live-buddy');
      await expectNoHorizontalOverflow(page);
      await page.screenshot({
        animations: 'disabled',
        path: `test-results/scan-visual-customer-${pass}-${viewport.width}x${viewport.height}.png`,
      });
    }
  }
});

test('Duo customer display keeps its brand lockup and status clear in short and tall layouts', async ({
  page,
}) => {
  await serveVisualLogo(page);
  for (const viewport of viewports) {
    await page.emulateMedia({ colorScheme: viewport.scheme, reducedMotion: 'no-preference' });
    await page.goto('/scan?visual=1&surface=duo&status=accepted');
    await expect(page.getByText('Northwind Live')).toBeVisible();
    await expect(page.getByRole('heading', { name: "You're checked in" })).toBeVisible();
    await expectWithinViewport(page, '.duo-customer-display-copy');
    await expectNoHorizontalOverflow(page);
    await page.screenshot({
      animations: 'disabled',
      path: `test-results/scan-visual-duo-${viewport.width}x${viewport.height}.png`,
    });
  }
});
