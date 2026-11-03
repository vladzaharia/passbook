import { describe, expect, it } from 'vitest';
import { appleWalletBadgeHtml } from './apple-badge.ts';

describe('appleWalletBadgeHtml', () => {
  it('escapes the href and picks the outline badge on dark', () => {
    const html = appleWalletBadgeHtml({ href: '/p/a"b' });
    expect(html).toContain('href="/p/a&quot;b"');
    expect(html).toContain('/apple/badge/en/outline.svg');
  });

  it('forces the artwork for a page theme, like the SPA badge: no <source>', () => {
    const dark = appleWalletBadgeHtml({ href: '/p/x', theme: 'dark' });
    expect(dark).toContain('src="/apple/badge/en/outline.svg"');
    expect(dark).not.toContain('<source');
    const light = appleWalletBadgeHtml({ href: '/p/x', theme: 'light' });
    expect(light).toContain('src="/apple/badge/en/black.svg"');
    expect(light).not.toContain('<source');
  });
});
