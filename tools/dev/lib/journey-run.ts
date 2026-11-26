// Runs a journey: each step once (side effects), then a screenshot per viewport and theme.

import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { type Browser, type BrowserContext, chromium, devices, type Page } from '@playwright/test';
import { statePath } from './auth.ts';
import { listen, redact } from './capture.ts';
import {
  type Journey,
  type PageView,
  renderIndex,
  type StepResult,
  stepFile,
  stepStem,
  type View,
} from './journey.ts';
import type { JourneyEnv } from './journey-env.ts';
import { type Theme, VIEWPORTS, type ViewportName } from './routes.ts';
import { settle as settleAnimations } from './settle.ts';

type Options = {
  base: string;
  out: string;
  stateDir: string;
  viewports: ViewportName[];
  themes: Theme[];
};

/** 390 is an iPhone (touch, mobile UA); 820 an iPad; 1440 a plain desktop. */
function emulation(viewport: ViewportName) {
  if (viewport === 'mobile')
    return {
      viewport: VIEWPORTS.mobile,
      userAgent: devices['iPhone 14']?.userAgent as string,
      deviceScaleFactor: 2,
      isMobile: true,
      hasTouch: true,
    };
  if (viewport === 'tablet')
    return {
      viewport: VIEWPORTS.tablet,
      userAgent: devices['iPad (gen 7)']?.userAgent as string,
      deviceScaleFactor: 2,
      hasTouch: true,
    };
  return { viewport: VIEWPORTS.desktop };
}

const TURNSTILE_STUB = `window.turnstile={render:function(_,o){setTimeout(function(){o.callback('XXXX.DUMMY.TOKEN.XXXX')},20);return 'stub'},reset:function(){},remove:function(){}};`;

const SETTLE = '[aria-busy="true"], .wl-skeleton';

async function settle(page: Page, note: string[]) {
  await page.waitForLoadState('networkidle', { timeout: 15_000 }).catch(() => {
    note.push('network never went idle');
  });
  await page
    .waitForFunction((sel) => !document.querySelector(sel), SETTLE, { timeout: 10_000 })
    .catch(() => {
      note.push('skeleton still showing');
    });
  // A sheet or dialog that just opened is still sliding or fading in: shoot it at rest.
  await settleAnimations(page);
}

export async function runJourney(
  journey: Journey,
  env: JourneyEnv,
  o: Options,
): Promise<StepResult[]> {
  const out = resolve(o.out, journey.name);
  mkdirSync(out, { recursive: true });
  const browser = await chromium.launch();
  const contexts = new Map<string, Promise<BrowserContext>>();
  const contextFor = (view: View, viewport: ViewportName, theme: Theme) => {
    const who =
      view.kind === 'html'
        ? 'html'
        : `${view.storage ?? view.role}${view.mode ?? ''}${view.orgId ?? ''}`;
    const key = `${who}|${viewport}|${theme}`;
    if (!contexts.has(key)) {
      contexts.set(key, newContext(browser, o, env, view, viewport, theme));
    }
    return contexts.get(key) as Promise<BrowserContext>;
  };
  const results: StepResult[] = [];
  try {
    for (const [index, step] of journey.steps.entries()) {
      const result: StepResult = {
        index,
        title: step.title,
        stem: stepStem(index, step.title),
        where: '',
        files: {},
        consoleErrors: [],
        failedRequests: [],
      };
      results.push(result);
      let view: View | { skip: string };
      try {
        view = await step.run(env);
      } catch (error) {
        result.note = `step failed: ${(error as Error).message.split('\n')[0]}`;
        continue;
      }
      if ('skip' in view) {
        result.note = `skipped: ${view.skip}`;
        continue;
      }
      result.where = view.kind === 'html' ? 'mail' : redact(view.path);
      for (const theme of o.themes) {
        for (const viewport of o.viewports) {
          const context = await contextFor(view, viewport, theme);
          const page = await context.newPage();
          const heard = listen(page);
          const notes: string[] = [];
          try {
            if (view.kind === 'html') await page.setContent(view.html, { waitUntil: 'load' });
            else await visit(page, o.base, view, notes);
            const file = stepFile(index, step.title, viewport, theme);
            // A dialog or sheet is fixed to the viewport: a full-page shot would cut it off.
            const modal = (await page.locator('[role=dialog]').count()) > 0;
            await page.screenshot({ path: resolve(out, file), fullPage: !modal });
            result.files[`${viewport}-${theme}`] = file;
          } catch (error) {
            notes.push(`capture failed: ${(error as Error).message.split('\n')[0]}`);
          }
          result.consoleErrors.push(...heard.consoleErrors.map((e) => `${viewport}/${theme} ${e}`));
          result.failedRequests.push(
            ...heard.failedRequests.map((e) => `${viewport}/${theme} ${e}`),
          );
          const fresh = notes.filter((n) => !result.note?.includes(n));
          if (fresh.length) result.note = [result.note, ...fresh].filter(Boolean).join('; ');
          await page.close();
        }
      }
    }
  } finally {
    for (const c of contexts.values()) await (await c).close().catch(() => undefined);
    await browser.close();
    await env.cleanup();
    writeFileSync(resolve(out, 'index.json'), `${JSON.stringify(results, null, 2)}\n`);
    writeFileSync(resolve(out, 'index.html'), renderIndex(journey, results, o.viewports, o.themes));
  }
  return results;
}

