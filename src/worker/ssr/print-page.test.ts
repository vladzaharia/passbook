import { describe, expect, it } from 'vitest';
import { DERIVED_PAPER, type PaperDesign } from '../../passkit/template/paper.ts';
import { paperContent } from '../../passkit/template/paper-content.ts';
import { EVENT_MANIFEST, EVENT_PASS } from '../../passkit/template/paper-fixtures.ts';
import { pageRule } from '../../web/paper/css.ts';
import type { PrintPageModel } from '../modules/prints/page.ts';
import { renderPrintPage } from './print-page.tsx';

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
const ready = (d: PaperDesign): PrintPageModel => ({
  state: 'ready',
  orgName: 'Northwind Hall',
  mode: 'live',
  design: d,
  content: content(d),
  code: CODE,
  generation: 1,
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
