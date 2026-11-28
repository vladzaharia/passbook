// Visual sweep of the scanner as a paired device: pairs a browser through the real pairing flow,
// then walks the roles and states (door, operator, desk, customer, hours, offline, staff sign-in),
// the monitor and the customer display. Run after tools/seed-demo.ts, beside visual-sweep.ts.
//   node tools/dev/visual-scan-devices.ts --url http://localhost:5273 --out .wrangler/visual-sweep/scanning
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { type Browser, type BrowserContext, chromium } from '@playwright/test';
import { assertLocal } from '../lib/demo-client.ts';
import { contextFor } from './lib/auth.ts';
import type { Shot } from './lib/capture.ts';
import { SIZES, shotName, type Theme, type ViewportName } from './lib/routes.ts';
import {
  findFixtures,
  newPairingCode,
  pairBrowser,
  resetPin,
  type ScanApi,
  type ScanFixtures,
  scanApi,
} from './lib/scan-api.ts';
import { deskBridgeStates, doorBridgeStates, installFakeApp } from './lib/scan-bridge.ts';
import { codes as passCodes, seedScans } from './lib/scan-seed.ts';
import { eventDeskStates, type Run, tabletStates } from './lib/scan-states.ts';
import { touchOptions } from './lib/touch.ts';

const root = resolve(import.meta.dirname, '../..');
const args = process.argv.slice(2);
const arg = (name: string) => args[args.indexOf(name) + 1];
const has = (name: string) => args.includes(name);

const DEVICE_VIEWPORTS: ViewportName[] = ['mobile', 'tablet', 'tabletLandscape'];
const DISPLAY_VIEWPORTS: ViewportName[] = ['tabletLandscape', 'tv'];
const DISPLAY_STATES = ['ready', 'checking', 'accepted', 'checkedOut', 'rejected'] as const;

type Ctx = { browser: Browser; base: string; out: string; shots: Shot[] };

async function newContext(c: Ctx, viewport: ViewportName, theme: Theme) {
  const context = await c.browser.newContext({
    ...touchOptions(viewport),
    colorScheme: theme,
    reducedMotion: 'reduce',
    permissions: ['camera'],
  });
  await context.addCookies([{ name: 'wallet-theme', value: theme, url: c.base }]);
  return context;
}

function recorder(
  c: Ctx,
  context: BrowserContext,
  group: string,
  viewport: ViewportName,
  theme: Theme,
) {
  const errors: string[] = [];
  const failed: string[] = [];
  const watch = (page: import('@playwright/test').Page) => {
    page.on('console', (m) => m.type() === 'error' && errors.push(m.text().slice(0, 300)));
    page.on('pageerror', (e) => errors.push(`pageerror: ${e.message.slice(0, 300)}`));
    page.on(
      'response',
      (r) =>
        r.status() >= 400 &&
        failed.push(`${r.request().method()} ${r.url().replace(c.base, '')} ${r.status()}`),
    );
  };
  context.on('page', watch);
  const snap = (page: import('@playwright/test').Page) => async (name: string, note?: string) => {
    const file = shotName(name, viewport, theme);
    await page.screenshot({ path: resolve(c.out, file), fullPage: true });
    c.shots.push({
      route: `/scan (${group})`,
      name,
      role: 'anon',
      viewport,
      theme,
      file,
      status: 200,
      consoleErrors: errors.splice(0),
      failedRequests: failed.splice(0),
      ...(note ? { note } : {}),
    });
  };
  return { snap };
}

async function pairedDevice(
  c: Ctx,
  api: ScanApi,
  fx: ScanFixtures,
  pins: Map<string, string>,
  viewport: ViewportName,
  theme: Theme,
) {
  const context = await newContext(c, viewport, theme);
  try {
    const page = await context.newPage();
    const { snap } = recorder(c, context, 'paired tablet', viewport, theme);
    const shot = snap(page);
    const code = await newPairingCode(api, fx.deviceId);
    await pairBrowser(page, c.base, code, () => shot('device-pair-confirm'));
    await tabletStates({ page, context, base: c.base, api, fx, pins, snap: shot } as Run);
  } finally {
    await context.close();
  }
}

