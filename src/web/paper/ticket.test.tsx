import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { DERIVED_PAPER, type PaperDesign } from '../../passkit/template/paper.ts';
import { paperContent } from '../../passkit/template/paper-content.ts';
import { EVENT_MANIFEST, EVENT_PASS } from '../../passkit/template/paper-fixtures.ts';
import { toSvg } from '../../shared/pass-view/barcode-svg.ts';
import { drawPaperCode } from './drawing.ts';
import { PaperTicket } from './ticket.tsx';

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
const sheet = (d: PaperDesign) =>
  renderToStaticMarkup(
    <PaperTicket
      content={content(d)}
      design={d}
      code={CODE}
      drawing={drawPaperCode(toSvg, d.barcode, CODE)}
    />,
  );

describe('print page sheet', () => {
  it.each(['a4', 'letter', 'half', 'cr80'] as const)('draws the %s layout', (size) => {
    expect(sheet(design({ size }))).toMatchSnapshot();
  });

  it('draws Code 128 when asked', () => {
    expect(sheet(design({ size: 'a4', barcode: 'code128' }))).toMatchSnapshot();
  });

  it('carries the typed print code and never the scan code', () => {
    const html = sheet(design());
    expect(html).toContain('PABCDEFGH IJKLMNOPQ RSTUVWXYZ');
    expect(html).not.toContain('SECRET-SCAN-CODE');
  });

  it('makes the QR at least 3 cm with a 4-module quiet zone', () => {
    for (const size of ['a4', 'letter', 'half', 'cr80'] as const) {
      const html = sheet(design({ size }));
      const drawing = drawPaperCode(toSvg, 'qr', CODE);
      expect(drawing).toBeDefined();
      if (!drawing) return;
      const width = Number(/width:calc\(var\(--mm\) \* ([\d.]+)\)/.exec(html)?.[1]);
      expect(drawing.quiet).toBe(4);
      expect((drawing.whole - drawing.symbol) / 2 / (drawing.symbol / drawing.modules)).toBe(4);
      expect((width * drawing.symbol) / drawing.whole).toBeGreaterThanOrEqual(30);
    }
  });
});
