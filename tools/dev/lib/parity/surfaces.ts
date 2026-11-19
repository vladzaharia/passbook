// Our own renders of the issued pass: web pages via the sweep harness, the delivery email, and the
// designer's scan screen. Text next to each screenshot feeds the field comparison.
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { chromium } from '@playwright/test';
import { statePath } from '../auth.ts';
import { capture, type Shot } from '../capture.ts';
import { type Route, SIZES, shotName, type Theme, type ViewportName } from '../routes.ts';
import type { Api } from './issue.ts';

export const SHOT_VIEWPORTS: ViewportName[] = ['mobile', 'desktop'];
export const SHOT_THEMES: Theme[] = ['light', 'dark'];

const WEB: Route[] = [
  { role: 'org', path: '/admin/passes/{passId}', name: 'admin' },
  { role: 'org', path: '/admin/templates/{templateId}/design', name: 'designer' },
  { role: 'holder', path: '/passes/{myPassId}', name: 'portal' },
  { role: 'anon', path: '/p/{passToken}', name: 'hosted' },
];

export type Ids = {
  orgId: string;
  passId: string;
  templateId: string;
  passToken: string;
  myPassId?: string;
};

/** The holder's own id for the pass, from their pass list. */
export async function myPassIdOf(
  holder: { get(path: string): Promise<{ ok(): boolean; json(): Promise<unknown> }> },
  passId: string,
): Promise<string | undefined> {
  const res = await holder.get('/api/v1/me/passes?limit=200');
  if (!res.ok()) return undefined;
  const items = ((await res.json()) as { items: { id: string }[] }).items;
  return items.find((p) => p.id === passId)?.id;
}

export async function captureWeb(
  base: string,
  stateDir: string,
  out: string,
  ids: Ids,
): Promise<Shot[]> {
  return capture(
    {
      base,
      out,
      stateDir,
      viewports: SHOT_VIEWPORTS,
      themes: SHOT_THEMES,
      values: ids,
      text: true,
    },
    WEB,
  );
}

export const textOf = (dir: string, name: string): string | null => {
  const file = resolve(dir, shotName(name, 'desktop', 'light').replace(/\.png$/, '.txt'));
  return existsSync(file) ? readFileSync(file, 'utf8') : null;
};

/** The newest dev-mail HTML that links to this pass, searched in every miniflare temp dir. */
function mailFor(token: string, since: number): string | null {
  let best: { html: string; at: number } | null = null;
  for (const dir of readdirSync(tmpdir())) {
    const folder = join(tmpdir(), dir, 'email', 'email-html');
    if (!dir.startsWith('miniflare-') || !existsSync(folder)) continue;
    for (const f of readdirSync(folder)) {
      const file = join(folder, f);
      const at = statSync(file).mtimeMs;
      if (at < since || at < (best?.at ?? 0)) continue;
      const html = readFileSync(file, 'utf8');
      if (html.includes(token)) best = { html, at };
    }
  }
  return best?.html ?? null;
}

/** Sends the pass email through the API and renders the dev-mail file. */
export async function captureEmail(
  api: Api,
  out: string,
  passId: string,
  token: string,
  to: string,
): Promise<{ shots: Shot[]; note: string }> {
  const since = Date.now() - 1_000;
  try {
    await api.post(`/api/v1/passes/${passId}/resend-email`, { to });
  } catch (e) {
    return { shots: [], note: `resend-email failed: ${(e as Error).message.slice(0, 160)}` };
  }
  let html: string | null = null;
  for (let i = 0; i < 30 && !html; i++) {
    html = mailFor(token, since);
    if (!html) await new Promise((r) => setTimeout(r, 500));
  }
  if (!html) return { shots: [], note: 'no dev-mail file for the pass within 15 s' };
  writeFileSync(resolve(out, 'email.html'), html);
  const shots: Shot[] = [];
  const browser = await chromium.launch();
  try {
    for (const theme of SHOT_THEMES) {
      for (const viewport of SHOT_VIEWPORTS) {
        const context = await browser.newContext({
          viewport: SIZES[viewport],
          colorScheme: theme,
        });
        const page = await context.newPage();
        await page.setContent(html, { waitUntil: 'load' });
        const file = shotName('email', viewport, theme);
        await page.screenshot({ path: resolve(out, file), fullPage: true });
        if (viewport === 'desktop' && theme === 'light') {
          writeFileSync(
            resolve(out, file.replace(/\.png$/, '.txt')),
            // biome-ignore lint/performance/useDomNodeTextContent: visible text only
            await page.evaluate(() => document.body.innerText),
          );
        }
        shots.push({
          route: 'mail',
          name: 'email',
          role: 'anon',
          viewport,
          theme,
          file,
          status: 200,
          consoleErrors: [],
          failedRequests: [],
        });
        await context.close();
      }
    }
  } finally {
    await browser.close();
  }
  return { shots, note: 'dev-mail html rendered' };
}

/** The designer's Scan screen mode: the template's scan display preview. */
export async function captureScan(
  base: string,
  stateDir: string,
  out: string,
  ids: Ids,
): Promise<Shot[]> {
  const shots: Shot[] = [];
  const browser = await chromium.launch();
  try {
    for (const theme of SHOT_THEMES) {
      const viewport: ViewportName = 'desktop';
      const context = await browser.newContext({
        viewport: SIZES[viewport],
        colorScheme: theme,
        reducedMotion: 'reduce',
        storageState: statePath(stateDir, 'org'),
      });
      await context.addCookies([{ name: 'wallet-theme', value: theme, url: base }]);
      await context.addInitScript((id) => localStorage.setItem('wallet-org-filter', id), ids.orgId);
      const page = await context.newPage();
      const file = shotName('scanner', viewport, theme);
      let note: string | undefined;
      try {
        await page.goto(`${base}/admin/templates/${encodeURIComponent(ids.templateId)}/design`, {
          waitUntil: 'load',
          timeout: 30_000,
        });
        await page.getByText('Scan screen', { exact: true }).first().click({ timeout: 15_000 });
        await page.waitForLoadState('networkidle', { timeout: 15_000 }).catch(() => {});
        await page.waitForTimeout(800);
        await page.screenshot({ path: resolve(out, file), fullPage: true });
        if (theme === 'light') {
          writeFileSync(
            resolve(out, file.replace(/\.png$/, '.txt')),
            // biome-ignore lint/performance/useDomNodeTextContent: visible text only
            await page.evaluate(() => document.body.innerText),
          );
        }
      } catch (e) {
        note = `scan mode failed: ${(e as Error).message.split('\n')[0]}`;
      }
      shots.push({
        route: 'designer scan mode',
        name: 'scanner',
        role: 'org',
        viewport,
        theme,
        file: note ? null : file,
        status: null,
        consoleErrors: [],
        failedRequests: [],
        ...(note ? { note } : {}),
      });
      await context.close();
    }
  } finally {
    await browser.close();
  }
  return shots;
}

export const ensureDir = (dir: string): string => {
  mkdirSync(dir, { recursive: true });
  return dir;
};
