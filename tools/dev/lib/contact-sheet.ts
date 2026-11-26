// One PNG per route with every viewport and theme panel side by side and labelled, so a reviewer
// opens one image per route instead of six. Rows are themes, columns are viewports.
import { mkdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { type Browser, chromium } from '@playwright/test';
import type { Shot } from './capture.ts';
import { SIZES, type ViewportName } from './routes.ts';

/** Panels are drawn at this share of the real size; a taller page is cut at `MAX_PANEL_HEIGHT`. */
const SCALE = 0.4;
const MAX_PANEL_HEIGHT = 1800;
const ORDER = ['desktop', 'tablet', 'mobile', 'tabletLandscape', 'tv'];
const esc = (s: string) => s.replace(/[&<>"]/g, (c) => `&#${c.charCodeAt(0)};`);

type Panel = { shot: Shot; data: string };

function sheetHtml(name: string, panels: Panel[]): string {
  const viewports = [...new Set(panels.map((p) => p.shot.viewport))].sort(
    (a, b) => ORDER.indexOf(a) - ORDER.indexOf(b),
  );
  const themes = [...new Set(panels.map((p) => p.shot.theme))].sort();
  const cell = (viewport: string, theme: string) => {
    const panel = panels.find((p) => p.shot.viewport === viewport && p.shot.theme === theme);
    const size = SIZES[viewport as ViewportName];
    const label = `${name} | ${viewport} ${size ? `${size.width}px` : ''} | ${theme}`;
    if (!panel) return `<figure><figcaption>${esc(label)}: not captured</figcaption></figure>`;
    const note = panel.shot.note ? ` | ${panel.shot.note}` : '';
    const width = size ? Math.round(size.width * SCALE) : 0;
    return `<figure><figcaption>${esc(label + note)}</figcaption><div class="p" style="width:${width}px"><img src="data:image/png;base64,${panel.data}" style="width:${width}px"></div></figure>`;
  };
  const rows = themes
    .map((t) => `<div class="row">${viewports.map((v) => cell(v, t)).join('')}</div>`)
    .join('');
  return `<!doctype html><meta charset="utf-8"><style>
body{margin:0;padding:16px;background:#e5e7eb;font:13px/1.3 system-ui,sans-serif;color:#111;display:inline-block}
.row{display:flex;gap:16px;align-items:flex-start;margin-bottom:16px}
figure{margin:0}figcaption{font-weight:600;margin-bottom:4px;white-space:nowrap}
.p{max-height:${MAX_PANEL_HEIGHT}px;overflow:hidden;border:1px solid #9ca3af;background:#fff}
img{display:block}</style>${rows}`;
}

/** Writes `<out>/sheets/<route>.png` for every route that has at least one screenshot. */
export async function writeContactSheets(
  out: string,
  shots: Shot[],
  browser?: Browser,
): Promise<number> {
  const byRoute = new Map<string, Shot[]>();
  for (const s of shots) if (s.file) byRoute.set(s.name, [...(byRoute.get(s.name) ?? []), s]);
  if (byRoute.size === 0) return 0;
  mkdirSync(resolve(out, 'sheets'), { recursive: true });
  const own = browser ?? (await chromium.launch());
  try {
    for (const [name, list] of byRoute) {
      const panels = list.map((shot) => ({
        shot,
        data: readFileSync(resolve(out, shot.file as string)).toString('base64'),
      }));
      const page = await own.newPage({ viewport: { width: 400, height: 400 } });
      await page.setContent(sheetHtml(name, panels), { waitUntil: 'load' });
      await page.screenshot({ path: resolve(out, 'sheets', `${name}.png`), fullPage: true });
      await page.close();
    }
  } finally {
    if (!browser) await own.close();
  }
  return byRoute.size;
}
