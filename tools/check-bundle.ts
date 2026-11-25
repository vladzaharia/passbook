// Runs after `vite build`: the initial load (entry plus modulepreloads) stays under budget and
// carries no admin-only library, and the Worker carries no e2e provider release.
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { gzipSync } from 'node:zlib';
import { e2eReleaseProblems } from './lib/e2e-release.ts';

const root = resolve(import.meta.dirname, '..');
const dist = join(root, 'dist/client');

/** Console entry: 184.8 kB measured (tooltip loads after first paint); the account menu and its Radix chunks load after first paint.
 * Scanning pages, pass inspection, tables and search controls remain lazy. Route search schemas import
 * only light contract files (pass-list-status.ts), never the pass, scan or template contracts. */
export const BUDGET_BYTES = 230_000;
/** The scanner's initial load (scan.html), in gzip bytes: 135.1 kB measured. The session and native-capability
 * schemas load on demand (they pull most of the contracts): keep new static imports of contracts out of /scan. */
export const SCAN_BUDGET_BYTES = 140_000;
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
/**
 * The ⌘K search island (palette, kit dialog, cmdk, React): loads on the first ⌘K or click of the
 * search button, so it sits outside the 60 kB: 130 kB measured, of which React and Radix are 90 kB
 * (shared with every other island). The index it fetches has its own 150 kB budget
 * (src/web/developers/search/build.ts).
 */
export const DEV_SEARCH_BUDGET_BYTES = 135_000;
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

/**
 * The playground island: what it loads on top of the portal's initial load (its entry, the page it
 * opens, their static imports and styles), in gzip bytes. The wallet compilers and the barcode
 * encoder are dynamic imports and stay out; react, the card renderers and the kit pieces are in.
 * 197 kB measured.
 */
export const PLAYGROUND_BUDGET_BYTES = 215_000;

/**
 * The quickstart island, on top of the portal's initial load: React, the steps, and the playground's card renderers
 * and compilers' loader (the barcode encoder and the wallet compilers stay lazy). Signed-in visitors only. 197 kB measured: the cards carry FacePair and FitBox (Front / Back, whole paper).
 */
export const QUICKSTART_BUDGET_BYTES = 198_000;

export function initialAssets(html: string, stylesheets = false): string[] {
  const urls = [
    ...html.matchAll(/<script[^>]*type="module"[^>]*src="([^"]+)"/g),
    ...html.matchAll(/<link[^>]*rel="modulepreload"[^>]*href="([^"]+)"/g),
    ...(stylesheets ? html.matchAll(/<link[^>]*rel="stylesheet"[^>]*href="([^"]+)"/g) : []),
  ].map((m) => m[1] ?? '');
  return urls.filter(Boolean);
}

/**
 * The files a lazy island pulls on top of the initial load: its loader chunk (`name-<hash>.js`,
 * named in one of the initial scripts) and the `__vite__mapDeps` list Vite writes into it. `read`
 * takes `/assets/x.js` style urls.
 */
export function islandAssets(
  read: (url: string) => string,
  initial: readonly string[],
  name: string,
): string[] {
  const loader = new RegExp(`(?:^|[/"'])(${name}-[\\w-]+\\.js)`);
  const entry = initial.map((url) => loader.exec(read(url))?.[1]).find((file) => file);
  if (!entry) return [];
  const url = `/assets/${entry}`;
  const list = /m\.f=(\[[^\]]*\])/.exec(read(url))?.[1];
  const deps = list ? (JSON.parse(list) as string[]).map((d) => `/${d}`) : [];
  const skip = new Set(initial);
  return [...new Set([url, ...deps])].filter((u) => !skip.has(u));
}

/**
 * An island that has no dynamic imports of its own: its chunk, the shared chunks it imports
 * statically (read from the minified `from"./x.js"`), and its stylesheet, which the initial scripts
 * name in a `__vite__mapDeps` list. Nothing the initial load already has.
 */
export function staticIslandAssets(
  read: (url: string) => string,
  initial: readonly string[],
  name: string,
): string[] {
  const skip = new Set(initial);
  const [chunk] = islandAssets(read, initial, name);
  if (!chunk) return [];
  const seen = new Set<string>();
  const walk = (url: string) => {
    if (seen.has(url) || skip.has(url)) return;
    seen.add(url);
    for (const m of read(url).matchAll(/(?:from|import)\s*"\.\/([\w.-]+\.js)"/g))
      walk(`/assets/${m[1]}`);
  };
  walk(chunk);
  const css = new RegExp(`assets/(${name}-[\\w-]+\\.css)`);
  for (const url of initial) {
    const file = css.exec(read(url))?.[1];
    if (file) seen.add(`/assets/${file}`);
  }
  return [...seen];
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
  const read = (url: string) => readFileSync(join(dist, url.replace(/^\//, '')), 'utf8');
  const initial = initialAssets(readFileSync(join(dist, 'developers.html'), 'utf8'), true);
  const islands: {
    label: string;
    name: string;
    budget: number;
    forbidden?: readonly string[];
    /** The island imports its pieces statically (no dynamic imports of its own to read them from). */
    statics?: boolean;
  }[] = [
    { label: 'playground island', name: 'playground', budget: PLAYGROUND_BUDGET_BYTES },
    {
      label: 'developers search island',
      name: 'palette-island',
      budget: DEV_SEARCH_BUDGET_BYTES,
      statics: true,
      // The palette is cmdk; everything else the portal keeps out stays out.
      forbidden: DEV_FORBIDDEN.filter((m) => m !== 'cmdk-'),
    },
    { label: 'quickstart island', name: 'quickstart', budget: QUICKSTART_BUDGET_BYTES },
    { label: 'developers run island', name: 'run-entry', budget: DEV_ISLAND_BUDGET_BYTES },
  ];
  for (const { label, name, budget, forbidden = DEV_FORBIDDEN, statics } of islands) {
    const files = (statics ? staticIslandAssets : islandAssets)(read, initial, name);
    let total = 0;
    for (const url of files) {
      const body = read(url);
      total += gzipSync(body).length;
      for (const marker of forbidden)
        if (body.includes(marker)) {
          process.stderr.write(`${url} contains ${marker}\n`);
          failed = true;
        }
    }
    process.stdout.write(`${label} gzip: ${total} B (${files.length} files)\n`);
    if (files.length === 0 || total > budget) {
      process.stderr.write(
        files.length === 0
          ? `${label}: no entry found in the portal scripts\n`
          : `${label} gzip ${total} B exceeds budget ${budget} B\n`,
      );
      failed = true;
    }
  }
  // Google and Samsung stay dark in every deployable Worker (docs/design/wallet-providers/e2e-release.md).
  const release = e2eReleaseProblems(join(root, 'dist/wallet'));
  process.stdout.write(`worker e2e release: ${release.length === 0 ? 'absent' : 'present'}\n`);
  if (release.length > 0) {
    process.stderr.write(`${release.join('\n')}\n`);
    failed = true;
  }
  if (failed) process.exit(1);
}
