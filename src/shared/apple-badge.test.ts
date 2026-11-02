import { describe, expect, it } from 'vitest';
import { appleWalletBadgeHtml } from './apple-badge.ts';

describe('appleWalletBadgeHtml', () => {
  it('escapes the href and picks the outline badge on dark', () => {
    const html = appleWalletBadgeHtml({ href: '/p/a"b' });
    expect(html).toContain('href="/p/a&quot;b"');
    expect(html).toContain('/apple/badge/en/outline.svg');
  });
});
