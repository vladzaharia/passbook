import { describe, expect, it } from 'vitest';
import { countD1 } from '../../../../test/helpers/index.ts';
import { first, run } from '../../platform/db.ts';
import { depsOf, overrideDeps } from '../passes/deps.ts';
import { clearSettingsCache } from '../settings/service.ts';
import { takeAssetGrantToken } from './asset-sidecar.ts';
import { prepareGenericAssetGrant } from './assets.ts';
import { lookup } from './lookup.ts';
import {
  interceptBatches,
  kit,
  registerLookupOutputFixture,
  resolveRequest,
  scannerForLookup,
  setupPhoto,
} from './lookup-output-test-fixtures.ts';
import { knownPhotoUrl, photoGrantUrl } from './member-photo.ts';
import { RACE_PASS_OK } from './race-tags.ts';
import { candidateById } from './repo-lookup.ts';
import { missCounterKey } from './repo-miss-authority.ts';
import { isFinalFenceBatch } from './repo-read-grant-expiry-test-fixtures.ts';
import { foundOf } from './resolve.ts';

registerLookupOutputFixture();

describe('lookup output authority', () => {
  it('returns confirmed photos for multiple visible passes in at most five D1 trips after warm-up', async () => {
    const passes = [await setupPhoto(), await setupPhoto(), await setupPhoto()];
    const { scanner, actor } = await scannerForLookup();
    const counted = countD1(kit.env.DB);
    const ctx = { ...kit.ctx, env: { ...kit.env, DB: counted.db } };
    overrideDeps(ctx.env, depsOf(kit.env));
    await lookup(ctx, actor, 'lookup-photo-group');
    counted.reset();
    const result = await lookup(ctx, actor, 'lookup-photo-group');
    expect(counted.count()).toBeLessThanOrEqual(5);
    expect(result.items.map((item) => item.passId).sort()).toEqual(
      passes.map((pass) => pass.id).sort(),
    );
    expect(result.more).toBe(false);
    for (const pass of passes) {
      const photoUrl = result.items.find((item) => item.passId === pass.id)?.photoUrl;
      expect(photoUrl).toContain(`/passes/${pass.id}/assets/member.png?g=`);
      expect((await kit.get(scanner.headers, photoUrl!.replace('/api/v1/scan', ''))).status).toBe(
        200,
      );
      for (const secret of [
        pass.serial,
        pass.authToken,
        pass.downloadToken,
        pass.scanCode!,
        'hidden@example.test',
      ])
        expect(JSON.stringify(result)).not.toContain(secret);
    }
  });

  it('returns confirmed photos and verified history for multiple visible passes in at most five D1 trips on a cold lookup', async () => {
    const scanned = await setupPhoto();
    const passes = [scanned, await setupPhoto(), await setupPhoto()];
    const { scanner, actor } = await scannerForLookup();
    const response = await kit.post(scanner.headers, '/actions', {
      ...resolveRequest(scanned.scanCode!),
      actionId: 'enter',
    });
    expect(response.status).toBe(200);
    const scan = (await response.json()) as {
      kind: string;
      scanId: string | null;
      at: number | null;
    };
    expect(scan.kind).toBe('ok');
    expect(scan.scanId).toBeTruthy();
    expect(scan.at).toBe(kit.clock.now());
    const counted = countD1(kit.env.DB);
    const ctx = { ...kit.ctx, env: { ...kit.env, DB: counted.db } };
    overrideDeps(ctx.env, depsOf(kit.env));
    clearSettingsCache(counted.db);
    const result = await lookup(ctx, actor, 'lookup-photo-group');
    expect(counted.count()).toBeLessThanOrEqual(5);
    expect(result.items.map((item) => item.passId).sort()).toEqual(
      passes.map((pass) => pass.id).sort(),
    );
    expect(result.more).toBe(false);
    expect(result.items.find((item) => item.passId === scanned.id)?.lastScanAt).toBe(scan.at);
    for (const pass of passes) {
      const photoUrl = result.items.find((item) => item.passId === pass.id)?.photoUrl;
      expect(photoUrl).toContain(`/passes/${pass.id}/assets/member.png?g=`);
      expect((await kit.get(scanner.headers, photoUrl!.replace('/api/v1/scan', ''))).status).toBe(
        200,
      );
      for (const secret of [
        pass.serial,
        pass.authToken,
        pass.downloadToken,
        pass.scanCode!,
        'hidden@example.test',
      ])
        expect(JSON.stringify(result)).not.toContain(secret);
    }
  });

  it('keeps photo and pass-view capabilities out of Found and cloneable plans', async () => {
    const pass = await setupPhoto();
    const { actor } = await scannerForLookup();
    const candidate = await candidateById(kit.env.DB, actor.orgId, pass.id);
    if (!candidate) throw new Error('Missing candidate fixture');
    const found = await foundOf(kit.ctx, candidate, actor);
    if (!found) throw new Error('Missing found fixture');
    expect(found).not.toHaveProperty('photoGrant');
    expect(found).not.toHaveProperty('photoUrl');
    const photo = await knownPhotoUrl(
      kit.ctx,
      actor,
      candidate,
      found.template,
      found.activePolicy,
    );
    const generic = await prepareGenericAssetGrant(
      kit.ctx,
      actor,
      candidate,
      candidate.connectionGeneration,
      candidate.activeTemplateVersion,
      'read',
    );
    if (!photo || !generic) throw new Error('Missing grant plans');
    for (const plan of [photo.grant, generic]) {
      expect(plan).not.toHaveProperty('token');
      expect(plan).not.toHaveProperty('actor');
      expect(plan).not.toHaveProperty('guard');
      expect(JSON.stringify(plan)).not.toContain('/assets/member.png?g=');
    }
    const token = takeAssetGrantToken(generic);
    if (!token) throw new Error('Generic grant has no token');
    expect(token).toMatch(/^[A-Za-z0-9_-]{51,83}$/);
    expect(JSON.stringify(generic)).not.toContain(token);
    expect(JSON.stringify(structuredClone(generic))).not.toContain(token);
    expect(JSON.stringify(found)).not.toContain(token);
    // A clone is not the plan: it carries no capability, and the URL goes only to its recipient.
    expect(takeAssetGrantToken(structuredClone(generic))).toBeNull();
    expect(photoGrantUrl(actor, pass.id, structuredClone(photo.grant))).toBeNull();
    expect(photoGrantUrl({ ...actor, orgId: 'other-org' }, pass.id, photo.grant)).toBeNull();
    expect(photoGrantUrl(actor, `${pass.id}-other`, photo.grant)).toBeNull();
    expect(photoGrantUrl(actor, pass.id, photo.grant)).toContain(
      `/passes/${pass.id}/assets/member.png?g=`,
    );
  });

  it('binds only ids, generations and release ids in the final pass read, never credentials or contact data', async () => {
    const pass = await setupPhoto();
    const { actor } = await scannerForLookup();
    const { db, bindings } = interceptBatches(kit.env.DB);
    const ctx = { ...kit.ctx, env: { ...kit.env, DB: db } };
    overrideDeps(ctx.env, depsOf(kit.env));
    expect((await lookup(ctx, actor, pass.scanCode!)).items.map((item) => item.passId)).toEqual([
      pass.id,
    ]);
    const final = bindings.filter(({ sql }) => sql.includes(RACE_PASS_OK));
    expect(final.length).toBeGreaterThan(0);
    for (const { values } of final)
      for (const value of values)
        for (const secret of [
          pass.serial,
          pass.authToken,
          pass.downloadToken,
          pass.scanCode!,
          'hidden@example.test',
        ])
          expect(String(value)).not.toContain(secret);
  });

  it('retains the identity but withholds a photo removed before the final transaction', async () => {
    const pass = await setupPhoto();
    const { actor } = await scannerForLookup();
    const real = kit.env.DB;
    let removed = false;
    const { db } = interceptBatches(real, async (sql) => {
      if (!removed && isFinalFenceBatch(sql)) {
        removed = true;
        await run(real, 'DELETE FROM member_photos WHERE pass_id=?', [pass.id]);
      }
    });
    const ctx = { ...kit.ctx, env: { ...kit.env, DB: db } };
    overrideDeps(ctx.env, depsOf(kit.env));
    const result = await lookup(ctx, actor, pass.id);
    expect(removed).toBe(true);
    expect(result.items).toMatchObject([{ passId: pass.id, photoUrl: null }]);
    expect(result.more).toBe(false);
  });

  it('withholds both identity and photo if the original scanner CSRF secret changes before final CAS', async () => {
    const pass = await setupPhoto();
    const { scanner, actor } = await scannerForLookup();
    const real = kit.env.DB;
    let changed = false;
    const { db } = interceptBatches(real, async (sql) => {
      if (!changed && isFinalFenceBatch(sql)) {
        changed = true;
        await run(real, 'UPDATE scanners SET csrf_secret=?,updated_at=updated_at+1 WHERE id=?', [
          'rotated-csrf-secret',
          scanner.id,
        ]);
      }
    });
    const ctx = { ...kit.ctx, env: { ...kit.env, DB: db } };
    overrideDeps(ctx.env, depsOf(kit.env));
    expect(await lookup(ctx, actor, pass.id)).toEqual({ items: [], more: false });
    expect(changed).toBe(true);
    const window = kit.clock.now() - (kit.clock.now() % 600_000);
    expect(
      await first(real, 'SELECT count FROM counters WHERE key=? AND window_start=?', [
        missCounterKey(actor),
        window,
      ]),
    ).toBeNull();
  });
});
