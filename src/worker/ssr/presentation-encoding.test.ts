import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { toSvg } from '../../shared/pass-view/barcode-svg.ts';
import { PresentationCode } from './presentation-code.tsx';
import { encodePresentationText } from './presentation-encoding.ts';

describe('presentation barcode character encoding', () => {
  it.each([
    ['utf-8', 'Aé', 'A\xc3\xa9'],
    ['ISO-8859-1', 'Café', 'Caf\xe9'],
    ['ISO-8859-2', 'Č', '\xc8'],
    ['windows-1251', 'Ж', '\xc6'],
    ['windows-1252', '€', '\x80'],
    ['Shift_JIS', 'あ', '\x82\xa0'],
    ['UTF-16BE', 'A', '\x00A'],
    ['UTF-16LE', 'A', 'A\x00'],
    ['UTF-16', 'A', '\xff\xfeA\x00'],
  ])('encodes %s as exact declared bytes', (encoding, text, bytes) => {
    expect(encodePresentationText(text, encoding)).toBe(bytes);
  });

  it('preserves a leading byte-order-mark character in the value', () => {
    expect(encodePresentationText('\ufeffA', 'UTF-8')).toBe('\xef\xbb\xbfA');
    expect(encodePresentationText('\ufeffA', 'UTF-16LE')).toBe('\xff\xfeA\x00');
  });

  it.each([
    ['us-ascii', 'café'],
    ['ISO-8859-1', '🎫'],
    ['Shift_JIS', '🎫'],
    ['UTF-8', '\ud800'],
    ['ISO-2022-JP', '日本'],
    ['not-a-charset', 'ABC'],
  ])('refuses unsupported or unrepresentable %s input', (encoding, text) => {
    expect(encodePresentationText(text, encoding)).toBeNull();
  });

  it.each([
    ['qrcode', 'PKBarcodeFormatQR', '日本', 'Shift_JIS', '\x93\xfa\x96\x7b', true],
    ['pdf417', 'PKBarcodeFormatPDF417', 'Café', 'ISO-8859-1', 'Caf\xe9', false],
    ['azteccode', 'PKBarcodeFormatAztec', '€', 'windows-1252', '\x80', true],
  ] as const)(
    'draws %s using the actual encoded bytes',
    (bcid, format, message, encoding, bytes, square) => {
      const html = renderToStaticMarkup(
        createElement(PresentationCode, {
          barcode: { bcid, format, message, encoding, square },
        }),
      );
      const expected = toSvg({
        bcid,
        text: bytes,
        binarytext: true,
        paddingwidth: 0,
        paddingheight: 0,
      });
      const paths = (markup: string) =>
        [...markup.matchAll(/<path\b[^>]*\sd="([^"]+)"/g)].map((match) => match[1]);
      expect(paths(expected).length).toBeGreaterThan(0);
      expect(paths(html)).toEqual(paths(expected));
      expect(html).not.toContain(message);
    },
  );
});
