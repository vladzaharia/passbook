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

  it('heads the page with what the pass is: the org over the kind, the portal link beside', () => {
    const html = page();
    expect(html).toContain('<title>Example Org example pass</title>');
    const b = body(html);
    expect(b.match(/<h1/g)).toHaveLength(1);
    expect(b).toMatch(/<p class="[^"]*">Example Org<\/p><h1[^>]*>Example pass<\/h1>/);
    expect(b.match(/Open in My passes/g)).toHaveLength(1);
    expect(b).toMatch(PORTAL_LINK);
  });

  it('leads with the QR on the buddy’s sign off Apple’s devices, without the badge', () => {
    const b = body(page());
    expect(b).toMatch(
      /<div class="wl-sign"><span [^>]*data-scene="nudge"[^>]*data-run="load"[\s\S]*?<img src="data:image\/svg\+xml/,
    );
    expect(b).toContain(HOLDER_COPY.scanLine);
    expect(b).not.toContain('data-awb');
    expect(b).not.toContain(HOLDER_COPY.openOnApple);
    expect(b).toMatch(/class="wl-holder-help [^"]*"><p class="[^"]*">Help:/);
    // A click replays the scene, as on the hosted pages.
    expect(page()).toContain(REPLAY_SCRIPT);
  });

  it('puts the badge beside the QR on a Mac, which a touch screen (an iPad) hides', () => {
    const b = body(page({ device: { device: 'mac', inApp: false } }));
    expect(b).toMatch(
      new RegExp(
        `<div class="wl-way wl-mac-only">[\\s\\S]*?${HOLDER_COPY.mac}[\\s\\S]*?data-awb=""`,
      ),
    );
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
