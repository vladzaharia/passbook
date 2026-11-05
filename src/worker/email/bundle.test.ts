import { describe, expect, it } from 'vitest';
import { renderBundleEmail } from './bundle.ts';

const render = (over: Partial<Parameters<typeof renderBundleEmail>[0]> = {}) =>
  renderBundleEmail({
    orgName: 'Harbor <Lights>',
    bundleName: 'Family trip',
    pageUrl: 'https://w.test/b/t',
    addAllUrl: 'https://w.test/b/t/passes.pkpasses',
    badgeUrl: 'https://w.test/apple/badge/en/black@2x.png',
    passes: [
      { title: 'Mia', addUrl: 'https://w.test/b/t/p1/pass.pkpass' },
      { title: 'Old <pass>', addUrl: null },
    ],
    senderName: 'PassBook',
    ...over,
  });

describe('renderBundleEmail', () => {
  it('has the Add all badge, the page link and one row per pass', () => {
    const email = render();
    expect(email.subject).toBe('Your Harbor <Lights> passes');
    expect(email.html).toContain('href="https://w.test/b/t/passes.pkpasses"');
    expect(email.html).toContain('alt="Add to Apple Wallet"');
    expect(email.html).toContain('href="https://w.test/b/t"');
    expect(email.html).toContain('href="https://w.test/b/t/p1/pass.pkpass"');
    expect(email.text).toContain('Mia: https://w.test/b/t/p1/pass.pkpass');
    expect(email.text).toContain('Old <pass> (voided)');
    expect(email.fromName).toBe('Harbor <Lights> via PassBook');
  });

  it('escapes names and has no link for a voided pass', () => {
    const { html } = render();
    expect(html).not.toContain('Old <pass>');
    expect(html).toContain('Old &lt;pass&gt;');
    expect(html).toContain('Voided');
  });

  it('drops unsafe support contacts', () => {
    const { html } = render({ supportEmail: 'help@gym.test', supportUrl: 'javascript:alert(1)' });
    expect(html).toContain('mailto:help@gym.test');
    expect(html).not.toContain('javascript:');
  });

  it('marks every bordered cell for dark clients and gives the links a 44 px row', () => {
    const { html } = render();
    const cells = html.match(/<td[^>]*border-top:1px solid[^>]*>/g) ?? [];
    expect(cells).toHaveLength(4);
    for (const cell of cells) expect(cell).toContain('e-line');
    expect(html).toContain('.e-link{color:');
    expect(html).toMatch(/class="e-link"[^>]*padding:12px 0 12px 12px/);
  });

  it('counts the passes beside the name and shares the support footer', () => {
    const { html, text } = render({ supportEmail: 'help@harbor.test' });
    expect(html).toContain('Family trip · 2 passes');
    expect(text).toContain('Family trip · 2 passes');
    expect(html).toContain('Questions: <a href="mailto:help@harbor.test"');
    expect(text).toContain('Questions: help@harbor.test');
  });

  it('carries the amber strip in test mode only', () => {
    const live = render();
    expect(live.html).not.toContain('e-test"');
    const test = render({ mode: 'test' });
    expect(test.html).toContain('class="e-test"');
    expect(test.html).toContain('Test bundle. It is not real and will be deleted.');
    expect(test.text).toContain('Test bundle. It is not real and will be deleted.');
  });
});
