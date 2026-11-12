import { describe, expect, it } from 'vitest';
import { countD1 } from '../../../../test/helpers/index.ts';
import { first, run } from '../../platform/db.ts';
import { depsOf, overrideDeps } from '../passes/deps.ts';
import { clearSettingsCache } from '../settings/service.ts';
import { actorCsrfAuthorityStmt } from './actor-csrf.ts';
import { confirmAssetGrantToken, prepareGenericAssetGrant } from './assets.ts';
import { lookup } from './lookup.ts';
import {
  interceptBatches,
  kit,
  registerLookupOutputFixture,
  resolveRequest,
  scannerForLookup,
  setupPhoto,
} from './lookup-output-test-fixtures.ts';
import { confirmedPhotoUrl, knownPhotoUrl } from './member-photo.ts';
import { prepareAssetGrantInsertion } from './repo-asset-grants.ts';
import { candidateById } from './repo-lookup.ts';
import { missCounterKey } from './repo-miss-authority.ts';
import { scanSecretSlots } from './repo-secret-binds.ts';
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

  it('keeps photo and pass-view capabilities out of Found and cloneable plans until confirmed', async () => {
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
      expect(plan.guard).not.toHaveProperty('actor');
      expect(plan.guard).not.toHaveProperty('source');
      expect(plan.guard).not.toHaveProperty('recipientSession');
      expect(plan.guard).not.toHaveProperty('sourceSession');
      expect(JSON.stringify(plan)).not.toContain('/assets/member.png?g=');
    }
    expect(confirmedPhotoUrl(actor, pass.id, photo.grant, [])).toBeNull();
    expect(confirmAssetGrantToken(generic, [])).toBeNull();
    const csrfStmt = actorCsrfAuthorityStmt(kit.env.DB, actor);
    if (!csrfStmt) throw new Error('Missing scanner CSRF statement');
    const csrf = await csrfStmt.all();
    const genericInsert = await prepareAssetGrantInsertion(
      kit.ctx,
      generic,
      { recipient: csrf },
      candidate,
    );
    const genericResults = await kit.env.DB.batch(genericInsert(kit.clock.now(), undefined));
    expect(confirmAssetGrantToken(structuredClone(generic), genericResults)).toBeNull();
    expect(confirmedPhotoUrl(actor, pass.id, photo.grant, genericResults)).toBeNull();
    const token = confirmAssetGrantToken(generic, genericResults);
    if (!token) throw new Error('Generic grant was not confirmed');
    expect(token).toMatch(/^[A-Za-z0-9_-]{54}$/);
    expect(JSON.stringify(generic)).not.toContain(token);
    expect(JSON.stringify(found)).not.toContain(token);
    const photoInsert = await prepareAssetGrantInsertion(
      kit.ctx,
      photo.grant,
      { recipient: csrf },
      candidate,
    );
    const photoResults = await kit.env.DB.batch(photoInsert(kit.clock.now(), undefined));
    expect(
      confirmedPhotoUrl(actor, pass.id, structuredClone(photo.grant), photoResults),
    ).toBeNull();
    expect(
      confirmedPhotoUrl({ ...actor, orgId: 'other-org' }, pass.id, photo.grant, photoResults),
    ).toBeNull();
    expect(confirmedPhotoUrl(actor, `${pass.id}-other`, photo.grant, photoResults)).toBeNull();
    expect(confirmedPhotoUrl(actor, pass.id, photo.grant, photoResults)).toContain(
      `/passes/${pass.id}/assets/member.png?g=`,
    );
  });

  it('keeps original credentials and contact information out of packed bindings', async () => {
    const pass = await setupPhoto();
    const { scanner, actor } = await scannerForLookup();
    const original = await first<{ csrf_secret: string }>(
      kit.env.DB,
      'SELECT csrf_secret FROM scanners WHERE id=?',
      [scanner.id],
    );
    const { db, bindings } = interceptBatches(kit.env.DB);
    const ctx = { ...kit.ctx, env: { ...kit.env, DB: db } };
    overrideDeps(ctx.env, depsOf(kit.env));
    expect((await lookup(ctx, actor, pass.scanCode!)).items.map((item) => item.passId)).toEqual([
      pass.id,
    ]);
    const packed = bindings.flatMap(({ sql, values }) => {
      const slots = scanSecretSlots(sql, values.length);
      if (!slots) return [];
      return slots.flatMap((slot, index) =>
        sql.slice(slot.offset - 5, slot.offset) === 'json(' &&
        /^\?\)\s+AS\s+(?:data|segment_\d+)/i.test(sql.slice(slot.offset))
          ? [values[index]]
          : [],
      );
    });
    expect(packed.length).toBeGreaterThan(0);
    for (const value of packed) {
      expect(typeof value).toBe('string');
      for (const secret of [
        pass.serial,
        pass.authToken,
        pass.downloadToken,
        pass.scanCode!,
        'hidden@example.test',
        original!.csrf_secret,
      ])
        expect(value).not.toContain(secret);
    }
    expect(bindings.some(({ values }) => values.includes(original!.csrf_secret))).toBe(true);
  });

  it('retains the identity but withholds a photo removed before the final transaction', async () => {
    const pass = await setupPhoto();
    const { actor } = await scannerForLookup();
    const real = kit.env.DB;
    let removed = false;
    const { db } = interceptBatches(real, async (sql) => {
      if (
        !removed &&
        sql.some((text) => text.includes('INSERT OR IGNORE INTO scan_asset_grant_provenance'))
      ) {
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
      if (
        !changed &&
        sql.some((text) => text.includes('INSERT OR IGNORE INTO scan_asset_grant_provenance'))
      ) {
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
    expect(
      await first(real, 'SELECT token_hash FROM scan_asset_grant_provenance WHERE org_id=?', [
        kit.org.id,
      ]),
    ).toBeNull();
    const window = kit.clock.now() - (kit.clock.now() % 600_000);
    expect(
      await first(real, 'SELECT count FROM counters WHERE key=? AND window_start=?', [
        missCounterKey(actor),
        window,
      ]),
    ).toBeNull();
  });
});