let bridgeRuns = 0;

/** The native bridge (W82): settle, drop and a late band, with a fake app host. */
async function bridge(
  c: Ctx,
  api: ScanApi,
  fx: ScanFixtures,
  viewport: ViewportName,
  theme: Theme,
) {
  // The seed scanned the first passes of the door's template: take later ones, so the reads are check-ins.
  const first = (await api.get(`/api/v1/passes?orgId=${fx.orgId}&limit=1&status=active`)).items[0];
  const pool = await passCodes(api, fx.orgId, 50, first.templateId);
  const end = pool.length - bridgeRuns * 2;
  const codes = pool.slice(end - 2, end);
  bridgeRuns += 1;
  for (const role of ['door', 'desk'] as const) {
    const context = await newContext(c, viewport, theme);
    try {
      const page = await context.newPage();
      const { snap } = recorder(c, context, `native bridge ${role}`, viewport, theme);
      await api.send('PATCH', `/api/v1/scanning-sessions/${fx.sessionId}`, {
        settings: { roleWithoutSignIn: role, staffSignIn: false },
      });
      await installFakeApp(page);
      await pairBrowser(page, c.base, await newPairingCode(api, fx.deviceId));
      const run = {
        page,
        context,
        base: c.base,
        api,
        fx,
        pins: new Map(),
        snap: snap(page),
      } as Run;
      await (role === 'door' ? doorBridgeStates(run, codes) : deskBridgeStates(run, codes));
    } finally {
      await context.close();
    }
  }
}

async function monitor(
  c: Ctx,
  api: ScanApi,
  fx: ScanFixtures,
  viewport: ViewportName,
  theme: Theme,
) {
  const context = await newContext(c, viewport, theme);
  try {
    const page = await context.newPage();
    const { snap } = recorder(c, context, 'paired monitor', viewport, theme);
    await pairBrowser(page, c.base, await newPairingCode(api, fx.monitorId));
    await page.waitForLoadState('networkidle', { timeout: 8_000 }).catch(() => undefined);
    await page.waitForTimeout(1_500);
    await snap(page)('device-monitor');
  } finally {
    await context.close();
  }
}

/** Harbor's Gate A as a desk: the event is a counted place, so Who's in is offered. */
async function eventDesk(
  c: Ctx,
  api: ScanApi,
  fx: ScanFixtures,
  viewport: ViewportName,
  theme: Theme,
) {
  const context = await newContext(c, viewport, theme);
  try {
    const page = await context.newPage();
    const { snap } = recorder(c, context, 'paired event desk', viewport, theme);
    await api.send('PATCH', `/api/v1/scan-setups/${fx.gate.id}`, {
      settings: { roleWithoutSignIn: 'desk' },
    });
    await pairBrowser(page, c.base, await newPairingCode(api, fx.gate.id));
    await eventDeskStates({
      page,
      context,
      base: c.base,
      api,
      fx,
      pins: new Map(),
      snap: snap(page),
    });
  } finally {
    await context.close();
  }
}

