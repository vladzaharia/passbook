import { describe, expect, it } from 'vitest';
import type { PassJson } from '../../passkit/types.ts';
import { assets } from '../../shared/pass-view/fixtures/index.ts';
import { normalize } from '../../shared/pass-view/index.ts';
import { renderNotFoundPage, renderPassPage } from './pass-page.tsx';

const NOW = new Date('2026-11-19T12:00:00Z');
const json = {
  formatVersion: 1,
  organizationName: 'Northwind',
  description: 'Membership',
  serialNumber: 's',
  passTypeIdentifier: 'pass.x',
  teamIdentifier: 'T',
  generic: {
    primaryFields: [{ key: 'holder', label: 'Name', value: 'Maya Chen' }],
    backFields: [{ key: 'terms', label: 'Terms', value: 'Present the barcode.' }],
  },
} as unknown as PassJson;

const page = (over: Record<string, unknown> = {}) =>
  renderPassPage({
    view: normalize(json, { assets, now: NOW }),
    passJson: json,
    now: NOW,
    nonce: 'n',
    orgName: 'Northwind',
    orgLabel: 'Northwind',
    passTitle: 'Maya Chen',
    downloadHref: '/p/t/pass.pkpass',
    walletOffers: [],
    publicUrl: 'https://wallet.test/p/t',
    portalHref: '/passes/p1',
    voided: false,
    device: { device: 'iphone', inApp: false },
    signin: { action: '/p/t/sign-in', state: null },
    ...over,
  });
const text = (html: string) => html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
const support = { email: 'desk@northwind.test', url: null };

describe('the ended card on /p', () => {
  it('voided with a contact: the sentence, Contact first, then Email me my passes', () => {
    const html = page({ voided: true, endedOn: 'Nov 18, 2026', support });
    expect(text(html)).toContain('This pass was voided on Nov 18, 2026.');
    expect(html.indexOf('Contact Northwind')).toBeGreaterThan(-1);
    expect(html.indexOf('Contact Northwind')).toBeLessThan(html.indexOf('Email me my passes'));
    expect(html).toMatch(/<form (?=[^>]*method="post")(?=[^>]*action="\/p\/t\/sign-in")/);
    expect(html).toContain('data-scene="tear"');
  });

  it('expired without a contact: Email me my passes alone, and the sad buddy', () => {
    const view = normalize(
      { ...json, expirationDate: '2020-01-01T00:00:00Z' } as unknown as PassJson,
      { assets, now: NOW },
    );
    const expired = page({ view, endedOn: 'Sep 30, 2025' });
    expect(text(expired)).toContain('This pass expired on Sep 30, 2025.');
    expect(expired).not.toContain('Contact Northwind');
    expect(expired).toContain('Email me my passes');
    expect(expired).toContain('data-mood="sad"');
  });

  it('removed: the sentence and the org note, no contact', () => {
    const html = page({ removal: { message: 'Season ended.' }, support });
    expect(text(html)).toContain('This pass was removed. Season ended.');
    expect(html).not.toContain('Contact Northwind');
    expect(html).toContain('Email me my passes');
  });

  it('keeps the card at its still size and the fields behind Details', () => {
    const html = page({ voided: true, support });
    expect(html).toContain('max-w-[16rem]');
    expect(html).not.toContain('max-w-[22rem]');
    expect(html).toMatch(/<details class="wl-ended-details"><summary>[\s\S]*?Details<\/summary>/);
  });

  it('no contact and no email: asks the org for a new pass, with no form', () => {
    const html = page({ voided: true, signin: undefined });
    expect(text(html)).toContain('Ask Northwind for a new pass.');
    expect(html).not.toContain('/sign-in');
  });

  it('answers ?signin= in place of the button, and names no address', () => {
    const sent = page({ voided: true, signin: { action: '/p/t/sign-in', state: 'sent' } });
    expect(text(sent)).toContain('Sent. Check your email.');
    expect(sent).not.toContain('/p/t/sign-in');
    const wait = page({ voided: true, signin: { action: '/p/t/sign-in', state: 'wait' } });
    expect(text(wait)).toContain('Sent a few already. Try again in an hour.');
  });

  it('a live pass shows no ended card and the full-size card', () => {
    const html = page();
    expect(html).not.toContain('wl-ended-details');
    expect(html).not.toContain('Email me my passes');
  });
});

describe('the dead link page', () => {
  it('opens the login with the link reason and names nothing', () => {
    const html = renderNotFoundPage('n');
    expect(html).toContain('href="/login?next=/&amp;reason=link"');
    expect(text(html)).toContain('This pass link does not work It may have been replaced.');
    expect(text(html)).toContain('Email me my passes');
  });
});
