// Screenshots every (route, viewport, theme) and records console errors, failed requests, status.
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { type Browser, chromium } from '@playwright/test';
import { statePath } from './auth.ts';
import {
  DEVICES,
  fillPath,
  type Role,
  type Route,
  shotName,
  type Theme,
  VIEWPORTS,
  type ViewportName,
} from './routes.ts';

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
  const context = await browser.newContext({
    viewport: VIEWPORTS[viewport],
    ...DEVICES[viewport],
    colorScheme: theme,
    reducedMotion: 'reduce',
    ...(role === 'anon' ? {} : { storageState: statePath(o.stateDir, role) }),
  });
  await context.addCookies([{ name: 'wallet-theme', value: theme, url: o.base }]);
  // Links without a scope open the remembered one: the same org the placeholders use.
  const orgId = o.values.orgId;
  if (orgId && role !== 'anon' && role !== 'holder') {
    await context.addInitScript(
      (id) => localStorage.setItem('passbook-admin-scope', `org:${id}`),
      orgId,
    );
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

export async function capture(o: Options, routes: Route[]): Promise<Shot[]> {
  mkdirSync(o.out, { recursive: true });
  const browser = await chromium.launch();
  const shots: Shot[] = [];
  try {
    for (const theme of o.themes) {
      for (const viewport of o.viewports) {
        for (const role of new Set(routes.map((r) => r.role))) {
          const mine = routes.filter((r) => r.role === role);
          shots.push(...(await shoot(browser, o, role, viewport, theme, mine)));
        }
      }
    }
  } finally {
    await browser.close();
  }
  return shots;
}
