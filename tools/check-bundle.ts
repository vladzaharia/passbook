// Runs after `vite build`: the initial load (entry plus modulepreloads) stays under budget and
// carries no admin-only library, and the Worker carries no e2e provider release.

import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { gzipSync } from 'node:zlib';
import { e2eReleaseProblems } from './lib/e2e-release.ts';
import { markedAssets, namedAssets } from './lib/marked-assets.ts';

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
 * The ⌘K search island (palette, kit dialog, cmdk, React): loads on the first ⌘K or click of the
 * search button, so it sits outside the 60 kB: 130 kB measured, of which React and Radix are 90 kB
 * (shared with every other island). The index it fetches has its own 150 kB budget
 * (src/web/developers/search/build.ts).
 */
export const DEV_SEARCH_BUDGET_BYTES = 135_000;
/**
 * The Workbench's shell (workbench/shell/**: its chrome, nav, switcher, palette sources and keys),
 * on top of the SPA entry, in gzip bytes: the lazy chunk carrying its `wb-shell` class, the chunks
 * it imports that the entry does not, and its stylesheet. Workbench v2 §4.6.
 */
export const WB_SHELL_BUDGET_BYTES = 45_000;
/**
 * The bench primitives (workbench/bench/**: list, inspector, split, toolbar, id chip, trace), counted
 * once on top of the entry and the shell, in gzip bytes: the chunk the build names `wb-bench`
 * (vite.config.ts), the chunks it imports and its stylesheet. 24.9 kB measured; Workbench v2 §4.6
 * sets 35 kB.
 */
export const WB_BENCH_BUDGET_BYTES = 35_000;
/** The build names the bench's chunk after this (the `codeSplitting` group in vite.config.ts). */
export const WB_BENCH_CHUNK = 'wb-bench';
/**
 * The host and tool-api (workbench/host/**, lib/tool-api): the chunk the build names `wb-host`, the
 * chunks it imports past the entry. The shell imports it, so the shell's 45 kB already holds it:
 * this line keeps it from growing unseen. 10.8 kB measured with the inbox and events tools merged.
 */
export const WB_HOST_BUDGET_BYTES = 15_000;
/** The build names the host's chunk after this. */
export const WB_HOST_CHUNK = 'wb-host';
/**
 * What every tool route shares (workbench/shell/tool-page, states, the legacy stylesheets, the tool
 * placeholder), counted once on top of the entry, the shell and the bench: the chunk the build names
 * `wb-kit`, the kit controls it imports and its stylesheet. 21.6 kB measured.
 */
export const WB_KIT_BUDGET_BYTES = 25_000;
/** The build names the kit's chunk after this. */
export const WB_KIT_CHUNK = 'wb-kit';
/** The shared Workbench chunks: no entry (SPA, scanner, docs, site) loads one. */
const WB_CHUNK = new RegExp(`/(${[WB_BENCH_CHUNK, WB_HOST_CHUNK, WB_KIT_CHUNK].join('|')})-`);
/**
 * One tool route (workbench/tools/tool-<name>.tsx), on top of the entry, the shell, the bench and the
 * kit, in gzip bytes: its chunk, the chunks and stylesheets its loader lists. Dynamic imports (the wallet
 * compilers, the barcode encoder) stay out. Workbench v2 §4.6.
 */
export const WB_TOOL_BUDGET_BYTES = 75_000;
/**
 * The Design route (workbench/design on the designer core), on top of the entry, the shell, the bench
 * and the kit, in gzip bytes. The core loads Scan, Wallets, Paper, the stamps compositor, the Code
 * tab, the JSON editor, the local validators and every section but Template and Style on demand
 * (the note atop admin/templates/designer/designer-body.tsx names what stays eager). 210 kB measured.
 */
export const WB_DESIGN_BUDGET_BYTES = 230_000;
/**
 * The tool routes that hold moved code, with their own line where the route is over 75 kB: the
 * anonymous Design route (88.0 kB; the playground's cards), which DC2 and DC3 bring under the design
 * budget. The quickstart is under 75 kB (60.5 kB measured) since its stage and finished page load lazily.
 */
