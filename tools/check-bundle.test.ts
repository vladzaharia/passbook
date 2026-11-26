import { describe, expect, it } from 'vitest';
import {
  checkBundle,
  DEV_BUDGET_BYTES,
  DEV_FORBIDDEN,
  FORBIDDEN,
  initialAssets,
  islandAssets,
  MARKETING_FORBIDDEN,
  SCAN_BUDGET_BYTES,
  SCAN_FORBIDDEN,
  toolAssets,
  WB_BENCH_BUDGET_BYTES,
  WB_DESIGN_BUDGET_BYTES,
  WB_HOST_BUDGET_BYTES,
  WB_KIT_BUDGET_BYTES,
  WB_SHELL_BUDGET_BYTES,
  WB_SHELL_MARKER,
  WB_TOOL_BUDGET_BYTES,
  WB_TOOLS_MEASURED,
} from './check-bundle.ts';
import { markedAssets, namedAssets } from './lib/marked-assets.ts';

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

  it('finds an island by its loader name and the chunks Vite lists in it', () => {
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
  });

  it('measures one tool route: its chunk by its class, and what its loader lists past the shell and bench', () => {
    const files: Record<string, string> = {
      '/assets/main-A.js':
        'x(()=>import(`./logs-B.js`),__vite__mapDeps([0,1,2,3]));const __vite__mapDeps=(i,m=__vite__mapDeps,d=(m.f||(m.f=["assets/logs-B.js","assets/list-C.js","assets/logs-B.css","assets/rail-D.js"])))=>i',
      '/assets/logs-B.js': 'cn("wb-tool-logs")',
      '/assets/list-C.js': 'bench',
      '/assets/logs-B.css': '.x{}',
      '/assets/rail-D.js': 'rail',
      '/assets/other.js': 'cn("wb-tool-keys")',
    };
    const read = (url: string) => files[url] ?? '';
    const all = Object.keys(files);
    const tool = toolAssets(read, all, new Set(['/assets/list-C.js']), 'logs');
    expect(tool.errors).toEqual([]);
    expect(tool.files).toEqual(['/assets/logs-B.js', '/assets/logs-B.css', '/assets/rail-D.js']);
    // A route chunk that lazy chunks also import is loaded as `import(...).then(e=>e.t)`.
    const shared: Record<string, string> = {
      '/assets/main-A.js':
        'x(()=>import(`./design-E.js`).then(e=>e.t),__vite__mapDeps([0,1]));const __vite__mapDeps=(i,m=__vite__mapDeps,d=(m.f||(m.f=["assets/design-E.js","assets/rail-D.js"])))=>i',
      '/assets/design-E.js': 'cn("wb-tool-design")',
      '/assets/rail-D.js': 'rail',
    };
    expect(
      toolAssets((u) => shared[u] ?? '', Object.keys(shared), new Set(), 'design').files,
    ).toEqual(['/assets/design-E.js', '/assets/rail-D.js']);
    expect(toolAssets(read, all, new Set(), 'console').errors[0]).toMatch(/0 chunks carry it/);
    expect(toolAssets(read, all, new Set(), 'keys').errors[0]).toMatch(/no loader lists/);
  });

  it('measures a shared chunk the build names: the chunk, what it imports past the skip, its stylesheet', () => {
    const files: Record<string, string> = {
      '/assets/react.js': 'react',
      '/assets/wb-bench-A.js': 'import{a}from"./react.js";import{b}from"./buddy-B.js";bench',
      '/assets/buddy-B.js': 'buddy',
      '/assets/wb-bench-A.css': '.bench-list{}',
      '/assets/logs-C.js': 'a tool',
    };
    const read = (url: string) => files[url] ?? '';
    const all = Object.keys(files);
    const bench = namedAssets(read, all, ['/assets/react.js'], 'wb-bench');
    expect(bench.errors).toEqual([]);
    expect(bench.files.sort()).toEqual([
      '/assets/buddy-B.js',
      '/assets/wb-bench-A.css',
      '/assets/wb-bench-A.js',
    ]);
    expect(namedAssets(read, all, [], 'wb-kit').errors[0]).toMatch(/0 chunks are named so/);
    expect(namedAssets(read, [...all, '/assets/wb-bench-Z.js'], [], 'wb-bench').errors[0]).toMatch(
      /2 chunks are named so/,
    );
  });

  it('holds the bench once and each tool route under its own line', () => {
    expect(WB_BENCH_BUDGET_BYTES).toBe(35_000);
    expect(WB_HOST_BUDGET_BYTES).toBe(15_000);
    expect(WB_KIT_BUDGET_BYTES).toBe(25_000);
    expect(WB_TOOL_BUDGET_BYTES).toBe(75_000);
    expect(WB_DESIGN_BUDGET_BYTES).toBe(230_000);
    expect(WB_TOOLS_MEASURED.logs).toBe(WB_TOOL_BUDGET_BYTES);
    expect(WB_TOOLS_MEASURED.design).toBe(WB_DESIGN_BUDGET_BYTES);
    expect(Object.keys(WB_TOOLS_MEASURED).sort()).toEqual([
      'console',
      'design',
      'events',
      'home',
      'keys',
      'logs',
      'playground',
      'quickstart',
    ]);
  });

  it('keeps the shared Workbench chunks out of every entry', () => {
    const files: Record<string, string> = { '/assets/index.js': '', '/assets/wb-kit-C.js': '' };
    const page = `${html}<link rel="modulepreload" href="/assets/wb-kit-C.js">`;
    const { errors } = checkBundle((url) => files[url] ?? '', page, 0);
    expect(errors).toEqual(['/assets/wb-kit-C.js is a Workbench chunk']);
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
