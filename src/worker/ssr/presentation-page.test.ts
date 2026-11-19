import { describe, expect, it } from 'vitest';
import { renderPresentationPage } from './presentation-page.tsx';

const props = {
  barcode: {
    bcid: 'code39',
    format: 'PKBarcodeFormatCode39',
    message: 'HG-014',
    encoding: 'iso-8859-1',
    square: false,
  },
  orgName: 'Gym',
  passTitle: 'Membership',
  mode: 'live',
  backHref: '/p/t',
  nonce: 'n',
} as const;

describe('presentation page', () => {
  it('sits on the hosted card with one line and no jargon', () => {
    const html = renderPresentationPage(props);
    expect(html).toContain('class="hosted wide"');
    expect(html).toContain('<h1>Membership</h1>');
    expect(html).toContain('Show this to the reader.');
    expect(html.slice(html.indexOf('<body'))).not.toMatch(/Code 39|NFC|presentation barcode/i);
    expect(html).toContain('href="/p/t"');
  });

  it('keeps the code on a white tile and the credential out of the text', () => {
    const html = renderPresentationPage(props);
    expect(html).toContain('background:#fff');
    expect(html).not.toContain('HG-014');
  });

  it('says what to do when the code cannot be drawn', () => {
    const html = renderPresentationPage({ ...props, barcode: null });
    expect(html).toContain('Barcode unavailable.');
    expect(html).toContain('Ask Gym for help.');
  });
});