export const WB_TOOLS_MEASURED: Readonly<Record<string, number>> = {
  logs: WB_TOOL_BUDGET_BYTES,
  console: WB_TOOL_BUDGET_BYTES,
  events: WB_TOOL_BUDGET_BYTES,
  home: WB_TOOL_BUDGET_BYTES,
  keys: WB_TOOL_BUDGET_BYTES,
  passes: WB_TOOL_BUDGET_BYTES,
  sandbox: WB_TOOL_BUDGET_BYTES,
  quickstart: WB_TOOL_BUDGET_BYTES,
  design: WB_DESIGN_BUDGET_BYTES,
  playground: 92_000,
};
/** The class every tool route's body carries (`wb-tool-logs`): it marks the route's chunk. */
export const WB_TOOL_MARKER = 'wb-tool-';
/** The class only the Workbench shell renders: it marks the shell's chunk and keeps it out of entries. */
export const WB_SHELL_MARKER = 'wb-shell';
/** Literal strings: this check matches text, so an identifier would not survive minification. */
export const FORBIDDEN = [
  'cmdk-',
  'getRowModel',
  'measureElement',
  'scan-display:render',
  'SCAN_DISPLAY_DENSITY',
  WB_SHELL_MARKER,
] as const;
/** The scan entry also never pulls the SPA router tree or the e2e hook. */
export const SCAN_FORBIDDEN = [...FORBIDDEN, 'routeTree', '__passbookScan'] as const;
/** The portal never pulls the SPA's router tree either. */
export const DEV_FORBIDDEN = [...FORBIDDEN, 'routeTree'] as const;

/**
 * A marketing page's initial load (marketing/*.html), scripts and stylesheets, in gzip bytes. The
 * heaviest page (the door, with its CSS) measured 25.0 kB (gzip, 24,960 B); the budget is that plus about 10 %. No React, router or
 * console code belongs in them: they are plain pages with the Buddy drawing kit.
 */
export const MARKETING_BUDGET_BYTES = 27_500;
/** Literal strings: React's element symbol and the router tree mark a bundle that pulled either in. */
export const MARKETING_FORBIDDEN = [
  ...DEV_FORBIDDEN,
  'react.transitional.element',
  'react.element',
  '@tanstack',
] as const;

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

/**
 * A tool route's own weight: the chunk carrying its `wb-tool-<stem>` class, and everything the
 * route's loader lists for it (`__vite__mapDeps`: the chunk, its static imports, its stylesheets; the
 * loader may pick a renamed export with `.then(e=>e.t)` when other chunks import the same one),
 * minus what `skip` (the entry, the shell and the bench) already loads.
 */
