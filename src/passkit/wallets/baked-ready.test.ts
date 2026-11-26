import { beforeAll, describe, expect, it } from 'vitest';
import { bakedSlugs, loadBaked } from '../template/baked-fixtures.ts';
import { fidelityReport } from './fidelity.ts';
import { googleCompiler } from './google/compilers.ts';
import { googleView } from './google/fixtures.ts';
import { view as samsungView } from './samsung/fixtures.ts';
import { samsungCompiler } from './samsung/index.ts';
import { NOW } from './view-fixtures.ts';

beforeAll(async () => {
  await loadBaked('starter-stamp-card');
}, 120_000);

/** DoD 4: every baked template and blueprint is Ready or Ready with omissions on both providers. */
describe('baked templates on both providers', () => {
  it.each(bakedSlugs())('%s is never blocked on Google or Samsung', async (slug) => {
    const google = fidelityReport({
      target: 'google',
      compiler: googleCompiler,
      views: [await googleView(slug)],
      now: NOW,
    });
    const samsung = fidelityReport({
      target: 'samsung',
      compiler: samsungCompiler,
      views: [await samsungView(slug)],
      now: NOW,
    });
    expect({ google: google.status.kind, samsung: samsung.status.kind }).toEqual({
      google: expect.stringMatching(/^(ready|omissions)$/u),
      samsung: expect.stringMatching(/^(ready|omissions)$/u),
    });
  });
});
