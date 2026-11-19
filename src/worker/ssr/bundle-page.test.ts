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
    expect(BUNDLE_COPY.summary(3, 1, 1)).toBe('3 passes · 1 voided · 1 removed');
    expect(text(html)).toContain('2 passes · 1 voided');
  });

  it('shows the voided card as Voided, never Active, with who to ask', () => {
    expect(text(html)).toContain('No longer valid. Contact Northwind');
    expect(text(html).match(/Status\s+Active/g)?.length).toBe(1);
  });

  it('names each pass by its tier so same-titled passes read apart', () => {
    expect(text(html)).toContain('Maya Chen Tier: Plus');
    expect(text(html)).toContain('Maya Chen Tier: Pro');
  });

  it('asks the org for a new pass when it has no contact', () => {
    const bare = render([item('b', 'voided', 'Tier: Pro')], { email: null, url: null });
    expect(text(bare)).toContain('Ask Northwind for a new pass.');
  });
});
