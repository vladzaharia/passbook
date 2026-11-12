import { describe, expect, it } from 'vitest';
import { HOLDER_COPY } from '../../shared/copy/holder.ts';
import { assets, fixtures } from '../../shared/pass-view/fixtures/index.ts';
import { normalize } from '../../shared/pass-view/index.ts';
import { REPLAY_SCRIPT } from './hosted.ts';
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
    walletOffers: [],
    publicUrl: 'https://wallet.test/p/t',
    portalHref: '/passes/p1',
    voided: false,
    device: { device: 'other', inApp: false },
    support: { email: 'help@gym.test', url: 'https://gym.test/help' },
    ...over,
  });

// The CSS each class needs is checked in tools/ssr-holder.test.ts (Node reads the sheets).
describe('/p renders the portal HolderPassView', () => {
  it("shows Apple's black badge art whatever the theme", () => {
    for (const theme of ['dark', 'light', undefined] as const) {
      const html = page({
        ...(theme ? { theme } : {}),
        device: { device: 'iphone', inApp: false },
      });
      expect(html).toContain('src="/apple/badge/en/black.svg"');
      expect(html).not.toContain('<source');
    }
  });

  it('dips the card in CSS when the badge is pressed (no script)', () => {
    expect(page()).toContain('.wl-holder:has([data-awb]:active) .pc-lift{animation:pc-dip');
  });

  const body = (html: string) => html.slice(html.indexOf('<body>'));
  const PORTAL_LINK =
    /<p class="text-sm"><a href="\/passes\/p1" class="[^"]*">Open in My passes<\/a><\/p>/;

  it('heads the page with what the pass is: the kind alone (the bar names the org), the portal link beside', () => {
    const html = page();
    expect(html).toContain('<title>Example Org example pass</title>');
    const b = body(html);
    expect(b.match(/<h1/g)).toHaveLength(1);
    expect(b).toMatch(/<h1[^>]*>Example pass<\/h1>/);
    expect(b).not.toMatch(/<p class="[^"]*">Example Org<\/p><h1/);
    expect(b.match(/Open in My passes/g)).toHaveLength(1);
    expect(b).toMatch(PORTAL_LINK);
  });

  it('leads with the QR off Apple devices and keeps the Apple badge accessible', () => {
    const b = body(page());
    expect(b).toMatch(
      /<div class="wl-sign"><span [^>]*data-scene="nudge"[^>]*data-run="load"[\s\S]*?<img src="data:image\/svg\+xml/,
    );
    expect(b).toContain(HOLDER_COPY.scanLine);
    expect(b).toContain('data-awb');
    expect(b).toContain(HOLDER_COPY.openOnApple);
    expect(b).toMatch(/class="wl-holder-help [^"]*"><p class="[^"]*">Help:/);
    // A click replays the scene, as on the hosted pages.
    expect(page()).toContain(REPLAY_SCRIPT);
  });

  it('puts the Apple badge beside the QR on a Mac without hiding it on touch screens', () => {
    const b = body(page({ device: { device: 'mac', inApp: false } }));
    expect(b).toMatch(/<div class="wl-way">[\s\S]*?Apple Wallet[\s\S]*?data-awb=""/);
    expect(page()).not.toContain('wl-mac-only');
  });

  it.each([
    { device: 'iphone', inApp: false },
    { device: 'iphone', inApp: true },
    { device: 'mac', inApp: false },
    { device: 'other', inApp: false },
  ] as const)('shows both available provider links on $device (inApp: $inApp)', (device) => {
    const walletOffers = [
      { provider: 'google', href: '/p/t/wallet/google', installation: 'unknown' },
      { provider: 'samsung', href: '/p/t/wallet/samsung', installation: 'unknown' },
    ] as const;
    const html = page({ device, walletOffers });
    const b = body(html);
    expect(html).toContain('property="og:description" content="Add it to your wallet."');
    expect(b).toContain('href="/p/t/pass.pkpass"');
    expect(b).toContain('href="/p/t/wallet/google"');
    expect(b).toContain('href="/p/t/wallet/samsung"');
    expect(b).toContain(
      'src="/icons/wallet-providers/google/add-to-google-wallet.svg" alt="Add to Google Wallet"',
    );
    expect(b).toContain(
      'src="/icons/wallet-providers/samsung/add-to-samsung-wallet.png" alt="Add to Samsung Wallet"',
    );
    expect(b).not.toMatch(/(?:Google|Samsung) Wallet (?:installed|removed)/i);
  });

  it('recommends the browser barcode off Apple devices, with Apple still reachable and no script needed', () => {
    const html = page({ barcodeHref: '/p/t/barcode' });
    const b = body(html);
    expect(b.indexOf(HOLDER_COPY.bestForDevice)).toBeLessThan(b.indexOf(HOLDER_COPY.browserTitle));
    expect(b.indexOf(HOLDER_COPY.browserTitle)).toBeLessThan(b.indexOf(HOLDER_COPY.otherWays));
    expect(b.indexOf(HOLDER_COPY.otherWays)).toBeLessThan(b.indexOf('data-awb'));
    expect(b).toContain('href="/p/t/barcode"');
    expect(b).toContain('href="/p/t/pass.pkpass"');
    expect(b).not.toContain('<script');
  });

  it('recommends Apple on an iPhone, the browser barcode after it', () => {
    const b = body(
      page({ barcodeHref: '/p/t/barcode', device: { device: 'iphone', inApp: false } }),
    );
    expect(b.indexOf(HOLDER_COPY.bestForDevice)).toBeLessThan(b.indexOf('data-awb'));
    expect(b.indexOf('data-awb')).toBeLessThan(b.indexOf(HOLDER_COPY.otherWays));
    expect(b.indexOf(HOLDER_COPY.otherWays)).toBeLessThan(b.indexOf(HOLDER_COPY.browserTitle));
  });

  it('drops a native wallet whose issuance is disabled', () => {
    const google = {
      provider: 'google',
      href: '/p/t/wallet/google',
      installation: 'unknown',
    } as const;
    const b = body(
      page({
        walletOffers: [google],
        issuance: { google: { state: 'disabled', reason: 'not_released' } },
      }),
    );
    expect(b).not.toContain('Add to Google Wallet');
  });

  it('omits unavailable alternatives and suppresses all offers for non-active passes', () => {
    const google = {
      provider: 'google',
      href: '/p/t/wallet/google',
      installation: 'unknown',
    } as const;
    const b = body(page({ walletOffers: [google] }));
    expect(b).toContain('href="/p/t/wallet/google"');
    expect(b).not.toContain('Add to Samsung Wallet');
    for (const over of [
      { voided: true },
      { removal: { message: null } },
      { view: view({ expirationDate: '2020-01-01T00:00:00Z' }) },
    ]) {
      expect(body(page({ ...over, walletOffers: [google] }))).not.toContain('Add to Google Wallet');
    }
  });

  it('renders only capability links, not provider token metadata', () => {
    const secret = 'provider-bearer-jwt-must-not-be-rendered';
    const offer = {
      provider: 'google',
      href: '/p/t/wallet/google',
      installation: 'unknown',
      providerToken: secret,
    } as const;
    const html = page({ walletOffers: [offer] });
    expect(html).toContain('href="/p/t/wallet/google"');
    expect(html).not.toContain(secret);
  });

  it('leads with the badge’s card on the iPhone, the buddy on it pointing at the badge', () => {
    const b = body(page({ device: { device: 'iphone', inApp: false } }));
    expect(b).toContain('<div class="wl-holder" data-lead="add"');
    expect(b).toMatch(
      /<div class="wl-add-here [^"]*"><span [^>]*data-scene="nudge"[\s\S]*?data-awb=""/,
    );
    expect(b).not.toContain('wl-sign');
  });

  it('seats the buddy on a voided notice, sad; no badge, the portal link stays', () => {
    const b = body(page({ voided: true }));
    expect(b).toMatch(/<div class="wl-add-seat"><span [^>]*data-scene="tear"/);
    expect(b).not.toContain('data-awb');
    expect(b).toMatch(PORTAL_LINK);
  });
});
