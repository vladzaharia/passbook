import { describe, expect, it } from 'vitest';
import { checkBundle, initialAssets } from './check-bundle.ts';

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
});
