import { describe, expect, it } from 'vitest';
import { fixtures, makeEnv } from '../../../../test/helpers/index.ts';
import { ManualClock } from '../../platform/clock.ts';
import { first } from '../../platform/db.ts';
import { createServiceContext } from '../../platform/service-context.ts';
import { basicPackage } from './package/fixtures.ts';
import { resetBakedSync, syncBakedTemplates } from './sync.ts';
import { bakedFrom, fakeAssets, sourceOf } from './testing.ts';

const manifest = (blueprint?: boolean) =>
  JSON.stringify({
    schema: 1,
    name: 'Flagged',
    ...(blueprint === undefined ? {} : { blueprint }),
    inputs: { type: 'object', properties: { name: { type: 'string' } } },
    sample: { name: 'Alex' },
    bindings: [{ to: { field: 'name' }, value: '{{name}}' }],
    display: { title: '{{name}}', icon: 'stamp' },
  });

describe('the baked sync', () => {
  it('writes the blueprint flag from each build, on and off', async () => {
    const assets = fakeAssets();
    const env = await makeEnv({ ASSETS: assets });
    const clock = new ManualClock();
    fixtures(env, clock);
    const flag = async () =>
      (
        await first<{ blueprint: number }>(
          env.DB,
          "SELECT blueprint FROM templates WHERE id = 'baked:flagged'",
        )
      )?.blueprint;
    let build = 0;
    const sync = async (blueprint?: boolean) => {
      const fixture = await bakedFrom(
        'flagged',
        basicPackage({ 'wallet.template.json': manifest(blueprint) }),
      );
      expect(fixture.template.blueprint).toBe(blueprint === true);
      for (const [path, bytes] of fixture.files) assets.files.set(path, bytes);
      build += 1;
      resetBakedSync();
      const worker = {
        ...env,
        CF_VERSION: {
          id: `blueprint-sync-${build}`,
          tag: '',
          timestamp: new Date(Date.UTC(2040, 0, 1) + build * 1000).toISOString(),
        },
      };
      clock.set(clock.now() + 1000);
      await syncBakedTemplates(
        createServiceContext(worker, { clock }),
        sourceOf([fixture], `blueprint-${build}`),
      );
    };
    await sync();
    expect(await flag()).toBe(0);
    await sync(true);
    expect(await flag()).toBe(1);
    await sync(false);
    expect(await flag()).toBe(0);
  });
});
