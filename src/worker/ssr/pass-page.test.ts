import { describe, expect, it } from 'vitest';
import { CHANNEL_COPY } from '../../shared/copy/channels.ts';
import { HOLDER_COPY } from '../../shared/copy/holder.ts';
import { MAC_REVEAL_SCRIPT } from '../../shared/device.ts';
import { assets, fixtures } from '../../shared/pass-view/fixtures/index.ts';
import { normalize } from '../../shared/pass-view/index.ts';
import { REPLAY_SCRIPT } from './hosted.ts';
import { type PassPageProps, renderNotFoundPage, renderPassPage } from './pass-page.tsx';

const view = (over: Record<string, unknown> = {}) =>
  normalize(
    { ...fixtures.generic, ...over },
    { assets, now: new Date('2026-10-31T12:00:00Z'), timeZone: 'UTC' },
  );

const page = (over: Partial<PassPageProps> = {}) =>
  renderPassPage({
    view: view(),
    passJson: { ...fixtures.generic },
    now: new Date('2026-10-31T12:00:00Z'),
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

  it('says the code changed above the add block, only when a notice is given', () => {
    const html = page({ notice: CHANNEL_COPY.codesReplaced });
    expect(html).toContain(CHANNEL_COPY.codesReplacedTitle);
    expect(html).toContain(CHANNEL_COPY.codesReplaced);
    expect(html).toMatch(/role="status"[^>]*>[\s\S]*Your code changed/);
    expect(page()).not.toContain(CHANNEL_COPY.codesReplaced);
    expect(page({ notice: CHANNEL_COPY.codesReplaced, voided: true })).not.toContain(
      CHANNEL_COPY.codesReplaced,
    );
  });

  it('dips the card in CSS when the badge is pressed (no script)', () => {
    expect(page()).toContain('.wl-holder:has([data-awb]:active) .pc-lift{animation:pc-dip');
  });

  const body = (html: string) => html.slice(html.indexOf('<body>'));
  const PORTAL_ROW =
    /<a class="wl-other" href="\/passes\/p1">(?:(?!<\/a>)[\s\S])*?<span>My passes<\/span>/;
  const RESEND = { action: '/p/t/resend', again: null } as const;

  it('heads the page with what the pass is: the kind alone (the bar names the org), nothing beside', () => {
    const html = page();
    expect(html).toContain('<title>Example Org example pass</title>');
    const b = body(html);
    expect(b.match(/<h1/g)).toHaveLength(1);
    expect(b).toMatch(/<h1[^>]*>Example pass<\/h1>/);
    expect(b).not.toMatch(/<p class="[^"]*">Example Org<\/p><h1/);
    expect(b).not.toContain('Open in My passes');
    expect(b).not.toMatch(PORTAL_ROW);
  });

  it('lists My passes in the other ways, before Email me this pass again, with a holder email', () => {
    const b = body(page({ resend: RESEND }));
    expect(b.match(/<span>My passes<\/span>/g)).toHaveLength(1);
    expect(b).toMatch(PORTAL_ROW);
    expect(b.indexOf('<span>My passes</span>')).toBeLessThan(b.indexOf('Email me this pass again'));
  });

  it('leads with the QR on a computer, the buddy on its card clear of the code, no badge', () => {
    const b = body(page());
    expect(b).toMatch(
      /<div class="wl-hero wl-hero-scan"><span [^>]*data-scene="nudge"[^>]*data-run="load"[\s\S]*?<div class="wl-sign"><span[^>]*><img src="data:image\/svg\+xml/,
    );
    expect(b).toContain(HOLDER_COPY.scanLine);
    // The badge would download a file nothing on this computer opens.
    expect(b).not.toContain('data-awb');
    expect(b).not.toContain(HOLDER_COPY.openOnApple);
    expect(b).toMatch(/class="wl-holder-help [^"]*"><p class="[^"]*">Help:/);
    // A click replays the scene, as on the hosted pages.
    expect(page()).toContain(REPLAY_SCRIPT);
  });

  it('cannot tell a Mac from an iPad: the badge starts hidden and a nonced script shows it on a Mac', () => {
    const html = page({ device: { device: 'mac', inApp: false } });
    expect(body(html)).toMatch(/<div class="wl-way wl-way-here" hidden="" data-mac-only="">/);
    expect(html).toContain(`<script nonce="n0nce">${MAC_REVEAL_SCRIPT}</script>`);
    // No Mac agent, no script and nothing hidden.
    const phone = page({ device: { device: 'iphone', inApp: false } });
    expect(phone).not.toContain('data-mac-only');
    expect(phone).not.toContain(MAC_REVEAL_SCRIPT);
  });

  it('puts the Apple badge under the scan line on a Mac, as the quiet second way', () => {
    const b = body(page({ device: { device: 'mac', inApp: false } }));
    expect(b).toMatch(
      new RegExp(
        `${HOLDER_COPY.scanLine}[\\s\\S]*?wl-way-here[\\s\\S]*?${HOLDER_COPY.onThisMac}[\\s\\S]*?data-awb=""`,
      ),
    );
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
    if (device.device !== 'other') expect(b).toContain('href="/p/t/pass.pkpass"');
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

  it('leads with the QR on a computer, the browser barcode a quiet row after it, no script', () => {
    const b = body(page({ barcodeHref: '/p/t/barcode' }));
    expect(b.indexOf('wl-hero-scan')).toBeLessThan(
      b.indexOf(`aria-label="${HOLDER_COPY.otherWays}"`),
    );
    expect(b).toMatch(
      /<ul class="wl-others" aria-label="Other ways"><li[^>]*><a class="wl-other" href="\/p\/t\/barcode">/,
    );
    expect(b).not.toContain('<script');
  });

  it('labels neither the lead nor the other ways', () => {
    const b = body(
      page({ barcodeHref: '/p/t/barcode', device: { device: 'iphone', inApp: false } }),
    );
    expect(b).not.toContain('Best for this device');
    expect(b).not.toContain('>Other ways<');
  });

  it('recommends Apple on an iPhone, the browser barcode after it', () => {
    const b = body(
      page({ barcodeHref: '/p/t/barcode', device: { device: 'iphone', inApp: false } }),
    );
    expect(b.indexOf('data-awb')).toBeLessThan(b.indexOf(`aria-label="${HOLDER_COPY.otherWays}"`));
    expect(b.indexOf(`aria-label="${HOLDER_COPY.otherWays}"`)).toBeLessThan(
      b.indexOf('href="/p/t/barcode"'),
    );
  });

  it('leads with the badge on a phone and shows the QR only off the phone', () => {
    const phone = body(page({ device: { device: 'iphone', inApp: false } }));
    expect(phone).not.toContain(HOLDER_COPY.scanLine);
    expect(phone).toContain('data-awb');
    const desktop = body(page({ device: { device: 'other', inApp: false } }));
    expect(desktop).toContain(HOLDER_COPY.scanLine);
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
      /<div class="wl-hero wl-hero-phone"><span [^>]*data-scene="nudge"[\s\S]*?data-awb=""/,
    );
    expect(b).not.toContain('wl-sign');
  });

  it('seats the buddy on a voided notice, sad; no badge, and no other ways', () => {
    const b = body(page({ voided: true, resend: RESEND }));
    expect(b).toMatch(/<div class="wl-add-seat"><span [^>]*data-scene="tear"/);
    expect(b).not.toContain('data-awb');
    // The ended card's own action is the way back in.
    expect(b).not.toMatch(PORTAL_ROW);
  });

  it.each([['android'], ['galaxy']] as const)(
    'drops the Apple badge and QR on %s and keeps one text line',
    (device) => {
      const b = body(page({ device: { device, inApp: false }, barcodeHref: '/p/t/barcode' }));
      expect(b).not.toContain('data-awb');
      expect(b).not.toContain('wl-add-scan');
      expect(b).not.toContain('/apple/badge/');
      expect(b).toContain('href="/p/t/barcode"');
      expect(b.split(HOLDER_COPY.appleElsewhere)).toHaveLength(2);
      expect(b).not.toContain(HOLDER_COPY.openOnApple);
      // The barcode leads; Apple's line is a row of the other ways.
      expect(b).toMatch(/<a class="wl-hero-action" href="\/p\/t\/barcode">/);
      expect(b.indexOf('wl-hero-action')).toBeLessThan(b.indexOf(HOLDER_COPY.appleElsewhere));
    },
  );

  describe('save to this phone', () => {
    const TOKEN = 'demodemodemodemodemo';
    const android = {
      device: { device: 'android', inApp: false },
      barcodeHref: `/p/${TOKEN}/barcode`,
      publicUrl: `https://wallet.test/p/${TOKEN}`,
    } as const;

    it('marks the page for the shared script, which is the only script it adds', () => {
      const html = page(android);
      expect(html).toContain(`data-save-phone="/p/${TOKEN}/barcode"`);
      expect(html).toContain('<script src="/p/save.js" defer></script>');
      expect(html).toContain('data-save-do');
      expect(html).toContain('data-save-drop');
      expect(html).toContain('<dialog');
      expect(html).toContain(HOLDER_COPY.homeScreenTitle);
      // The lead stays a link to the door view without script, and the saved face offers the door.
      expect(html).toMatch(/<a class="wl-hero-action" href="\/p\/\w+\/barcode" data-save-do/);
      expect(html).toContain(HOLDER_COPY.showAtDoor);
      expect(html.replace(/<style[\s\S]*?<\/style>/g, '')).not.toMatch(/<script nonce/);
    });

    it('is absent where nothing can be saved: Apple devices, no door view, a foreign path', () => {
      expect(page({ ...android, device: { device: 'iphone', inApp: false } })).not.toContain(
        'data-save-phone',
      );
      expect(page({ ...android, barcodeHref: undefined })).not.toContain('data-save-phone');
      expect(page({ ...android, publicUrl: 'https://wallet.test/x/y' })).not.toContain(
        'data-save-phone',
      );
    });

    it('marks an ended pass so the page drops any saved copy', () => {
      const html = page({ ...android, voided: true });
      expect(html).toContain(`data-save-ended="/p/${TOKEN}/barcode"`);
      expect(html).not.toContain('data-save-phone');
      expect(html).not.toContain('<dialog');
    });
  });

  it('words the link preview the same on every device', () => {
    for (const device of ['iphone', 'android', 'other'] as const) {
      expect(page({ device: { device, inApp: false } })).toContain(
        `property="og:description" content="${HOLDER_COPY.previewActive}"`,
      );
    }
    expect(HOLDER_COPY.previewActive).not.toMatch(/Apple/);
  });
});

describe('dead links', () => {
  it('names the pass or the bundle and never claims an expiry', () => {
    const pass = renderNotFoundPage('n');
    const bundle = renderNotFoundPage('n', undefined, { what: 'bundle' });
    expect(pass).toContain('<h1>This pass link does not work</h1>');
    expect(bundle).toContain('<h1>This bundle link does not work</h1>');
    for (const html of [pass, bundle])
      expect(html.slice(html.indexOf('<body')).replace(/<[^>]*>/g, ' ')).not.toMatch(
        /expired|rotated|existed/i,
      );
  });
});