export function toolAssets(
  read: (url: string) => string,
  files: readonly string[],
  skip: ReadonlySet<string>,
  stem: string,
): { files: string[]; errors: string[] } {
  const marker = `${WB_TOOL_MARKER}${stem}`;
  const scripts = files.filter((f) => f.endsWith('.js') && read(f).includes(marker));
  if (scripts.length !== 1)
    return { files: [], errors: [`${marker}: ${scripts.length} chunks carry it, want 1`] };
  const base = (scripts[0] as string).replace(/^\/assets\//, '');
  const loader = new RegExp(
    `import\\(["'\`]\\./${base.replace('.', '\\.')}["'\`]\\)(?:\\.then\\([^)]*\\))?,__vite__mapDeps\\(\\[([\\d,]+)\\]\\)`,
  );
  for (const f of files) {
    if (!f.endsWith('.js')) continue;
    const text = read(f);
    const indexes = loader.exec(text)?.[1];
    const deps = /m\.f=(\[[^\]]*\])/.exec(text)?.[1];
    if (!indexes || !deps) continue;
    const list = JSON.parse(deps) as string[];
    const urls = indexes.split(',').map((i) => `/${list[Number(i)]}`);
    return { files: urls.filter((u) => !skip.has(u)), errors: [] };
  }
  return { files: [], errors: [`${marker}: no loader lists ${base}`] };
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
    if (WB_CHUNK.test(url)) errors.push(`${url} is a Workbench chunk`);
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
    ...['index', 'door', 'blueprints', 'build', 'access'].map((page) => ({
      name: `marketing ${page}`,
      page: `marketing/${page}.html`,
      budget: MARKETING_BUDGET_BYTES,
      forbidden: MARKETING_FORBIDDEN,
      stylesheets: true,
    })),
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
    {
      label: 'developers search island',
      name: 'palette-island',
      budget: DEV_SEARCH_BUDGET_BYTES,
      statics: true,
      // The palette is cmdk; everything else the portal keeps out stays out.
      forbidden: DEV_FORBIDDEN.filter((m) => m !== 'cmdk-'),
    },
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
  const assets = readdirSync(join(dist, 'assets')).map((f) => `/assets/${f}`);
  const entry = initialAssets(readFileSync(join(dist, 'index.html'), 'utf8'), true);
  const shell = markedAssets(read, assets, entry, WB_SHELL_MARKER);
  const shellTotal = shell.files.reduce((sum, url) => sum + gzipSync(read(url)).length, 0);
  process.stdout.write(`workbench shell gzip: ${shellTotal} B (${shell.files.length} files)\n`);
  const shellErrors = [...shell.errors];
  if (shellTotal > WB_SHELL_BUDGET_BYTES)
    shellErrors.push(
      `workbench shell gzip ${shellTotal} B exceeds budget ${WB_SHELL_BUDGET_BYTES} B`,
    );
  if (shellErrors.length > 0) {
    process.stderr.write(`${shellErrors.join('\n')}\n`);
    failed = true;
  }
  const gz = (urls: readonly string[]) =>
    urls.reduce((sum, url) => sum + gzipSync(read(url)).length, 0);
  const host = namedAssets(read, assets, entry, WB_HOST_CHUNK);
  const hostTotal = gz(host.files);
  process.stdout.write(`workbench host gzip: ${hostTotal} B (${host.files.length} files)\n`);
  const benchErrors = [...host.errors];
  if (hostTotal > WB_HOST_BUDGET_BYTES)
    benchErrors.push(`workbench host gzip ${hostTotal} B exceeds budget ${WB_HOST_BUDGET_BYTES} B`);
  const loaded = new Set([...entry, ...shell.files]);
  const bench = namedAssets(read, assets, [...loaded], WB_BENCH_CHUNK);
  const benchTotal = gz(bench.files);
  process.stdout.write(`workbench bench gzip: ${benchTotal} B (${bench.files.length} files)\n`);
  benchErrors.push(...bench.errors);
  if (benchTotal > WB_BENCH_BUDGET_BYTES)
    benchErrors.push(
      `workbench bench gzip ${benchTotal} B exceeds budget ${WB_BENCH_BUDGET_BYTES} B`,
    );
  const kit = namedAssets(read, assets, [...loaded, ...bench.files], WB_KIT_CHUNK);
  const kitTotal = gz(kit.files);
  process.stdout.write(`workbench kit gzip: ${kitTotal} B (${kit.files.length} files)\n`);
  benchErrors.push(...kit.errors);
  if (kitTotal > WB_KIT_BUDGET_BYTES)
    benchErrors.push(`workbench kit gzip ${kitTotal} B exceeds budget ${WB_KIT_BUDGET_BYTES} B`);
  for (const [stem, limit] of Object.entries(WB_TOOLS_MEASURED)) {
    const tool = toolAssets(read, assets, new Set([...loaded, ...bench.files, ...kit.files]), stem);
    const total = gz(tool.files);
    process.stdout.write(`workbench tool ${stem} gzip: ${total} B (${tool.files.length} files)\n`);
    benchErrors.push(...tool.errors);
    if (total > limit)
      benchErrors.push(`workbench tool ${stem} gzip ${total} B exceeds budget ${limit} B`);
  }
  if (benchErrors.length > 0) {
    process.stderr.write(`${benchErrors.join('\n')}\n`);
    failed = true;
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
