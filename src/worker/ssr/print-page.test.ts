import { describe, expect, it } from 'vitest';
import { DERIVED_PAPER, type PaperDesign } from '../../passkit/template/paper.ts';
import { paperContent } from '../../passkit/template/paper-content.ts';
import { EVENT_MANIFEST, EVENT_PASS } from '../../passkit/template/paper-fixtures.ts';
import type { BrandMark } from '../../shared/contracts/orgs.ts';
import { pageRule } from '../../web/paper/css.ts';
import type { PrintPageModel } from '../modules/prints/page.ts';
import { PRINT_HEADERS, renderPrintPage } from './print-page.tsx';

const CODE = 'PABCDEFGHIJKLMNOPQRSTUVWXYZ';
const design = (over: Partial<PaperDesign> = {}): PaperDesign => ({ ...DERIVED_PAPER, ...over });
const content = (d: PaperDesign) =>
  paperContent({
    passJson: EVENT_PASS,
    manifest: EVENT_MANIFEST,
    personalization: {},
    design: d,
    holderName: 'Ada',
  });
const ready = (d: PaperDesign, mark: BrandMark = 'full'): PrintPageModel => ({
  state: 'ready',
  orgName: 'Northwind Hall',
  mode: 'live',
  printId: 'print-1',
  design: d,
  content: content(d),
  code: CODE,
  generation: 1,
  mark,
  printedAt: Date.UTC(2026, 10, 19, 1, 2),
  files: { logo: 'logo@3x.png', art: 'artwork@3x.png' },
});

