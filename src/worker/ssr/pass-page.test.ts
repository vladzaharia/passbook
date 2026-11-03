import { describe, expect, it } from 'vitest';
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
});
