import { describe, expect, it } from 'vitest';
import type { BehaviorContext, PassJson } from '../../types.ts';
import { type VenueLocationsConfig, venueLocations } from './index.ts';

const venues = {
  a: { name: 'Alpha', street: '1 A St', address: '1 A St, Town', lat: 1, lng: 2, place: 'I1' },
  b: { name: 'Beta', street: '2 B St', address: '2 B St, Town', lat: 3, lng: 4, maxDistance: 50 },
};
const ctx: BehaviorContext = {
  now: new Date(0),
  identity: { passTypeIdentifier: 'p', teamIdentifier: 't' },
  lookups: { venues },
};
const config: VenueLocationsConfig = {
  venues: 'venues',
  homeInput: 'home',
  accessInput: 'access',
  allValue: 'all',
  relevantText: '{{venue.name}} club · {{venue.street}}',
  placeAction: { identifier: 'home-place' },
  directions: {
    key: 'dir-{{venue.id}}',
    label: '{{venue.name}}',
    value: '{{venue.address}}',
    linkText: 'Directions to {{venue.name}}',
    url: 'https://maps.apple.com/?daddr={{venue.lat}},{{venue.lng}}',
    after: 'portal',
    keySuffix: { posterGeneric: '-poster' },
  },
};

function pass(): PassJson {
  return {
    maxDistance: 150,
    featuredActions: [{ identifier: 'home-place', type: 'place' }],
    generic: {
      backFields: [
        { key: 'portal', value: 'p' },
        { key: 'phone', value: '1' },
      ],
    },
    posterGeneric: { backFields: [{ key: 'portal-poster', value: 'p' }] },
  } as unknown as PassJson;
}
const run = (input: Record<string, string>, cfg = config) => {
  const p = pass();
  venueLocations.apply(p, input, cfg, ctx);
  return p;
};

describe('venue-locations', () => {
  it('home access: one location, place action, directions for that venue only', () => {
    const p = run({ home: 'a', access: 'home' });
    expect(p.locations).toEqual([
      { latitude: 1, longitude: 2, relevantText: 'Alpha club · 1 A St' },
    ]);
    expect(p.featuredActions).toEqual([
      { identifier: 'home-place', type: 'place', placeIdentifier: 'I1' },
    ]);
    expect(p.generic?.backFields?.map((f) => f.key)).toEqual(['portal', 'dir-a', 'phone']);
    expect(p.posterGeneric?.backFields?.map((f) => f.key)).toEqual([
      'portal-poster',
      'dir-a-poster',
    ]);
    expect(p.generic?.backFields?.[1]).toEqual({
      key: 'dir-a',
      label: 'Alpha',
      value: '1 A St, Town',
      attributedValue: '<a href="https://maps.apple.com/?daddr=1,2">Directions to Alpha</a>',
    });
  });

  it('all access: every venue in table order, venue maxDistance wins', () => {
    const p = run({ home: 'b', access: 'all' }, { ...config, maxDistance: 80 });
    expect(p.locations).toEqual([
      { latitude: 1, longitude: 2, relevantText: 'Alpha club · 1 A St', maxDistance: 80 },
      { latitude: 3, longitude: 4, relevantText: 'Beta club · 2 B St', maxDistance: 50 },
    ]);
    expect(p.generic?.backFields?.map((f) => f.key)).toEqual(['portal', 'dir-a', 'dir-b', 'phone']);
  });

  it('removes the place action when the home venue has no place id', () => {
    expect(run({ home: 'b', access: 'home' }).featuredActions).toEqual([]);
  });

  it('drops locations and keeps unrelated fields when no venue is eligible', () => {
    const p = run({ home: 'zzz', access: 'home' });
    expect(p.locations).toBeUndefined();
    expect(p.featuredActions).toEqual([]);
    expect(p.generic?.backFields?.map((f) => f.key)).toEqual(['portal', 'phone']);
  });

  it('does not treat inherited names as venues', () => {
    expect(run({ home: 'constructor', access: 'home' }).locations).toBeUndefined();
  });

  it('caps at 10 locations and keeps the home venue', () => {
    const many = Object.fromEntries(
      Array.from({ length: 12 }, (_, i) => [`v${i}`, { name: `V${i}`, lat: i, lng: i }]),
    );
    const p = pass();
    venueLocations.apply(
      p,
      { home: 'v11', access: 'all' },
      { venues: 'venues', homeInput: 'home', accessInput: 'access' },
      {
        ...ctx,
        lookups: { venues: many },
      },
    );
    expect(p.locations).toHaveLength(10);
    expect(p.locations?.[0]).toMatchObject({ latitude: 11 });
  });

  it('skips venues without coordinates and escapes link html', () => {
    const p = pass();
    venueLocations.apply(
      p,
      { home: 'x', access: 'home' },
      { ...config, directions: { ...config.directions!, linkText: '{{venue.name}}' } },
      {
        ...ctx,
        lookups: { venues: { x: { name: 'A"<b>', address: 'z' } } },
      },
    );
    expect(p.locations).toBeUndefined();
    expect(p.generic?.backFields?.[1]?.attributedValue).toContain('A&quot;&lt;b&gt;');
  });

  it('leaves the root maxDistance alone', () => {
    expect(run({ home: 'a', access: 'home' }).maxDistance).toBe(150);
  });
});
