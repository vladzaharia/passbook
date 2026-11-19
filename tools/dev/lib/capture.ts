// Screenshots every (route, viewport, theme) and records console errors, failed requests, status.
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { type Browser, chromium } from '@playwright/test';
import { statePath } from './auth.ts';
import {
  fillPath,
  type Role,
  type Route,
  SIZES,
  shotName,
  type Theme,
  type ViewportName,
} from './routes.ts';
import { GALLERY_LOGO, touchOptions } from './touch.ts';

export type Shot = {
  route: string;
  name: string;
  role: Role;
  viewport: string;
  theme: string;
  file: string | null;
  status: number | null;
  consoleErrors: string[];
  failedRequests: string[];
  note?: string;
};

type Options = {
  base: string;
  out: string;
  stateDir: string;
  viewports: ViewportName[];
  /** `--viewports` was given: a route's own viewport list is narrowed to it. */
  narrow?: boolean;
  themes: Theme[];
  values: Record<string, string | undefined>;
};

/** Index entries never carry pass, bundle or join capability tokens. */
const redact = (text: string) => text.replace(/\/(p|b|j)\/[A-Za-z0-9_-]{20,}/g, '/$1/:token');

const SETTLE = '[aria-busy="true"], .wl-skeleton';

async function shoot(
  browser: Browser,
  o: Options,
  role: Role,
  viewport: ViewportName,
  theme: Theme,
  routes: Route[],
): Promise<Shot[]> {
  const touch = routes.some((r) => r.device === 'touch');
  const context = await browser.newContext({
    viewport: SIZES[viewport],
    ...(touch ? touchOptions(viewport) : {}),
    colorScheme: theme,
    reducedMotion: 'reduce',
    ...(role === 'anon' ? {} : { storageState: statePath(o.stateDir, role) }),
  });
  await context.addCookies([{ name: 'wallet-theme', value: theme, url: o.base }]);
  // The console asks for an org until one is chosen; pick the same one the placeholders use.
  const orgId = o.values.orgId;
  if (orgId && role !== 'anon' && role !== 'holder') {
    await context.addInitScript((id) => localStorage.setItem('wallet-org-filter', id), orgId);
  }
  const shots: Shot[] = [];
  for (const route of routes) {
    const base = { name: route.name, role, viewport, theme };
    const path = fillPath(route.path, o.values);
    if (!path) {
      shots.push({
        ...base,
        route: route.path,
        file: null,
        status: null,
        consoleErrors: [],
        failedRequests: [],
        note: 'skipped: placeholder has no data',
      });
      continue;
    }
    const page = await context.newPage();
    const filter = route.filterOrg ? o.values[route.filterOrg] : undefined;
    if (filter && role !== 'anon' && role !== 'holder')
      await page.addInitScript((id) => localStorage.setItem('wallet-org-filter', id), filter);
    if (path.includes('visual=1'))
      await page.route('**/api/v1/scan/branding/logo*', (r) =>
        r.fulfill({ status: 200, contentType: 'image/svg+xml', body: GALLERY_LOGO }),
      );
    const consoleErrors: string[] = [];
    const failedRequests: string[] = [];
    page.on('console', (m) => m.type() === 'error' && consoleErrors.push(m.text().slice(0, 300)));
    page.on('pageerror', (e) => consoleErrors.push(`pageerror: ${e.message.slice(0, 300)}`));
    page.on(
      'requestfailed',
      (r) =>
        r.failure()?.errorText !== 'net::ERR_ABORTED' &&
        failedRequests.push(redact(`${r.method()} ${r.url()} ${r.failure()?.errorText ?? ''}`)),
    );
    page.on(
      'response',
      (r) =>
        r.status() >= 400 &&
        failedRequests.push(redact(`${r.request().method()} ${r.url()} ${r.status()}`)),
    );
    const file = shotName(route.name, viewport, theme);
    let status: number | null = null;
    let note: string | undefined;
    try {
      const res = await page.goto(`${o.base}${path}`, { waitUntil: 'load', timeout: 30_000 });
      status = res?.status() ?? null;
      await page.waitForLoadState('networkidle', { timeout: 15_000 }).catch(() => {
        note = 'network never went idle';
      });
      if (route.waitFor)
        await page.waitForSelector(route.waitFor, { timeout: 10_000 }).catch(() => {
          note = `waitFor ${route.waitFor} not found`;
        });
      await page
        .waitForFunction((sel) => !document.querySelector(sel), SETTLE, { timeout: 10_000 })
        .catch(() => {
          note = [note, 'skeleton still showing'].filter(Boolean).join('; ');
        });
      if (route.click) {
        await page
          .locator(route.click)
          .first()
          .click({ timeout: 10_000 })
          .catch(() => {
            note = `click ${route.click} not found`;
          });
        await page.waitForLoadState('networkidle', { timeout: 10_000 }).catch(() => undefined);
      }
      if (status !== null && status >= 400) note = `HTTP ${status}`;
      await page.screenshot({ path: resolve(o.out, file), fullPage: true });
    } catch (error) {
      note = `capture failed: ${(error as Error).message.split('\n')[0]}`;
    }
    shots.push({
      ...base,
      route: redact(path),
      file: note?.startsWith('capture failed') ? null : file,
      status,
      consoleErrors,
      failedRequests,
      ...(note ? { note } : {}),
    });
    await page.close();
  }
  await context.close();
  return shots;
}

/** Whether `route` is shot at `viewport`: its own list (narrowed by --viewports) or the requested ones. */
const wants = (o: Options, route: Route, viewport: ViewportName): boolean =>
  route.viewports
    ? route.viewports.includes(viewport) && (!o.narrow || o.viewports.includes(viewport))
    : o.viewports.includes(viewport);

export async function capture(o: Options, routes: Route[]): Promise<Shot[]> {
  mkdirSync(o.out, { recursive: true });
  const browser = await chromium.launch();
  const shots: Shot[] = [];
  try {
    const names = new Set<ViewportName>([
      ...o.viewports,
      ...routes.flatMap((r) => r.viewports ?? []),
    ]);
    for (const theme of o.themes) {
      for (const viewport of names) {
        const here = routes.filter((r) => wants(o, r, viewport));
        for (const role of new Set(here.map((r) => r.role))) {
          // A touch route and a desktop route need different contexts, so they run apart.
          for (const device of [undefined, 'touch'] as const) {
            const mine = here.filter((r) => r.role === role && r.device === device);
            if (mine.length > 0)
              shots.push(...(await shoot(browser, o, role, viewport, theme, mine)));
          }
        }
      }
    }
  } finally {
    await browser.close();
  }
  return shots;
}
