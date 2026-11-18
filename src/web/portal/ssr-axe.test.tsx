import { describe, expect, it } from 'vitest';
import { axe } from 'vitest-axe';
import { assets, fixtures } from '@/shared/pass-view/fixtures/index.ts';
import { normalize } from '@/shared/pass-view/index.ts';
import { type PassPageProps, renderPassPage } from '../../worker/ssr/pass-page.tsx';

const view = (over: Record<string, unknown> = {}) =>
  normalize(
    { ...fixtures.generic, ...over },
    { assets, now: new Date('2026-10-31T12:00:00Z'), timeZone: 'UTC' },
  );

const html = (over: Partial<PassPageProps> = {}) =>
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
    device: { device: 'iphone', inApp: false },
    support: { email: 'help@gym.test', url: null },
    resend: { action: '/p/t/resend', again: 'sent' },
    ...over,
  });

const documentOf = (markup: string) => new DOMParser().parseFromString(markup, 'text/html');

describe('the full /p document passes axe', () => {
  it.each([
    ['active', {}],
    ['voided', { voided: true, endedOn: '3 November 2026' }],
    [
      'expired',
      { view: view({ expirationDate: '2026-10-01T00:00:00Z' }), endedOn: '1 October 2026' },
    ],
  ] as const)('%s', async (_name, over) => {
    const doc = documentOf(html(over));
    expect(doc.documentElement.lang).toBe('en');
    expect(doc.title).not.toBe('');
    expect((await axe(doc.documentElement)).violations).toEqual([]);
  });
});
