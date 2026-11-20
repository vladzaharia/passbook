import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { bakedTemplates } from '../../../generated/baked-templates.ts';
import { TEST_BAND_COPY } from '../../../shared/copy/developer.ts';
import { compileWallets } from '../../channel-previews/wallet-kit.ts';
import { blueprintPreviews } from './build.tsx';
import { ApplePane } from './panes.tsx';
import { fromBlueprint, sourceOf } from './templates.ts';
import { builtPreviews, ORIGIN, ROOT } from './test-data.ts';

const { data, files } = builtPreviews();
const starters = bakedTemplates.filter((t) => t.blueprint);

describe('blueprint previews (the anonymous playground’s data)', () => {
  it('covers every starter, once', () => {
    expect(starters.length).toBeGreaterThan(20);
    expect(data.items.map((i) => i.id).sort()).toEqual(starters.map((t) => t.id).sort());
  });

  it('is the same bytes on every build', () => {
    expect(blueprintPreviews(ROOT, ORIGIN).json).toBe(JSON.stringify(data));
  });

  it.each(data.items.map((i) => [i.slug, i] as const))(
    '%s draws on all four channels, front and back',
    (_slug, item) => {
      const template = fromBlueprint(item);
      const built = template.fixed?.built;
      expect(built).toBeDefined();
      if (!built) return;
      const source = sourceOf(template, built, template.sample);

      // Apple: the real card, both faces, with the band.
      for (const face of ['front', 'back'] as const) {
        const html = renderToStaticMarkup(<ApplePane source={source} face={face} />);
        expect(html).toContain('pc-card');
        expect(html).toContain(`data-face="${face}"`);
        expect(html).toContain(TEST_BAND_COPY);
      }

      // Google and Samsung: the release pipeline's own compilers, each with a card and a report.
      const wallets = compileWallets(source, { origin: ORIGIN });
      expect(wallets.google.compiled.type).not.toBe('off');
      expect(wallets.google.compiled.objectBody ?? wallets.google.compiled.blocked).toBeTruthy();
      expect(wallets.samsung.compiled.type).not.toBe('off');
      expect(wallets.samsung.compiled.cardData ?? wallets.samsung.compiled.blocked).toBeTruthy();
      expect(Array.isArray(wallets.google.report.items)).toBe(true);
      expect(Array.isArray(wallets.samsung.report.items)).toBe(true);

      // Paper: a static image with the band and a code, and no network at all (data: URIs only).
      expect(item.paper.src).toBe(`/developers/paper/${item.slug}.svg`);
      const svg = files.get(item.paper.src) ?? '';
      expect(svg.startsWith('<svg xmlns=')).toBe(true);
      expect(svg).toContain(TEST_BAND_COPY);
      expect(svg).toMatch(/class="pp-(qr|bar)"/);
      expect(svg).not.toMatch(/(?:src|href)="(?!data:)[^"]*"/);
      expect(item.paper.height).toBeGreaterThan(100);
    },
  );

  it('carries nothing a visitor must not see: no token, no empty contact field', () => {
    const text = JSON.stringify(data);
    expect(text).not.toContain('authenticationToken');
    expect(text).not.toMatch(/"key":"(contact|pass-service)(-poster)?","value":""/);
  });
});
