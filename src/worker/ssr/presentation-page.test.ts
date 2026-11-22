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
  it('is a white field with the pass name, the code and the way back, and no jargon', () => {
    const html = renderPresentationPage(props);
    expect(html).toContain('class="door"');
    expect(html).toContain('<h1>Membership</h1>');
    expect(html).toContain('html,body{background:#fff');
    expect(html.slice(html.indexOf('<body')).replace(/aria-label="[^"]*"/g, '')).not.toMatch(
      /Code 39|NFC|presentation barcode/i,
    );
    expect(html).toContain('href="/p/t"');
  });

  it('forces the light theme, whatever the visitor chose', () => {
    expect(renderPresentationPage({ ...props, theme: 'dark' })).toContain('data-theme="light"');
  });

  it('offers the saved note and wake lock only on a saveable door view, with no token and no manifest', () => {
    const saveable = renderPresentationPage({ ...props, offline: true });
    expect(saveable).toContain('data-door-saved');
    expect(saveable).toContain('Works offline');
    expect(saveable).toContain('wakeLock');
    expect(saveable).not.toContain('manifest');
    expect(saveable).not.toContain('/p/t');
    expect(saveable).toContain('href="./"');
    const member = renderPresentationPage(props);
    expect(member).not.toContain('data-door-saved');
    expect(member).toContain('href="/p/t"');
    expect(member).not.toMatch(/<script\b/);
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