describe('print page document', () => {
  const props = { audience: 'holder', nonce: 'n0', backHref: '/p/t' } as const;

  it.each([
    ['letter', '@page{size:215.9mm 279.4mm;margin:0}'],
    ['a4', '@page{size:210mm 297mm;margin:0}'],
    ['cr80', '@page{size:85.6mm 54mm;margin:0}'],
  ] as const)('sets the page for %s and hides the chrome in print', (size, rule) => {
    const html = renderPrintPage({ ...props, model: ready(design({ size })) });
    expect(pageRule(size)).toBe(rule);
    expect(html).toContain(rule);
    expect(html).toContain('@media print{');
    expect(html).toMatch(/\.pp-actions[^{]*\{display:none!important\}/);
    expect(html).toContain('window.print()');
  });

  it('offers print, reprint and void to the holder, and print alone to staff', () => {
    const holder = renderPrintPage({ ...props, model: ready(design()) });
    expect(holder).toContain('data-act="reprint"');
    expect(holder).toContain('data-act="void"');
    const staff = renderPrintPage({ ...props, audience: 'staff', model: ready(design()) });
    expect(staff).toContain('data-act="print"');
    expect(staff).not.toContain('data-act="reprint"');
    expect(staff).not.toContain('data-act="void"');
  });

  it('says when the ticket holds characters the fonts cannot draw', () => {
    const d = design();
    const base = ready(d) as Extract<PrintPageModel, { state: 'ready' }>;
    expect(renderPrintPage({ ...props, model: base })).not.toContain('data-lossy');
    const model = { ...base, content: { ...base.content, holder: '李雷' } };
    expect(renderPrintPage({ ...props, model })).toContain('data-lossy');
  });

  it('prints Vietnamese and Greek through the fallback font, and still warns for CJK', () => {
    const base = ready(design()) as Extract<PrintPageModel, { state: 'ready' }>;
    const warns = (holder: string) =>
      renderPrintPage({
        ...props,
        model: { ...base, content: { ...base.content, holder } },
      }).includes('data-lossy');
    expect(warns('Nguyễn Thị Hương')).toBe(false);
    expect(warns('Αλέξανδρος')).toBe(false);
    expect(warns('李雷')).toBe(true);
  });

  it('puts the fallback font after Rubik and serves its subsets', () => {
    const html = renderPrintPage({ ...props, model: ready(design()) });
    expect(html).toMatch(/font-family:Rubik,"Noto Sans Print",/);
    for (const s of ['vietnamese', 'greek', 'cyrillic'])
      expect(html).toContain(`/fonts/noto/noto-sans-${s}-wght-normal.woff2`);
  });

  it('asks the holder to make the ticket when no print exists, and says why when it cannot', () => {
    const empty = renderPrintPage({
      ...props,
      model: { state: 'empty', orgName: 'Northwind Hall', mode: 'live' },
    });
    expect(empty).toContain('data-act="make"');
    expect(empty).not.toContain('class="pp-sheet');
    const off = renderPrintPage({
      ...props,
      model: { state: 'unavailable', orgName: 'Northwind Hall', mode: 'live' },
    });
    expect(off).toContain('Printing unavailable');
    expect(off).toContain('Ask Northwind Hall for a printed ticket.');
    expect(off).not.toContain('data-act=');
  });

  it('puts the code in the markup only, never a script, and keeps the page private', () => {
    const html = renderPrintPage({ ...props, model: ready(design()) });
    const scripts = [...html.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
    expect(scripts.join('')).not.toContain(CODE);
    expect(html).toContain('name="referrer" content="no-referrer"');
    expect(html).toContain('nonce="n0"');
  });
});

describe('print page for a holder', () => {
  const props = {
    audience: 'holder',
    nonce: 'n0',
    backHref: '/p/t',
    assetBase: '/p/t/assets/',
  } as const;
  const page = (model: PrintPageModel) => renderPrintPage({ ...props, model });

  it('carries the no-store, no-referrer and noindex headers', () => {
    expect(PRINT_HEADERS['cache-control']).toBe('private, no-store');
    expect(PRINT_HEADERS['referrer-policy']).toBe('no-referrer');
    expect(PRINT_HEADERS['x-robots-tag']).toBe('noindex, nofollow');
    expect(PRINT_HEADERS['x-content-type-options']).toBe('nosniff');
    expect(page(ready(design()))).toContain('content="noindex, nofollow, noarchive"');
  });

  it('wears the org bar, not the PassBook band, and says PassBook once on the sheet', () => {
    const html = page(ready(design()));
    expect(html).toContain('Northwind Hall</span></div></header>');
    expect(html).not.toContain('class="band"');
    expect(html.match(/PassBook/g)).toHaveLength(1);
    expect(html).toContain('Issued with <b>PassBook</b>');
  });

  it('follows the org footer choice: small is one quiet line, none says nothing', () => {
    const small = page(ready(design(), 'small'));
    expect(small).toContain('Powered by PassBook');
    expect(small).not.toContain('Issued with');
    const none = page(ready(design(), 'none'));
    expect(none).not.toContain('PassBook');
    expect(none).not.toContain('Issued with');
  });

  it('puts the lede and the actions, Print first, before the sheet', () => {
    const html = page(ready(design()));
    const at = (needle: string) => html.indexOf(needle);
    expect(html).toContain('Print at actual size (100 %) on white paper.');
    expect(at('Print at actual size')).toBeLessThan(at('class="pp-stage"'));
    expect(at('data-act="print"')).toBeLessThan(at('data-act="reprint"'));
    expect(at('data-act="print"')).toBeLessThan(at('class="pp-fit"'));
    expect(html.match(/<button/g)?.[0]).toBeDefined();
    expect(html.indexOf('<button')).toBe(
      html.indexOf('data-act="print"') - '<button class="btn" type="button" '.length,
    );
  });

  it('draws the print number, its time and the template images from the asset base', () => {
    const html = page(ready(design()));
    expect(html).toContain('Print 1 · Issued 18 Nov 2026, 8:02 pm GMT-5');
    expect(html).toContain('src="/p/t/assets/logo%403x.png"');
    expect(html).not.toContain('assets/artwork');
  });

  it('adds the test ribbon and the watermark on a test pass', () => {
    const html = page({ ...ready(design()), mode: 'test' });
    expect(html).toContain('pp-ribbon');
    expect(html).toContain('TEST · NOT VALID');
  });

  it('shows the buddy only in the empty and unavailable states', () => {
    expect(page(ready(design()))).not.toContain('wl-buddy');
    const empty = page({ state: 'empty', orgName: 'Northwind Hall', mode: 'live' });
    expect(empty).toContain('data-scene="inspect"');
    const off = page({ state: 'unavailable', orgName: 'Northwind Hall', mode: 'live' });
    expect(off).toContain('data-scene="tug"');
    expect(off).toContain('aria-hidden="true"');
  });

  it('hides everything but the sheet when printing', () => {
    const html = page(ready(design()));
    expect(html).toMatch(/\.pp-noprint,\.pp-head,\.pp-actions[^{]*\{display:none!important\}/);
  });
});

describe('print page for staff', () => {
  it('keeps the hosted PassBook shell and offers print alone', () => {
    const html = renderPrintPage({ audience: 'staff', nonce: 'n0', model: ready(design()) });
    expect(html).toContain('class="band"');
    expect(html).toContain('Print ticket');
  });
});
