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
/**
 * The Try it island, everything its loader pulls (React, the console, its stylesheet), in gzip
 * bytes: 88.3 kB measured. It loads only for a signed-in visitor, so it sits outside the 60 kB.
 */
export const DEV_ISLAND_BUDGET_BYTES = 95_000;
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

/**
 * The files a lazy island pulls: its loader chunk and the `__vite__mapDeps` list Vite writes into
 * it. `entry` is the developers script; `name` the island loader's file prefix (`run-entry`).
 */
export function islandAssets(read: (url: string) => string, entry: string, name: string): string[] {
  const loader = new RegExp(`/assets/${name}-[\\w-]+\\.js`).exec(withAssetDir(read(entry)))?.[0];
  if (!loader) return [];
  const deps = /m\.f=(\[[^\]]*\])/.exec(read(loader))?.[1];
  const list = deps ? (JSON.parse(deps) as string[]).map((d) => `/${d}`) : [];
  return [loader, ...list];
}

const withAssetDir = (js: string): string => js.replace(/\.\//g, '/assets/');

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
  const devEntry = initialAssets(readFileSync(join(dist, 'developers.html'), 'utf8'))[0] ?? '';
  const island = islandAssets(
    (url) => readFileSync(join(dist, url.replace(/^\//, '')), 'utf8'),
    devEntry,
    'run-entry',
  );
  const initial = new Set(initialAssets(readFileSync(join(dist, 'developers.html'), 'utf8'), true));
  const islandOnly = island.filter((u) => !initial.has(u));
  let islandTotal = 0;
  for (const url of islandOnly) {
    const body = readFileSync(join(dist, url.replace(/^\//, '')), 'utf8');
    islandTotal += gzipSync(body).length;
    for (const marker of DEV_FORBIDDEN)
      if (body.includes(marker)) {
        process.stderr.write(`${url} contains ${marker}\n`);
        failed = true;
      }
  }
  process.stdout.write(
    `developers run island gzip: ${islandTotal} B (${islandOnly.length} files)\n`,
  );
  if (islandOnly.length === 0) {
    process.stderr.write('developers run island: no chunk found\n');
    failed = true;
  }
  if (islandTotal > DEV_ISLAND_BUDGET_BYTES) {
    process.stderr.write(
      `developers run island ${islandTotal} B exceeds budget ${DEV_ISLAND_BUDGET_BYTES} B\n`,
    );
    failed = true;
  }
  if (failed) process.exit(1);
}
