import { mkdirSync } from 'node:fs';
import {
  type Browser,
  type BrowserContext,
  type BrowserType,
  devices,
  type Page,
  type PlaywrightWorkerArgs,
} from '@playwright/test';
import { BASE } from './api.ts';

/**
 * The user agents holders arrive with (analysis.md, "What each device leads with"). Each runs in
 * the engine it ships: iPhone and Mac in WebKit, the rest in Chromium. WebKit upgrades a link click
 * to https (the pages send upgrade-insecure-requests) and fails on the plain-http dev origin:
 * with WebKit, `goto` the path and assert the link's href instead of clicking it.
 */
export type AgentId = 'iphone' | 'android' | 'galaxy' | 'mac' | 'windows';

const GALAXY_UA =
  'Mozilla/5.0 (Linux; Android 14; SM-S918B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Mobile Safari/537.36';

interface Agent {
  label: string;
  engine: 'webkit' | 'chromium';
  options: Parameters<Browser['newContext']>[0];
}

const { defaultBrowserType: _a, ...iphone } = devices['iPhone 14'];
const { defaultBrowserType: _b, ...pixel } = devices['Pixel 7'];
const { defaultBrowserType: _c, ...mac } = devices['Desktop Safari'];
const { defaultBrowserType: _d, ...windows } = devices['Desktop Chrome'];

export const AGENTS: Record<AgentId, Agent> = {
  iphone: { label: 'iPhone Safari', engine: 'webkit', options: iphone },
  android: { label: 'Android Chrome', engine: 'chromium', options: pixel },
  galaxy: {
    label: 'Galaxy Chrome',
    engine: 'chromium',
    options: { ...pixel, userAgent: GALAXY_UA },
  },
  mac: { label: 'Mac Safari', engine: 'webkit', options: mac },
  windows: { label: 'Windows Chrome', engine: 'chromium', options: windows },
};

export const ALL_AGENTS = Object.keys(AGENTS) as AgentId[];

type Pw = Pick<PlaywrightWorkerArgs['playwright'], 'webkit' | 'chromium'>;

/** Runs `fn` in a fresh context of one agent (reduced motion, like the config), then closes it. */
export async function withAgent<T>(
  pw: Pw,
  id: AgentId,
  fn: (page: Page, ctx: BrowserContext) => Promise<T>,
  options: {
    theme?: 'light' | 'dark';
    viewport?: { width: number; height: number };
    timezoneId?: string;
  } = {},
): Promise<T> {
  const agent = AGENTS[id];
  const type: BrowserType = pw[agent.engine];
  const browser = await type.launch();
  try {
    const ctx = await browser.newContext({
      ...agent.options,
      baseURL: BASE,
      reducedMotion: 'reduce',
      colorScheme: options.theme ?? 'light',
      ...(options.viewport ? { viewport: options.viewport } : {}),
      ...(options.timezoneId ? { timezoneId: options.timezoneId } : {}),
    });
    if (options.theme) {
      await ctx.addCookies([{ name: 'wallet-theme', value: options.theme, url: BASE }]);
    }
    return await fn(await ctx.newPage(), ctx);
  } finally {
    await browser.close();
  }
}

/** The path of a pass's public page, from the admin API's detail. */
export const pathOf = (url: string) => new URL(url, BASE).pathname;

// SHOTS=<dir> also writes each screen at 390, 834 and 1440, light and dark, for the visual sweep.
const SHOTS = process.env.SHOTS;
const WIDTHS = [
  [390, 844],
  [834, 1112],
  [1440, 900],
] as const;

/** A dialog is open: resizing the page under it can close it or move what the test clicks next. */
export const modalOpen = (page: Page) =>
  page.locator('dialog[open], [role=dialog], [role=alertdialog]').first().isVisible();

/**
 * With SHOTS set, screenshots the page (full page) at three widths. With no `theme` it takes both
 * themes by flipping the colour scheme the page follows; a page already pinned to a theme by its
 * cookie passes that theme and gets one pass. The viewport is restored after. While a dialog is
 * open the page is not resized: one shot at the current width, named for it.
 */
export async function shoot(page: Page, name: string, theme?: 'light' | 'dark') {
  if (!SHOTS) return;
  mkdirSync(SHOTS, { recursive: true });
  const first = page.viewportSize();
  const modal = await modalOpen(page);
  const sizes = modal && first ? [[first.width, first.height] as const] : WIDTHS;
  for (const scheme of theme ? [theme] : (['light', 'dark'] as const)) {
    if (!theme) await page.emulateMedia({ colorScheme: scheme, reducedMotion: 'reduce' });
    for (const [width, height] of sizes) {
      if (!modal) await page.setViewportSize({ width, height });
      await page.waitForTimeout(250);
      await page.screenshot({
        path: `${SHOTS}/${name}-${width}-${scheme}.png`,
        fullPage: !modal,
      });
    }
  }
  if (!theme) await page.emulateMedia({ colorScheme: 'light', reducedMotion: 'reduce' });
  if (!modal && first) await page.setViewportSize(first);
}