async function newContext(
  browser: Browser,
  o: Options,
  env: JourneyEnv,
  view: View,
  viewport: ViewportName,
  theme: Theme,
): Promise<BrowserContext> {
  const role = view.kind === 'html' ? 'anon' : view.role;
  // Signs the role in (and saves its state) the first time a journey needs it.
  if (role !== 'anon' && !(view.kind === 'page' && view.storage)) await env.api(role);
  const storage =
    view.kind === 'page'
      ? (view.storage ?? (role === 'anon' ? undefined : statePath(o.stateDir, role)))
      : undefined;
  const context = await browser.newContext({
    ...emulation(viewport),
    colorScheme: theme,
    reducedMotion: 'reduce',
    ...(storage ? { storageState: storage } : {}),
  });
  // Nothing outside the dev server is wanted. Turnstile is the one script pages ask for: a stub
  // answers every challenge with Cloudflare's always-pass test token so forms can be submitted.
  const origin = new URL(o.base).origin;
  await context.route(
    (url) => !['data:', 'blob:', 'about:'].includes(url.protocol) && url.origin !== origin,
    (route) =>
      route.request().url().startsWith('https://challenges.cloudflare.com/')
        ? route.fulfill({ contentType: 'text/javascript', body: TURNSTILE_STUB })
        : route.abort('aborted'),
  );
  await context.addCookies([{ name: 'wallet-theme', value: theme, url: o.base }]);
  if (view.kind === 'page' && view.mode === 'test')
    await context.addInitScript(() => localStorage.setItem('passbook-mode', 'test'));
  if (role === 'org' || role === 'platform') {
    await context.addInitScript(
      (id) => localStorage.setItem('wallet-org-filter', id),
      (view.kind === 'page' && view.orgId) || env.orgId,
    );
  }
  return context;
}

async function visit(page: Page, base: string, view: PageView, notes: string[]) {
  page.setDefaultTimeout(6_000);
  const res = await page.goto(`${base}${view.path}`, { waitUntil: 'load', timeout: 30_000 });
  await settle(page, notes);
  if (view.waitFor)
    await page.waitForSelector(view.waitFor, { timeout: 10_000 }).catch(() => {
      notes.push(`waitFor ${view.waitFor} not found`);
    });
  if (view.prepare) {
    await view.prepare(page).catch((error: Error) => {
      notes.push(`prepare failed: ${error.message.split('\n')[0]}`);
    });
    await settle(page, notes);
  }
  const status = res?.status() ?? null;
  if (status !== null && status >= 400) notes.push(`HTTP ${status}`);
}
