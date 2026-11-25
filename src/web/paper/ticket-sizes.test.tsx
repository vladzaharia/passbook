import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { PAPER_SPECS, type PaperSize, resolvePaper } from '../../passkit/template/paper.ts';
import { toSvg } from '../../shared/pass-view/barcode-svg.ts';
import { ADMISSION } from '../../worker/modules/prints/pdf-render-fixtures.ts';
import { pageRule } from './css.ts';
import { drawPaperCode } from './drawing.ts';
import { PaperTicket } from './ticket.tsx';

const CODE = 'PK7QM3XRTWA2D5HJN6BV4CEYLZG';
const html = (size: PaperSize, over: object = {}, kind: 'admission' | 'permit' = 'admission') => {
  const design = resolvePaper({ schema: 1, size, barcode: 'qr', ...over });
  const content = { ...ADMISSION, kind, hero: { zone: 'C', plate: 'AB12 CDE' } };
  return renderToStaticMarkup(
    <PaperTicket
      mark="full"
      content={content}
      design={design}
      code={CODE}
      drawing={drawPaperCode(toSvg, design.barcode, CODE)}
    />,
  );
};

describe('new sizes on the print page', () => {
  it.each(['stub', 'atb', 'a6', 'dl'] as const)(
    '%s is one strip page with the code, the words and the typed code',
    (size) => {
      const out = html(size);
      expect(out.match(/class="pp-fit"/g)).toHaveLength(1);
      expect(out).toContain(`--w:${PAPER_SPECS[size].widthMm}`);
      expect(out).toContain('pp-strip');
      expect(out).toContain('Harbour Lights: Night Two');
      expect(out).toContain('PK7QM3XRT WA2D5HJN6 BV4CEYLZG');
      expect(out).toContain('aria-label="QR code.');
    },
  );

  it('a portrait card has two pages at 54 x 85.6', () => {
    const out = html('cr80p');
    expect(out.match(/class="pp-fit"/g)).toHaveLength(2);
    expect(out).toContain('--w:54');
    expect(out).toContain('--h:85.6');
  });

  it('a card on a home sheet is a fold: one sheet page, the back turned, a bleed, a fold line', () => {
    const out = html('cr80', { sheet: 'letter' });
    expect(out.match(/class="pp-fit"/g)).toHaveLength(1);
    expect(out).toContain('--w:215.9');
    expect(out).toContain('pp-cuts');
    expect(out.match(/<line /g)).toHaveLength(9);
    expect(out).toContain('pp-fold-line');
    expect(out.match(/pp-turned/g)).toHaveLength(1);
    expect(out).toContain('pp-bleed');
    expect(pageRule('cr80', 'letter')).toBe('@page{size:215.9mm 279.4mm;margin:0}');
    expect(pageRule('cr80')).toBe('@page{size:85.6mm 54mm;margin:0}');
  });

  it('a mono card has no bleed', () => {
    const design = resolvePaper({ schema: 1, size: 'cr80p', barcode: 'qr', sheet: 'a4' });
    const out = renderToStaticMarkup(
      <PaperTicket
        mark="full"
        content={{ ...ADMISSION, ink: 'mono' }}
        design={design}
        code={CODE}
        drawing={drawPaperCode(toSvg, design.barcode, CODE)}
      />,
    );
    expect(out).not.toContain('pp-bleed');
    // A portrait card turns like a page: its back stays upright.
    expect(out).not.toContain('pp-turned');
  });

  it.each(['stub', 'atb', 'a6', 'dl'] as const)(
    'a %s on a home sheet is one face at true size',
    (size) => {
      const out = html(size, { sheet: 'a4' });
      expect(out.match(/class="pp-fit"/g)).toHaveLength(1);
      expect(out).toContain('--w:210');
      expect(out).toContain('--h:297');
      expect(out).toContain('pp-strip');
      expect(out).not.toContain('pp-fold-line');
      expect(out).not.toContain('pp-turned');
      expect(pageRule(size, 'a4')).toBe('@page{size:210mm 297mm;margin:0}');
    },
  );

  it('half letter keeps the half layout, and scales a permit onto its page', () => {
    expect(html('half-letter')).toContain('pp-half-letter');
    const permit = html('half-letter', {}, 'permit');
    expect(permit).toContain('pp-hfit');
    expect(permit).toContain('--sc:0.94392');
  });

  it.each([
    ['stub', '@page{size:139.7mm 50.8mm;margin:0}'],
    ['atb', '@page{size:187.325mm 82.55mm;margin:0}'],
    ['a6', '@page{size:148mm 105mm;margin:0}'],
    ['dl', '@page{size:210mm 99mm;margin:0}'],
    ['half-letter', '@page{size:215.9mm 139.7mm;margin:0}'],
    ['cr80p', '@page{size:54mm 85.6mm;margin:0}'],
  ] as const)('%s prints at its own page size', (size, rule) => {
    expect(pageRule(size)).toBe(rule);
  });
});
