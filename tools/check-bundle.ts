// Runs after `vite build`: the initial load (entry plus modulepreloads) stays under budget and
// carries no admin-only library.
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { gzipSync } from 'node:zlib';

const root = resolve(import.meta.dirname, '..');
const dist = join(root, 'dist/client');

/** Console entry: 217.9 kB measured (tooltip loads after first paint); the account menu and its Radix chunks load after first paint.
 * Scanning pages, pass inspection, tables and search controls remain lazy. */
export const BUDGET_BYTES = 235_000;
/** The scanner's initial load (scan.html), in gzip bytes. */
export const SCAN_BUDGET_BYTES = 150_000;
/**
 * The developer portal's initial load (developers.html), scripts and stylesheets, in gzip bytes.
 * The pages are prerendered, so this is only the enhancement script and the page CSS; the console,
 * playground and tester are lazy chunks.
 */
export const DEV_BUDGET_BYTES = 60_000;
/** Literal strings: this check matches text, so an identifier would not survive minification. */
export const FORBIDDEN = [
  'cmdk-',
  'getRowModel',
  'measureElement',
  'scan-display:render',
  'SCAN_DISPLAY_DENSITY',
] as const;
/** The scan entry also never pulls the SPA router tree or the e2e hook. */
export const SCAN_FORBIDDEN = [...FORBIDDEN, 'routeTree', '__passbookScan'] as const;
/** The portal never pulls the SPA's router tree either. */
export const DEV_FORBIDDEN = [...FORBIDDEN, 'routeTree'] as const;

export function initialAssets(html: string, stylesheets = false): string[] {
  const urls = [
    ...html.matchAll(/<script[^>]*type="module"[^>]*src="([^"]+)"/g),
    ...html.matchAll(/<link[^>]*rel="modulepreload"[^>]*href="([^"]+)"/g),
    ...(stylesheets ? html.matchAll(/<link[^>]*rel="stylesheet"[^>]*href="([^"]+)"/g) : []),
  ].map((m) => m[1] ?? '');
  return urls.filter(Boolean);
}

export function checkBundle(
  read: (url: string) => string,
  html: string,
  budget: number,
  forbidden: readonly string[] = FORBIDDEN,
  stylesheets = false,
): { total: number; errors: string[] } {
  const errors: string[] = [];
  let total = 0;
  for (const url of initialAssets(html, stylesheets)) {
    const body = read(url);
    total += gzipSync(body).length;
    for (const marker of forbidden) {
      if (body.includes(marker)) errors.push(`${url} contains ${marker}`);
    }
  }
  if (budget > 0 && total > budget)
    errors.push(`initial gzip ${total} B exceeds budget ${budget} B`);
  return { total, errors };
}

if (import.meta.main) {
  const runs = [
    { name: 'initial', page: 'index.html', budget: BUDGET_BYTES, forbidden: FORBIDDEN },
    {
      name: 'scan initial',
      page: 'scan.html',
      budget: SCAN_BUDGET_BYTES,
      forbidden: SCAN_FORBIDDEN,
    },
    {
      name: 'developers initial',
      page: 'developers.html',
      budget: DEV_BUDGET_BYTES,
      forbidden: DEV_FORBIDDEN,
      stylesheets: true,
    },
  ];
  let failed = false;
  for (const run of runs) {
    const html = readFileSync(join(dist, run.page), 'utf8');
    const { total, errors } = checkBundle(
      (url) => readFileSync(join(dist, url.replace(/^\//, '')), 'utf8'),
      html,
      run.budget,
      run.forbidden,
      'stylesheets' in run,
    );
    process.stdout.write(`${run.name} gzip: ${total} B\n`);
    if (errors.length > 0) {
      process.stderr.write(`${errors.join('\n')}\n`);
      failed = true;
    }
  }
  if (failed) process.exit(1);
}
