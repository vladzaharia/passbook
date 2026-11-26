import { describe, expect, it } from 'vitest';
import {
  BENCH_BUDGET_BYTES,
  checkBundle,
  DEV_BUDGET_BYTES,
  DEV_FORBIDDEN,
  DEV_ISLAND_BUDGET_BYTES,
  FORBIDDEN,
  initialAssets,
  islandAssets,
  MARKETING_FORBIDDEN,
  PLAYGROUND_BUDGET_BYTES,
  SCAN_BUDGET_BYTES,
  SCAN_FORBIDDEN,
  WB_SHELL_BUDGET_BYTES,
  WB_SHELL_MARKER,
} from './check-bundle.ts';
import { markedAssets } from './lib/marked-assets.ts';

const html = `<script type="module" crossorigin src="/assets/index.js"></script>
<link rel="modulepreload" crossorigin href="/assets/ui.js">
<link rel="stylesheet" href="/assets/a.css">`;

describe('check-bundle', () => {
  it('reads the entry and its modulepreloads', () => {
    expect(initialAssets(html)).toEqual(['/assets/index.js', '/assets/ui.js']);
  });

  it('flags admin-only libraries in a preloaded chunk', () => {
    const files: Record<string, string> = {
      '/assets/index.js': 'ok',
      '/assets/ui.js': 'x.getRowModel()',
    };
    const { errors } = checkBundle((url) => files[url] ?? '', html, 0);
    expect(errors).toEqual(['/assets/ui.js contains getRowModel']);
  });

  it('flags a bundle over budget', () => {
    const big = Array.from({ length: 5000 }, (_, i) => `v${i}${Math.random()}`).join('');
    const { errors } = checkBundle(() => big, html, 100);
    expect(errors[0]).toMatch(/exceeds budget 100 B/);
  });

  it('the scan run fails on routeTree and over its budget', () => {
    const files: Record<string, string> = {
      '/assets/index.js': 'x.routeTree.y',
      '/assets/ui.js': 'ok',
    };
    const { errors } = checkBundle(
      (url) => files[url] ?? '',
      html,
      SCAN_BUDGET_BYTES,
      SCAN_FORBIDDEN,
    );
    expect(errors).toEqual(['/assets/index.js contains routeTree']);
    const big = Array.from({ length: 200_000 }, () => Math.random().toString(36)).join('');
    const over = checkBundle(() => big, html, SCAN_BUDGET_BYTES, SCAN_FORBIDDEN);
    expect(over.errors.some((e) => e.includes(`exceeds budget ${SCAN_BUDGET_BYTES} B`))).toBe(true);
  });

  it('the SPA run allows routeTree but not the display renderer markers', () => {
    const files: Record<string, string> = {
      '/assets/index.js': 'routeTree scan-display:render',
      '/assets/ui.js': 'SCAN_DISPLAY_DENSITY',
    };
    const { errors } = checkBundle((url) => files[url] ?? '', html, 0, FORBIDDEN);
    expect(errors).toEqual([
      '/assets/index.js contains scan-display:render',
      '/assets/ui.js contains SCAN_DISPLAY_DENSITY',
    ]);
  });

  it('the scan run also forbids the e2e hook', () => {
    const { errors } = checkBundle(() => 'window.__passbookScan', html, 0, SCAN_FORBIDDEN);
    expect(errors).toContain('/assets/index.js contains __passbookScan');
  });

  it('the portal run counts stylesheets, holds 60 kB and refuses the router tree', () => {
    expect(DEV_BUDGET_BYTES).toBe(60_000);
    expect(initialAssets(html, true)).toEqual([
      '/assets/index.js',
      '/assets/ui.js',
      '/assets/a.css',
    ]);
    const files: Record<string, string> = {
      '/assets/index.js': 'ok',
      '/assets/ui.js': 'ok',
      '/assets/a.css': 'routeTree',
    };
    const { errors } = checkBundle(
      (url) => files[url] ?? '',
      html,
      DEV_BUDGET_BYTES,
      DEV_FORBIDDEN,
      true,
    );
    expect(errors).toEqual(['/assets/a.css contains routeTree']);
    const css = Array.from({ length: 80_000 }, () => Math.random().toString(36)).join('');
    const over = checkBundle(() => css, html, DEV_BUDGET_BYTES, DEV_FORBIDDEN, true);
    expect(over.errors.some((e) => e.includes('exceeds budget 60000 B'))).toBe(true);
  });

  it('finds the playground island from the portal script and keeps the initial load out of it', () => {
    const files: Record<string, string> = {
      '/assets/developers-a.js': 'import("./playground-Abc_12.js")',
      '/assets/playground-Abc_12.js':
        'const __vite__mapDeps=(i,m=__vite__mapDeps,d=(m.f||(m.f=["assets/boot-x.js","assets/react-y.js","assets/boot-x.css","assets/developers-a.js"])))=>i',
    };
    const initial = ['/assets/developers-a.js', '/assets/developers-b.css'];
    expect(islandAssets((url) => files[url] ?? '', initial, 'playground')).toEqual([
      '/assets/playground-Abc_12.js',
      '/assets/boot-x.js',
      '/assets/react-y.js',
      '/assets/boot-x.css',
    ]);
    // No island named in the scripts: nothing to measure, which the build reports as a failure.
    expect(islandAssets(() => 'nothing', initial, 'playground')).toEqual([]);
  });

  it('the playground island has a budget of its own, above the portal’s and the console’s, below the SPA’s', () => {
    expect(PLAYGROUND_BUDGET_BYTES).toBeGreaterThan(DEV_BUDGET_BYTES);
    expect(PLAYGROUND_BUDGET_BYTES).toBeGreaterThan(DEV_ISLAND_BUDGET_BYTES);
    expect(PLAYGROUND_BUDGET_BYTES).toBeLessThan(235_000);
  });

  it('finds the Try it island: its loader and the chunks Vite lists in it', () => {
    const files: Record<string, string> = {
      '/assets/developers-A.js': 'x(()=>import("./run-entry-B1.js"),__vite__mapDeps([0]))',
      '/assets/run-entry-B1.js':
        'const __vite__mapDeps=(i,m=__vite__mapDeps,d=(m.f||(m.f=["assets/mount-C.js","assets/react-D.js","assets/mount-C.css"])))=>i.map(i=>d[i]);',
    };
    const read = (url: string) => files[url] ?? '';
    expect(islandAssets(read, ['/assets/developers-A.js'], 'run-entry')).toEqual([
      '/assets/run-entry-B1.js',
      '/assets/mount-C.js',
      '/assets/react-D.js',
      '/assets/mount-C.css',
    ]);
    expect(islandAssets(read, ['/assets/developers-A.js'], 'missing')).toEqual([]);
    expect(DEV_ISLAND_BUDGET_BYTES).toBe(98_000);
  });

  it('a Workbench island holds React, the bench primitives and one tool, under the playground', () => {
    // React alone is 67.5 kB and the primitives about 32 kB: a tool gets the rest.
    expect(BENCH_BUDGET_BYTES).toBe(125_000);
    expect(BENCH_BUDGET_BYTES).toBeGreaterThan(DEV_ISLAND_BUDGET_BYTES);
    expect(BENCH_BUDGET_BYTES).toBeLessThan(PLAYGROUND_BUDGET_BYTES);
  });

  it('keeps the Workbench shell out of every entry: the SPA, the scanner, the docs and the site', () => {
    for (const list of [FORBIDDEN, SCAN_FORBIDDEN, DEV_FORBIDDEN, MARKETING_FORBIDDEN])
      expect(list).toContain(WB_SHELL_MARKER);
    const files: Record<string, string> = {
      '/assets/index.js': 'x("wb-shell")',
      '/assets/ui.js': '',
    };
    const { errors } = checkBundle((url) => files[url] ?? '', html, 0);
    expect(errors).toEqual(['/assets/index.js contains wb-shell']);
  });

  it('measures the Workbench shell: its chunk, what it imports past the entry, and its stylesheet', () => {
    const files: Record<string, string> = {
      '/assets/index.js': 'entry',
      '/assets/react.js': 'react',
      '/assets/route-A.js': 'import{a}from"./react.js";import{b}from"./kit-B.js";cn("wb-shell")',
      '/assets/kit-B.js': 'import{c}from"./kit-C.js";',
      '/assets/kit-C.js': 'c',
      '/assets/route-D.js': 'another route',
      '/assets/route-A.css': '.wb-shell{--wb-dot:red}',
      '/assets/index.css': '.app{}',
    };
    const read = (url: string) => files[url] ?? '';
    const all = Object.keys(files);
    const shell = markedAssets(
      read,
      all,
      ['/assets/index.js', '/assets/react.js'],
      WB_SHELL_MARKER,
    );
    expect(shell.errors).toEqual([]);
    expect(shell.files.sort()).toEqual([
      '/assets/kit-B.js',
      '/assets/kit-C.js',
      '/assets/route-A.css',
      '/assets/route-A.js',
    ]);
    files['/assets/route-D.js'] = 'cn("wb-shell")';
    expect(markedAssets(read, all, [], WB_SHELL_MARKER).errors[0]).toMatch(/2 chunks carry it/);
    expect(WB_SHELL_BUDGET_BYTES).toBe(45_000);
  });
});
