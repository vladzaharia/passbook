import { describe, expect, it } from 'vitest';
import type { BehaviorContext, Json, PassJson } from '../../types.ts';
import { validatePass } from '../../validate.ts';
import { type UpcomingEventsConfig, upcomingEvents } from './index.ts';

const NOW = new Date('2030-06-01T20:00:00Z');
const SHA = 'a'.repeat(64);
const ctx: BehaviorContext = {
  now: NOW,
  identity: { passTypeIdentifier: 'p', teamIdentifier: 'TEAM123456' },
  lookups: {
    art: { poster: { URL: 'https://cdn.test/a.png', SHA256: SHA, size: 1000, scale: 2 } },
  },
};
const config: UpcomingEventsConfig = { input: 'events', images: 'art' };

const run = (events: Json, cfg = config, pass = {} as PassJson) => {
  upcomingEvents.apply(pass, { events }, cfg, ctx);
  return pass;
};
const names = (p: PassJson) => (p.upcomingPassInformation ?? []).map((e) => e.name);

describe('upcoming-events', () => {
  it('sorts by start and puts undated events last', () => {
    const p = run([
      { name: 'TBD' },
      { name: 'Later', startsAt: '2030-08-01T19:00:00Z' },
      { name: 'Sooner', startsAt: '2030-07-01T19:00:00Z' },
    ]);
    expect(names(p)).toEqual(['Sooner', 'Later', 'TBD']);
    expect(p.upcomingPassInformation?.[2]?.dateInformation).toEqual({ isUndetermined: true });
  });

  it('drops past events and marks the running one active', () => {
    const p = run([
      { name: 'Over', startsAt: '2030-05-01T19:00:00Z', endsAt: '2030-05-01T21:00:00Z' },
      { name: 'Now', startsAt: '2030-06-01T19:00:00Z', endsAt: '2030-06-01T22:00:00Z' },
      { name: 'Next', startsAt: '2030-06-02T19:00:00Z' },
    ]);
    expect(names(p)).toEqual(['Now', 'Next']);
    expect(p.upcomingPassInformation?.map((e) => e.isActive)).toEqual([true, false]);
  });

  it('removes the key when nothing is left', () => {
    const past = [{ name: 'Over', startsAt: '2030-05-01T19:00:00Z' }];
    expect(
      run(past, config, { upcomingPassInformation: [] } as unknown as PassJson)
        .upcomingPassInformation,
    ).toBeUndefined();
    expect(run([]).upcomingPassInformation).toBeUndefined();
  });

  it('caps the list and derives unique ids', () => {
    const events = Array.from({ length: 14 }, () => ({
      name: 'Game',
      startsAt: '2030-07-01T19:00:00Z',
    }));
    const p = run(events);
    expect(p.upcomingPassInformation).toHaveLength(10);
    expect(new Set(p.upcomingPassInformation?.map((e) => e.identifier)).size).toBe(10);
    expect(run(events, { ...config, max: 2 }).upcomingPassInformation).toHaveLength(2);
  });

  it('maps venue, links and image keys', () => {
    const p = run([
      {
        id: 'g1',
        name: 'Game 1',
        startsAt: '2030-07-01T19:00:00-07:00',
        endsAt: '2030-07-01T22:00:00-07:00',
        timeZone: 'America/Los_Angeles',
        venueName: 'Hall',
        venueRegion: 'Town',
        venueLat: 1,
        venueLng: 2,
        note: 'Gates at 6',
        directionsURL: 'https://maps.test/x',
        headerImage: 'poster',
      },
    ]);
    expect(p.upcomingPassInformation?.[0]).toMatchObject({
      identifier: 'g1',
      type: 'event',
      dateInformation: { date: '2030-07-01T19:00:00-07:00', timeZone: 'America/Los_Angeles' },
      semantics: {
        eventName: 'Game 1',
        venueName: 'Hall',
        venueLocation: { latitude: 1, longitude: 2 },
      },
      URLs: { directionsInformationURL: 'https://maps.test/x' },
      images: {
        headerImage: {
          URLs: [{ URL: 'https://cdn.test/a.png', SHA256: SHA, size: 1000, scale: 2 }],
        },
      },
      backFields: [
        { key: 'venue', value: 'Hall, Town' },
        { key: 'note', value: 'Gates at 6' },
      ],
    });
  });

  it('names the row that is wrong', () => {
    expect(() => run([{ startsAt: '2030-07-01T19:00:00Z' }])).toThrow(/Event 1 needs a name/);
    expect(() => run([{ name: 'A', startsAt: 'soon' }])).toThrow(/Event 1: startsAt/);
    expect(() => run([{ name: 'A', startsAt: '2030-07-01' }])).toThrow(/needs a date and time/);
    expect(() => run([{ name: 'A', headerImage: 'nope' }])).toThrow(/no image named nope/);
    expect(() =>
      run([
        { id: 'x', name: 'A' },
        { id: 'x', name: 'B' },
      ]),
    ).toThrow(/used twice/);
    expect(() => run('x')).toThrow(/not a list/);
  });

  it('produces entries the validator accepts', () => {
    const p = run([
      {
        name: 'Game 1',
        startsAt: '2030-07-01T19:00:00-07:00',
        venueName: 'Hall',
        headerImage: 'poster',
        website: 'https://x.test',
      },
      { name: 'Game 2' },
    ]);
    const report = validatePass(
      {
        ...p,
        formatVersion: 1,
        serialNumber: 's',
        description: 'd',
        organizationName: 'o',
        passTypeIdentifier: 'p',
        teamIdentifier: 'TEAM123456',
        eventTicket: { primaryFields: [{ key: 'a', value: 'b' }] },
      } as PassJson,
      [],
      { passTypeIdentifier: 'p', teamIdentifier: 'TEAM123456' },
    );
    expect(
      report.issues.filter(
        (i) => i.path?.startsWith('upcomingPassInformation') && i.severity === 'error',
      ),
    ).toEqual([]);
  });
});
