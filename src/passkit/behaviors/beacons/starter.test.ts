import { beforeAll, describe, expect, it } from 'vitest';
import type { PassBuildError } from '../../build.ts';
import { buildBaked as build, loadBaked } from '../../template/baked-fixtures.ts';
import { createFixtureIdentity } from '../../testing/fixture-identity.ts';
import type { SigningMaterial } from '../../types.ts';

let material: SigningMaterial;
beforeAll(async () => {
  material = await createFixtureIdentity();
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
