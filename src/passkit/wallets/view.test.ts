import { beforeAll, describe, expect, it } from 'vitest';
import { bakedSlugs, loadBaked } from '../template/baked-fixtures.ts';
import type { AssetEntry } from '../types.ts';
import type { RoleValue, WalletPassView } from './types.ts';
import { viewOf } from './view-fixtures.ts';

beforeAll(async () => {
  await loadBaked('starter-stamp-card'); // draws its strips once
}, 120_000);

const show = (role: RoleValue): string => {
  switch (role.kind) {
    case 'text':
      return role.text;
    case 'date':
      return role.iso;
    case 'location':
      return `${role.latitude},${role.longitude}`;
    case 'number':
      return String(role.number);
    case 'money':
      return `${role.amount} ${role.currencyCode}`;
    case 'channel':
      return role.channel;
    case 'url':
      return role.url;
    case 'app':
      return [role.name, role.url, role.logo].join('|');
    case 'links':
      return role.links.map((l) => l.url).join(' ');
  }
};

const summary = (view: WalletPassView) => ({
  style: view.style,
  schemes: view.preferredStyleSchemes,
  fields: view.fields.map((f) => f.path),
  roles: Object.fromEntries(
    Object.entries(view.roles).map(([role, v]) => [role, `${v.source} ${v.kind}: ${show(v)}`]),
  ),
  barcodes: view.barcodes.map((b) => `${b.kind} ${b.message}`),
  colors: view.colors,
  images: Object.fromEntries(
    Object.entries(view.images.apple).map(([slot, files]) => [slot, files.map((f) => f.name)]),
  ),
  relevance: {
    dates: view.relevance.dates,
    locations: view.relevance.locations.length,
    beacons: view.relevance.beacons.length,
  },
  validity: view.validity,
  urls: Object.keys(view.links.urls),
  featured: view.links.featuredActions.map((a) => a.type),
  events: view.events.map((e) => e.name),
  flags: [view.sharingProhibited, view.nfc, view.personalization],
  messaging: view.messaging,
  notes: view.notes,
});

describe('resolveWalletView over every starter and baked template', () => {
  it('covers all twenty-five packages', () => {
    expect(bakedSlugs()).toHaveLength(25);
  });

  it.each(bakedSlugs())('%s', async (slug) => {
    const view = await viewOf(slug);
    expect(view.roles.title, 'title always exists').toBeDefined();
    expect(view.org).toBeTruthy();
    expect(view.fields.length).toBeGreaterThan(0);
    expect(view.notes).toEqual([]);
    expect(summary(view)).toMatchSnapshot();
  });
});

describe('resolveWalletView parts', () => {
  it('does not take the relevance date as the event start', async () => {
    const view = await viewOf('starter-visitor-pass');
    expect(view.relevance.dates.length).toBeGreaterThan(0);
    expect(view.roles.eventStart).toBeUndefined();
    expect(view.roles.validFrom).toBeUndefined();
  });

  it('reads an event ticket as the poster style with its semantics', async () => {
    const view = await viewOf('starter-event-ticket');
    expect(view.style).toBe('eventTicket');
    expect(view.preferredStyleSchemes).toContain('posterEventTicket');
    expect(view.roles.eventName).toMatchObject({ source: 'semantics', text: 'Sample Event' });
    expect(view.roles.venueLocation).toMatchObject({ source: 'semantics', kind: 'location' });
    expect(view.events.length).toBeGreaterThan(1);
  });

  it('reads the store card balance as money and the member id from the barcode', async () => {
    const view = await viewOf('starter-store-card');
    expect(view.roles.balance).toMatchObject({ kind: 'money', amount: '25', currencyCode: 'USD' });
    expect(view.roles.memberId).toMatchObject({ source: 'style', text: 'CARD-0001' });
    expect(view.colors).toEqual({
      background: '#004b41',
      foreground: '#ffffff',
      label: '#f2d07d',
    });
    expect(view.sharingProhibited).toBe(true);
  });

  it('evaluates manifest roles in the expression scope and records failures as notes', async () => {
    const view = await viewOf('starter-store-card', {
      wallets: {
        schema: 1,
        roles: {
          tier: { value: '{{tier}} member' },
          points: { value: '{{balance}}' },
          memberName: { field: 'holder' },
          giftCardNumber: { value: '{{missing}}' },
          balance: false,
          eventId: { field: 'ghost' },
          validUntil: { value: 'soon' },
        },
      },
    });
    expect(view.roles.tier).toMatchObject({ source: 'manifest', text: 'Gold member' });
    expect(view.roles.points).toMatchObject({ kind: 'number', number: 25 });
    expect(view.roles.memberName).toMatchObject({
      source: 'manifest',
      text: 'Alex Morgan',
      fields: [view.fields.find((f) => f.key === 'holder')?.path],
    });
    expect(view.roles.balance, 'false removes the semantics hit').toBeUndefined();
    expect(view.notes.map((n) => `${n.code}:${n.subject}`).sort()).toEqual([
      'ROLE_EMPTY:giftCardNumber',
      'ROLE_FIELD_MISSING:eventId',
      'ROLE_VALUE_INVALID:validUntil',
    ]);
  });

  it('keeps personal images and their URLs out and resolves wallet art', async () => {
    const art: AssetEntry = {
      name: 'wallets/google/logo.png',
      slot: 'source',
      scale: 1,
      size: 10,
      sha1: 'x',
      crc32: 1,
      width: 660,
      height: 660,
      source: { kind: 'inline' },
    };
    const view = await viewOf('starter-store-card', {
      wallets: {
        schema: 1,
        google: { images: { logo: art.name, hero: 'wallets/google/gone.png' } },
      },
      ctx: {
        assets: [art],
        assetUrl: (name) => `https://img.example/${name}`,
      },
    });
    expect(view.images.overrides.google?.logo).toMatchObject({
      width: 660,
      personal: false,
      url: 'https://img.example/wallets/google/logo.png',
    });
    expect(view.images.overrides.samsung).toBeUndefined();
    expect(view.notes).toEqual([
      expect.objectContaining({ code: 'ART_MISSING', subject: 'wallets/google/gone.png' }),
    ]);
    const urls = Object.values(view.images.apple).flat();
    expect(urls.length).toBeGreaterThan(0);
    expect(urls.every((f) => f.url === `https://img.example/${f.name}`)).toBe(true);
  });

  it('carries only the locales asked for and flags an expired pass', async () => {
    const view = await viewOf('starter-coupon', {
      ctx: {
        locales: ['fr', 'en'],
        strings: { en: { a: 'A' }, fr: { a: 'Un' }, de: { a: 'Ein' } },
        now: new Date('2031-01-01T00:00:00Z'),
      },
    });
    expect(Object.keys(view.localization)).toEqual(['fr', 'en']);
    expect(view.validity.expired).toBe(true);
  });

  it('is deterministic', async () => {
    const a = await viewOf('starter-event-ticket');
    const b = await viewOf('starter-event-ticket');
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });
});