/** `/scan?customer-display=1` is the native second screen: the app's bridge feeds it a status. */
async function customerDisplay(c: Ctx, viewport: ViewportName, theme: Theme) {
  for (const status of DISPLAY_STATES) {
    const context = await c.browser.newContext({
      viewport: SIZES[viewport],
      colorScheme: theme,
      reducedMotion: 'reduce',
    });
    try {
      await context.addCookies([{ name: 'wallet-theme', value: theme, url: c.base }]);
      await context.addInitScript((s) => {
        (window as unknown as Record<string, unknown>).PassBookCustomerDisplay = {
          status: s,
          revision: 1,
          branding: { name: 'Northwind Climbing', accent: '#2563eb', logoSha: null },
          onmessage: null,
        };
      }, status);
      const page = await context.newPage();
      const { snap } = recorder(c, context, 'customer display', viewport, theme);
      await page.goto(`${c.base}/scan?customer-display=1`, { waitUntil: 'load' });
      await page.waitForTimeout(700);
      await snap(page)(`customer-display-${status}`);
    } finally {
      await context.close();
    }
  }
  const context = await c.browser.newContext({
    viewport: SIZES[viewport],
    colorScheme: theme,
    reducedMotion: 'reduce',
  });
  try {
    const page = await context.newPage();
    const { snap } = recorder(c, context, 'customer display', viewport, theme);
    await page.goto(`${c.base}/scan?customer-display=1`, { waitUntil: 'load' });
    await page.waitForTimeout(700);
    await snap(page)('customer-display-no-bridge');
  } finally {
    await context.close();
  }
}

async function main() {
  const base = assertLocal(arg('--url') ?? 'http://localhost:5173');
  const out = resolve(root, arg('--out') ?? '.wrangler/visual-sweep/scanning');
  if (!out.startsWith(`${resolve(root, '.wrangler')}/`))
    throw new Error('--out must be inside .wrangler/.');
  mkdirSync(out, { recursive: true });
  const stateDir = resolve(root, '.wrangler/visual-sweep/state');
  const orgCtx = await contextFor(base, stateDir, 'org');
  const api = await scanApi(orgCtx);
  const platform = await contextFor(base, stateDir, 'platform');
  const orgs = (
    (await (await platform.get('/api/v1/orgs')).json()) as { items: { id: string; slug: string }[] }
  ).items;
  const northwind = orgs.find((o) => o.slug === 'northwind');
  if (!northwind) throw new Error('No northwind org: run tools/seed-demo.ts.');
  const harbor = orgs.find((o) => o.slug === 'harbor-lights');
  if (!harbor) throw new Error('No harbor-lights org: run tools/seed-demo.ts.');
  const fx = await findFixtures(api, northwind.id, harbor.id);
  for (const [name, scanner, org] of [
    ['Front door', fx.deviceId, fx.orgId],
    ['Gate A', fx.gate.id, fx.gate.orgId],
  ] as const)
    console.log(
      `scans, ${name}: ${await seedScans(base, api, scanner, org, 6).catch((e) => `skipped, ${(e as Error).message}`)}`,
    );
  const pins = new Map<string, string>();
  for (const s of fx.staff) pins.set(s.id, await resetPin(api, fx.orgId, s.id));

  const browser = await chromium.launch({
    args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'],
  });
  const c: Ctx = { browser, base, out, shots: [] };
  const themes: Theme[] = has('--themes')
    ? (arg('--themes')?.split(',') as Theme[])
    : ['light', 'dark'];
  const picked = has('--viewports') ? arg('--viewports')?.split(',') : undefined;
  const only = (v: ViewportName) => !picked || picked.includes(v);
  try {
    for (const theme of themes) {
      for (const viewport of DEVICE_VIEWPORTS.filter(only)) {
        if (has('--bridge-only')) {
          await bridge(c, api, fx, viewport, theme);
          continue;
        }
        await pairedDevice(c, api, fx, pins, viewport, theme);
        await bridge(c, api, fx, viewport, theme);
        await monitor(c, api, fx, viewport, theme);
        await eventDesk(c, api, fx, viewport, theme);
      }
      if (has('--bridge-only')) continue;
      for (const viewport of DISPLAY_VIEWPORTS.filter(only))
        await customerDisplay(c, viewport, theme);
    }
  } finally {
    await browser.close();
    writeFileSync(resolve(out, 'index-devices.json'), `${JSON.stringify(c.shots, null, 2)}\n`);
  }
  const noisy = c.shots.filter((s) => s.consoleErrors.length || s.failedRequests.length).length;
  console.log(`${c.shots.length} screenshots, ${noisy} with console/request errors -> ${out}`);
}

main().catch((error) => {
  console.error((error as Error).message);
  process.exit(1);
});
