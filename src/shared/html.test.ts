import { describe, expect, it } from 'vitest';
import { escapeHtml } from './html.ts';

describe('escapeHtml', () => {
  it('escapes markup and both quote kinds', () => {
    expect(escapeHtml(`<a href="x">'&'</a>`)).toBe(
      '&lt;a href=&quot;x&quot;&gt;&#39;&amp;&#39;&lt;/a&gt;',
    );
  });
});
