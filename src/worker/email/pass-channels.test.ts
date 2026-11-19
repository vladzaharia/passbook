import { describe, expect, it } from 'vitest';
import { renderPassEmail } from './pass.ts';

const base = {
  orgName: 'Henry',
  downloadUrl: 'https://w.test/p/tok/pass.pkpass',
  manageUrl: 'https://w.test/p/tok',
  badgeUrl: 'https://w.test/badge.png',
  attached: true,
};

describe('pass email by channel', () => {
  it('carries the badge, the attachment line and the add line when Apple is on', () => {
    const { html, text } = renderPassEmail(base);
    expect(html).toContain('Add to Apple Wallet');
    expect(html).toContain('/pass.pkpass');
    expect(text).toContain('also attached');
    expect(html).not.toContain('Print ticket');
  });

  it('drops the badge, the add line and the attachment line when Apple is off, keeping manage', () => {
    const { html, text } = renderPassEmail({ ...base, downloadUrl: null, attached: false });
    expect(html).not.toContain('Add to Apple Wallet');
    expect(html).not.toContain('.pkpass');
    expect(text).not.toContain('.pkpass');
    expect(text).not.toContain('also attached');
    expect(html).toContain('https://w.test/p/tok');
    expect(text).toContain('Open your pass: https://w.test/p/tok');
  });

  it('links Print only when the caller passes a print page', () => {
    const on = renderPassEmail({ ...base, printUrl: 'https://w.test/p/tok/print' });
    expect(on.html).toContain('href="https://w.test/p/tok/print"');
    expect(on.text).toContain('Print ticket: https://w.test/p/tok/print');
    const off = renderPassEmail({ ...base, printUrl: null });
    expect(off.html).not.toContain('/print');
  });
});
