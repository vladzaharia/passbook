// Runs after `vite build`: the initial load (entry plus modulepreloads) stays under budget and
// carries no admin-only library.
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { gzipSync } from 'node:zlib';

const root = resolve(import.meta.dirname, '..');
const dist = join(root, 'dist/client');

/** Initial gzip bytes measured after the admin-only libraries left the entry (217,649), plus 5%, plus wave 2 (Test mode, Messages). */
export const BUDGET_BYTES = 232_500;
/** The scanner's initial load (scan.html), in gzip bytes. */
export const SCAN_BUDGET_BYTES = 150_000;
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

export function initialAssets(html: string): string[] {
  const urls = [
    ...html.matchAll(/<script[^>]*type="module"[^>]*src="([^"]+)"/g),
    ...html.matchAll(/<link[^>]*rel="modulepreload"[^>]*href="([^"]+)"/g),
  ].map((m) => m[1] ?? '');
  return urls.filter(Boolean);
}

export function checkBundle(
  read: (url: string) => string,
  html: string,
  budget: number,
  forbidden: readonly string[] = FORBIDDEN,
): { total: number; errors: string[] } {
  const errors: string[] = [];
  let total = 0;
  for (const url of initialAssets(html)) {
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
  ];
  let failed = false;
  for (const run of runs) {
    const html = readFileSync(join(dist, run.page), 'utf8');
    const { total, errors } = checkBundle(
      (url) => readFileSync(join(dist, url.replace(/^\//, '')), 'utf8'),
      html,
      run.budget,
      run.forbidden,
    );
    process.stdout.write(`${run.name} gzip: ${total} B\n`);
    if (errors.length > 0) {
      process.stderr.write(`${errors.join('\n')}\n`);
      failed = true;
    }
  }
  if (failed) process.exit(1);
}
