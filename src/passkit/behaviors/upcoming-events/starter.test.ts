import { beforeAll, describe, expect, it } from 'vitest';
import type { PassBuildError } from '../../build.ts';
import { buildBaked as build, loadBaked } from '../../template/baked-fixtures.ts';
import { createFixtureIdentity } from '../../testing/fixture-identity.ts';
import type { SigningMaterial } from '../../types.ts';
import { type UpcomingEventsConfig, upcomingEvents } from './index.ts';

let material: SigningMaterial;
beforeAll(async () => {
  material = await createFixtureIdentity();
});

describe('starter-event-ticket upcoming events', () => {
  it('lists the sample events in date order with no validation issues', async () => {
    const built = await build('starter-event-ticket', material);
    const entries = built.passJson.upcomingPassInformation ?? [];
    expect(entries.map((e) => e.name)).toEqual([
      'Sample Event',
      'Sample Event: Encore',
      'Sample Event: Finale',
    ]);
    expect(
      built.report.issues.filter((i) => i.path?.startsWith('upcomingPassInformation')),
    ).toEqual([]);
  });

  it('omits the list without events', async () => {
    const { template } = await loadBaked('starter-event-ticket');
    const { upcomingEvents: _drop, ...rest } = template.manifest.sample;
    const pass = (await build('starter-event-ticket', material, rest)).passJson;
    expect(pass.upcomingPassInformation).toBeUndefined();
  });

  it('rejects an event without a name, naming the field', async () => {
    const { template } = await loadBaked('starter-event-ticket');
    const error = await build('starter-event-ticket', material, {
      ...template.manifest.sample,
      upcomingEvents: [{ startsAt: '2030-06-01T19:00:00-07:00' }],
    }).catch((e: PassBuildError) => e);
    expect((error as PassBuildError).code).toBe('INVALID_INPUT');
    expect((error as PassBuildError).report.issues.map((i) => i.path)).toContain(
      'upcomingEvents/0',
    );
  });
});

describe('upcoming events input checks', () => {
  const base = { input: 'e' };
  const run = (rows: unknown[], config: UpcomingEventsConfig = base) => {
    const pass: Record<string, unknown> = {};
    upcomingEvents.apply(pass as never, { e: rows, tz: 'Europe/Paris' } as never, config, {
      now: new Date('2030-01-01T00:00:00Z'),
      lookups: {},
    } as never);
    return pass as { upcomingPassInformation?: { dateInformation: { timeZone?: string } }[] };
  };
  it('requires a zone and an end after the start', () => {
    expect(() => run([{ name: 'A', startsAt: '2030-06-01T19:00' }])).toThrow(/Event 1/);
    expect(() =>
      run([{ name: 'A', startsAt: '2030-06-01T19:00:00Z', endsAt: '2030-06-01T18:00:00Z' }]),
    ).toThrow('Event 1: endsAt is before startsAt.');
  });
  it('defaults the zone from the input', () => {
    const out = run([{ name: 'A', startsAt: '2030-06-01T19:00:00Z' }], {
      ...base,
      timeZoneInput: 'tz',
    });
    expect(out.upcomingPassInformation?.[0]?.dateInformation.timeZone).toBe('Europe/Paris');
  });
  it('rejects a prototype key as an image name', () => {
    expect(() =>
      upcomingEvents.apply(
        {} as never,
        { e: [{ name: 'A', headerImage: '__proto__' }] } as never,
        { ...base, images: 'imgs' },
        { now: new Date(), lookups: { imgs: {} } } as never,
      ),
    ).toThrow('no image named __proto__');
  });
});
