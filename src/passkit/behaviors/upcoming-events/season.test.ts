import { describe, expect, it } from 'vitest';
import type { BehaviorContext, Json, PassJson } from '../../types.ts';
import { type UpcomingEventsConfig, upcomingEvents } from './index.ts';

const SHA = 'b'.repeat(64);
const ctx = (art: Record<string, Json> = {}): BehaviorContext => ({
  now: new Date('2030-06-01T20:00:00Z'),
  identity: { passTypeIdentifier: 'p', teamIdentifier: 'TEAM123456' },
  lookups: { art: { poster: { URL: 'https://cdn.test/a.png', SHA256: SHA, size: 10, ...art } } },
});
const run = (events: Json, config: UpcomingEventsConfig, c = ctx()) => {
  const pass = { expirationDate: '2030-06-01T22:00:00-07:00' } as PassJson;
  upcomingEvents.apply(pass, { events }, config, c);
  return pass;
};

describe('season schedule', () => {
  const events = [
    { name: 'One', startsAt: '2030-06-02T19:00:00Z', endsAt: '2030-06-02T22:00:00Z' },
    { name: 'Three', startsAt: '2030-08-02T19:00:00Z', endsAt: '2030-08-02T22:00:00Z' },
    { name: 'Two', startsAt: '2030-07-02T19:00:00Z', endsAt: '2030-07-02T22:00:00Z' },
  ];

  it('expires after the last event and surfaces each one', () => {
    const p = run(events, { input: 'events', schedule: { leadMinutes: 60 } });
    expect(p.expirationDate).toBe('2030-08-02T22:00:00Z');
    expect(p.relevantDates).toEqual([
      { startDate: '2030-06-02T18:00:00Z', endDate: '2030-06-02T22:00:00Z' },
      { startDate: '2030-07-02T18:00:00Z', endDate: '2030-07-02T22:00:00Z' },
      { startDate: '2030-08-02T18:00:00Z', endDate: '2030-08-02T22:00:00Z' },
    ]);
  });

  it('leaves the pass dates alone without a schedule or without events', () => {
    expect(run(events, { input: 'events' }).expirationDate).toBe('2030-06-01T22:00:00-07:00');
    const none = run([], { input: 'events', schedule: {} });
    expect(none.expirationDate).toBe('2030-06-01T22:00:00-07:00');
    expect(none.relevantDates).toBeUndefined();
  });
});

describe('untrusted links', () => {
  const base = { name: 'One', startsAt: '2030-06-02T19:00:00Z' };
  const config: UpcomingEventsConfig = { input: 'events', images: 'art' };

  it('takes https event links only', () => {
    expect(() => run([{ ...base, website: 'javascript:alert(1)' }], config)).toThrow(
      'Event 1: website needs an https link.',
    );
    expect(() => run([{ ...base, transferURL: 'http://x.test' }], config)).toThrow(/transferURL/);
    expect(
      run([{ ...base, website: 'https://x.test' }], config).upcomingPassInformation,
    ).toHaveLength(1);
  });

  it('checks the image URL, hash and size', () => {
    const withImage = [{ ...base, headerImage: 'poster' }];
    expect(run(withImage, config).upcomingPassInformation).toHaveLength(1);
    for (const [bad, message] of [
      [{ URL: 'http://cdn.test/a.png' }, /https URL/],
      [{ SHA256: 'zz' }, /64-character SHA256/],
      [{ size: 0 }, /size in bytes/],
      [{ size: 1.5 }, /size in bytes/],
    ] as const)
      expect(() => run(withImage, config, ctx(bad))).toThrow(message);
  });
});
