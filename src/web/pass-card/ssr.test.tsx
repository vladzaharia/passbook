// @vitest-environment node
import { renderToString } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { assets, fixtures } from '../../shared/pass-view/fixtures/index.ts';
import { normalize } from '../../shared/pass-view/index.ts';
import './sync-barcode.ts';
import { PassCard } from './index.tsx';

describe('SSR', () => {
  it('has no DOM globals in this environment', () => {
    expect((globalThis as Record<string, unknown>).window).toBeUndefined();
  });

  it.each(Object.entries(fixtures))(
    '%s renders both faces to a string with the barcode',
    (_, pass) => {
      const view = normalize(pass, {
        assets,
        now: new Date('2026-10-31T12:00:00Z'),
        timeZone: 'UTC',
      });
      const front = renderToString(<PassCard view={view} />);
      expect(front).toContain('class="pc-root"');
      expect(front).toContain('<svg class="pc-barcode-svg"');
      expect(front).toContain('Approximate preview');
      const back = renderToString(<PassCard view={view} face="back" />);
      expect(back).toContain('pc-back-body');
      expect(back).toContain('https://example.com/terms');
    },
  );

  it('escapes hostile text', () => {
    const view = normalize(
      { ...fixtures.generic, organizationName: '<script>x</script>', logoText: '"><img src=x>' },
      { assets: {} },
    );
    const html = renderToString(<PassCard view={view} />);
    expect(html).not.toContain('<script>');
    expect(html).not.toContain('<img src=x>');
  });
});
