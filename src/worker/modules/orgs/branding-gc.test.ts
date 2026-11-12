import { describe, expect, it } from 'vitest';
import { fixtures, makeEnv, makeOrg } from '../../../../test/helpers/index.ts';
import { run } from '../../platform/db.ts';
import { createServiceContext } from '../../platform/service-context.ts';
import { brandingKey } from './branding-files.ts';
import { BRANDING_GC_GRACE_MS, collectSupersededBranding, sweepBrandingGc } from './branding-gc.ts';

const image = (storageVersion: string) => ({ storageVersion });
const store = (v: Record<string, string>) =>
  JSON.stringify({ logo: image(v.logo ?? 'a'), ...(v.icon ? { icon: image(v.icon) } : {}) });

async function setup() {
  const e = await makeEnv();
  const f = fixtures(e);
  const org = await makeOrg(f);
  const ctx = createServiceContext(e, { clock: f.clock });
  const put = (key: string) => e.BUCKET.put(key, 'x');
  const keys = (v: string) => [3, 2].map((s) => brandingKey(org.id, 'logo', s as 2 | 3, v));
  const exists = async (key: string) => (await e.BUCKET.head(key)) !== null;
  return { e, f, org, ctx, put, keys, exists };
}

describe('branding GC grace period', () => {
  it('keeps superseded objects until the grace period passes, then deletes them', async () => {
    const { e, f, org, ctx, put, keys, exists } = await setup();
    const [old, live] = [keys('old'), keys('new')];
    await Promise.all([...old, ...live].map(put));
    await run(e.DB, 'UPDATE orgs SET branding = ? WHERE id = ?', [store({ logo: 'new' }), org.id]);
    await collectSupersededBranding(ctx, org.id, store({ logo: 'old' }), store({ logo: 'new' }));

    await sweepBrandingGc(ctx);
    expect(await Promise.all(old.map(exists))).toEqual([true, true]);

    f.clock.advance(BRANDING_GC_GRACE_MS - 1);
    await sweepBrandingGc(ctx);
    expect(await Promise.all(old.map(exists))).toEqual([true, true]);

    f.clock.advance(1);
    await sweepBrandingGc(ctx);
    expect(await Promise.all(old.map(exists))).toEqual([false, false]);
    expect(await Promise.all(live.map(exists))).toEqual([true, true]);
  });

  it('never deletes an object the current branding references again', async () => {
    const { e, f, org, ctx, put, keys, exists } = await setup();
    const old = keys('old');
    await Promise.all(old.map(put));
    await collectSupersededBranding(ctx, org.id, store({ logo: 'old' }), store({ logo: 'new' }));
    await run(e.DB, 'UPDATE orgs SET branding = ? WHERE id = ?', [store({ logo: 'old' }), org.id]);
    f.clock.advance(BRANDING_GC_GRACE_MS);
    await sweepBrandingGc(ctx);
    expect(await Promise.all(old.map(exists))).toEqual([true, true]);
  });

  it('collects nothing when branding JSON is unreadable', async () => {
    const { e, org, ctx } = await setup();
    await collectSupersededBranding(ctx, org.id, '{nope', store({ logo: 'new' }));
    const row = await e.DB.prepare('SELECT count(*) AS n FROM branding_gc_queue').first<{
      n: number;
    }>();
    expect(row?.n).toBe(0);
  });

  it('keeps queued objects while the current branding is unreadable', async () => {
    const { e, f, org, ctx, put, keys, exists } = await setup();
    const old = keys('old');
    await Promise.all(old.map(put));
    await collectSupersededBranding(ctx, org.id, store({ logo: 'old' }), store({ logo: 'new' }));
    await run(e.DB, 'UPDATE orgs SET branding = ? WHERE id = ?', ['null', org.id]);
    f.clock.advance(BRANDING_GC_GRACE_MS);
    await sweepBrandingGc(ctx);
    expect(await Promise.all(old.map(exists))).toEqual([true, true]);
  });
});
