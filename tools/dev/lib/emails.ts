// Renders the latest dev-mail HTML of each kind (grouped by <title>) to PNG.
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { chromium } from '@playwright/test';
import type { Shot } from './capture.ts';
import { shotName, type Theme, VIEWPORTS, type ViewportName } from './routes.ts';

type Mail = { kind: string; html: string; mtime: number };

/** Newest mail per <title> that links to this server (the temp mail dir is shared by every dev server). */
export function latestMailByKind(base: string): Mail[] {
  const byKind = new Map<string, Mail>();
  for (const dir of readdirSync(tmpdir())) {
    const folder = join(tmpdir(), dir, 'email', 'email-html');
    if (!dir.startsWith('miniflare-') || !existsSync(folder)) continue;
    for (const f of readdirSync(folder)) {
      const file = join(folder, f);
      const mtime = statSync(file).mtimeMs;
      if (Date.now() - mtime > 24 * 3_600_000) continue;
      const html = readFileSync(file, 'utf8');
      const kind = /<title>([^<]*)<\/title>/.exec(html)?.[1]?.trim();
      if (!kind) continue;
      if (!html.includes(`${base}/`)) continue;
      const mail = { kind, html, mtime };
      if (mail.mtime > (byKind.get(kind)?.mtime ?? 0)) byKind.set(kind, mail);
    }
  }
  return [...byKind.values()];
}

export async function captureEmails(o: {
  base: string;
  out: string;
  viewports: ViewportName[];
  themes: Theme[];
  only?: string;
}): Promise<Shot[]> {
  const mails = latestMailByKind(o.base).filter(
    (m) => !o.only || `email-${m.kind}`.toLowerCase().includes(o.only.toLowerCase()),
  );
  if (mails.length === 0) return [];
  const browser = await chromium.launch();
  const shots: Shot[] = [];
  try {
    for (const theme of o.themes) {
      for (const viewport of o.viewports) {
        const context = await browser.newContext({
          viewport: VIEWPORTS[viewport],
          colorScheme: theme,
        });
        for (const mail of mails) {
          const name = `email-${mail.kind}`;
          const file = shotName(name, viewport, theme);
          const page = await context.newPage();
          await page.setContent(mail.html, { waitUntil: 'load' });
          await page.screenshot({ path: resolve(o.out, file), fullPage: true });
          await page.close();
          shots.push({
            route: `mail:${mail.kind}`,
            name,
            role: 'anon',
            viewport,
            theme,
            file,
            status: 200,
            consoleErrors: [],
            failedRequests: [],
          });
        }
        await context.close();
      }
    }
  } finally {
    await browser.close();
  }
  return shots;
}
