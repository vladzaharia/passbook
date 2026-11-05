import { describe, expect, it } from 'vitest';
import {
  checkBundle,
  FORBIDDEN,
  initialAssets,
  SCAN_BUDGET_BYTES,
  SCAN_FORBIDDEN,
} from './check-bundle.ts';

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
});
