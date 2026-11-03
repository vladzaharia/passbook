import { describe, expect, it } from 'vitest';
import { HOLDER_COPY } from '../../shared/copy/holder.ts';
import { assets, fixtures } from '../../shared/pass-view/fixtures/index.ts';
import { normalize } from '../../shared/pass-view/index.ts';
import { type PassPageProps, renderPassPage } from './pass-page.tsx';

const view = (over: Record<string, unknown> = {}) =>
  normalize(
    { ...fixtures.generic, ...over },
    { assets, now: new Date('2026-10-31T12:00:00Z'), timeZone: 'UTC' },
  );

const page = (over: Partial<PassPageProps> = {}) =>
  renderPassPage({
    view: view(),
    nonce: 'n0nce',
    orgName: 'Gym',
    orgLabel: 'Gym',
    passTitle: 'Membership',
    downloadHref: '/p/t/pass.pkpass',
    publicUrl: 'https://wallet.test/p/t',
    portalHref: '/passes/p1',
    voided: false,
    device: { device: 'other', inApp: false },
    support: { email: 'help@gym.test', url: 'https://gym.test/help' },
    ...over,
  });

// The CSS each class needs is checked in tools/ssr-holder.test.ts (Node reads the sheets).
describe('/p renders the portal HolderPassView', () => {
  it('stamps the chosen theme on the badge art, else lets the OS pick', () => {
    const dark = page({ theme: 'dark', device: { device: 'iphone', inApp: false } });
    expect(dark).toContain('src="/apple/badge/en/outline.svg"');
    expect(dark).not.toContain('<source');
    const system = page({ device: { device: 'iphone', inApp: false } });
    expect(system).toContain('<source srcSet="/apple/badge/en/outline.svg"');
  });

  it('dips the card in CSS when the badge is pressed (no script)', () => {
    expect(page()).toContain('.wl-holder:has([data-awb]:active) .pc-lift{animation:pc-dip');
  });

  const body = (html: string) => html.slice(html.indexOf('<body>'));
  const PORTAL_LINK =
    /<p class="text-sm"><a href="\/passes\/p1" class="[^"]*">Open in My passes<\/a><\/p>/;

  it('stacks the badge and the portal link beside the QR off the phone', () => {
    const html = body(page());
    // The phone with its caption, then one column: the badge, then the quiet link.
    const add = new RegExp(
      `class="wl-qr-phone [\\s\\S]*?<p class="[^"]*">${HOLDER_COPY.scanQr}</p></div><div class="flex w-fit flex-col gap-3\\.5 pointer-coarse:gap-2"><a [^>]*data-awb=""[^>]*class="[^"]*p-0[^"]*">[\\s\\S]*?</a>${PORTAL_LINK.source}</div>`,
    );
    expect(html).toMatch(add);
    expect(html.match(/Open in My passes/g)).toHaveLength(1);
    // The add line closes the block; the footer keeps only the org's help.
    expect(html).toContain(`<p class="text-sm text-fg-muted">${HOLDER_COPY.openOnApple}</p>`);
    expect(html).toMatch(/<div class="border-t border-border pt-4"><p class="[^"]*">Help:/);
  });

  it('puts the portal link after the badge in a row on the phone', () => {
    const html = body(page({ device: { device: 'iphone', inApp: false } }));
    expect(html).not.toContain('wl-qr-phone');
    expect(html).toMatch(
      new RegExp(
        `<div class="flex flex-wrap items-center gap-2"><a [^>]*data-awb=""[\\s\\S]*?</a><div class="flex items-center gap-2">${PORTAL_LINK.source}</div></div>`,
      ),
    );
  });

  it('keeps the portal link on a voided pass, without the badge', () => {
    const html = body(page({ voided: true }));
    expect(html).not.toContain('data-awb');
    expect(html).toMatch(PORTAL_LINK);
  });
});
