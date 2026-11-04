import { beforeAll, describe, expect, it } from 'vitest';
import type { PassBuildError } from '../../build.ts';
import { buildBaked as build, loadBaked } from '../../template/baked-fixtures.ts';
import { createFixtureIdentity } from '../../testing/fixture-identity.ts';
import type { SigningMaterial } from '../../types.ts';

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

describe('starter-store-card beacons', () => {
  it('ships the sample beacon', async () => {
    const pass = (await build('starter-store-card', material)).passJson;
    expect(pass.beacons).toEqual([
      {
        proximityUUID: '8DEEFBB9-F738-4297-8040-96668BB44281',
        major: 1,
        relevantText: 'Welcome back.',
      },
    ]);
  });

  it('omits beacons when none are given and rejects a bad UUID', async () => {
    const { template } = await loadBaked('starter-store-card');
    const { beacons: _drop, ...rest } = template.manifest.sample;
    expect((await build('starter-store-card', material, rest)).passJson.beacons).toBeUndefined();
    const error = await build('starter-store-card', material, {
      ...rest,
      beacons: [{ proximityUUID: 'nope' }],
    }).catch((e: PassBuildError) => e);
    expect((error as PassBuildError).code).toBe('INVALID_INPUT');
  });
});
