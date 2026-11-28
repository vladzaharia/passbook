import { describe, expect, it } from 'vitest';
import type { PassJson } from '../../passkit/types.ts';
import { assets } from '../../shared/pass-view/fixtures/index.ts';
import { normalize } from '../../shared/pass-view/index.ts';
import type { HolderSupport } from '../../web/portal/holder-pass-view.tsx';
import { BUNDLE_COPY, type BundlePageItem, renderBundlePage } from './bundle-page.tsx';

const json = (): PassJson =>
  ({
    formatVersion: 1,
    organizationName: 'Northwind',
    description: 'Membership',
    serialNumber: 's',
    passTypeIdentifier: 'pass.x',
    teamIdentifier: 'T',
    generic: {
      headerFields: [{ key: 'status', label: 'Status', value: 'Active' }],
      primaryFields: [{ key: 'holder', label: 'Name', value: 'Maya Chen' }],
    },
  }) as unknown as PassJson;

const item = (id: string, state: BundlePageItem['state'], detail: string): BundlePageItem => ({
  id,
  title: 'Maya Chen',
  detail,
  state,
  view: normalize(json(), {
    assets,
    ...(state === 'voided' ? { stateWord: 'Voided' } : {}),
  }),
  href: `/b/t/${id}/open`,
  downloadHref: `/b/t/${id}/pass.pkpass`,
  barcodeHref: `/b/t/${id}/barcode`,
});

const render = (
  items: BundlePageItem[],
  support: HolderSupport = { email: 'desk@northwind.test', url: null },
) =>
  renderBundlePage({
    nonce: 'n',
    orgName: 'Northwind',
    orgLabel: 'Northwind',
    name: 'Trip',
    items,
    addAllHref: '/b/t/passes.pkpasses',
    publicUrl: 'https://w.test/b/t',
    device: { device: 'iphone', inApp: false },
    support,
  });
const text = (html: string) => html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');

describe('/b with a voided pass', () => {
  const html = render([item('a', 'active', 'Tier: Plus'), item('b', 'voided', 'Tier: Pro')]);

  it('counts what is voided and what is removed', () => {
    expect(BUNDLE_COPY.extras(1, 1)).toBe('1 voided · 1 removed');
    expect(text(html)).toContain('1 voided');
    expect(text(html)).not.toContain('2 passes');
  });

  it('keeps the voided pass as a dim peek named Voided, counted under the title', () => {
    expect(html).toContain('data-dim');
    expect(html).toContain('Maya Chen, Tier: Pro, Voided');
    expect(text(html).match(/Status\s+Active/g)?.length).toBe(1);
  });

  it('names each pass by its tier so same-titled passes read apart', () => {
    expect(text(html)).toContain('Maya Chen Tier: Plus');
    expect(html).toContain('Maya Chen, Tier: Pro, Voided');
  });

  it('asks the org for a new pass when it has no contact', () => {
    const bare = render([item('b', 'voided', 'Tier: Pro')], { email: null, url: null });
    expect(text(bare)).toContain('Ask Northwind for a new pass.');
  });
});

describe('/b with nothing to add', () => {
  const only = (states: BundlePageItem['state'][]) =>
    text(render(states.map((state, i) => item(`p${i}`, state, 'Tier: Pro'))));

  it('says removed when every pass was removed, never voided', () => {
    const body = only(['removed', 'removed']);
    expect(body).toContain('These passes were removed.');
    expect(body).not.toContain('These passes were voided.');
  });

  it('says voided when every pass was voided', () => {
    expect(only(['voided', 'voided'])).toContain('These passes were voided.');
  });

  it('says neither when voided and removed are mixed', () => {
    const body = only(['voided', 'removed']);
    expect(body).toContain('None of these passes can be added.');
    expect(body).not.toContain('were voided.');
    expect(body).not.toContain('were removed.');
  });
});

describe('native wallet links in a bundle', () => {
  const walletOf = (id: string): BundlePageItem => ({
    ...item(id, 'active', 'Tier: Plus'),
    walletOffers: [{ provider: 'google', href: `/b/t/${id}/wallet/google` }],
  });

  it('links Google under the pass that has an offer and under no other', () => {
    const html = render([walletOf('a'), item('b', 'active', 'Tier: Pro')]);
    expect(html).toContain('href="/b/t/a/wallet/google"');
    expect(html).toContain('Add to Google Wallet');
    expect(html).not.toContain('/b/t/b/wallet/');
  });

  it('shows no wallet link for a voided pass', () => {
    const html = render([{ ...walletOf('a'), state: 'voided' }]);
    expect(html).not.toContain('/wallet/google');
  });
});

describe('/b as a stack', () => {
  const html = render([
    item('a', 'active', 'Tier: Plus'),
    item('b', 'active', 'Tier: Pro'),
    item('c', 'active', 'Tier: Max'),
  ]);

  it('fronts the first pass and lays the rest as plain-link peeks', () => {
    expect(html.match(/class="wl-stack-front"/g)).toHaveLength(1);
    expect(html).toContain('<a class="wl-peek" href="/b/t/b/open"');
    expect(html).toContain('<a class="wl-peek" href="/b/t/c/open"');
    expect(html).not.toContain('href="/b/t/a/open"');
  });

  it('counts once: All passes (3) on the badge, none under the title, no My passes link', () => {
    expect(text(html)).toContain('All passes (3)');
    expect(text(html).match(/3 passes/g)).toBeNull();
    expect(text(html)).not.toContain('My passes');
    expect(text(html)).not.toContain('Open in');
  });

  it('adds no script for the stack', () => {
    expect(html).not.toMatch(/<script(?![^>]*\ssrc=)/);
  });
});
