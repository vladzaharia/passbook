import { beforeAll, describe, expect, it, vi } from 'vitest';
import { makeUser } from '../../../../test/helpers/index.ts';
import { crc32 } from '../../../passkit/index.ts';
import { sha1Hex } from '../../../passkit/sign/index.ts';
import { first, run } from '../../platform/db.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { createSession, resolveSession } from '../auth/sessions.ts';
import { jobCtxOf } from '../delivery/delivery-test-fixtures.ts';
import { getHolderPass } from '../holders/repo.ts';
import { makePng } from '../templates/package/fixtures.ts';
import { grantKitMembership } from './apple-release-test-fixtures.ts';
import { putPassAsset } from './asset-service.ts';
import { captureImageWriteState, putPassImageObject } from './asset-service-image-write.ts';
import { startCredentialTransfer } from './credential-transfer.ts';
import { type TenantPassWrite, tenantAuthorityOf } from './http.ts';
import { putMemberPhoto } from './member-photo.ts';
import { memberPhotoPixels } from './member-photo-bytes.ts';
import { type Kit, setupKit } from './pass-test-fixtures.ts';
import { retireUnusedPassAssetKey } from './repo-transfer-asset-gc.ts';
import { sweepOneTransferAssetGc } from './transfer-asset-gc.ts';

const deferred = Promise as PromiseConstructor & {
  withResolvers<T>(): { promise: Promise<T>; resolve: (value: T) => void };
};
const system = { type: 'system', id: null } as const;
const logo = makePng(40, 40);
const photo = makePng(270, 270);
const encoded = btoa(String.fromCharCode(...photo));
type Kind = 'asset' | 'photo';
let kit: Kit;

beforeAll(async () => {
  kit = await setupKit();
}, 60_000);

function upload(kind: Kind, ctx: ServiceContext, passId: string, authority?: TenantPassWrite) {
  return kind === 'asset'
    ? putPassAsset(ctx, system, passId, 'logo.png', logo, null, {}, authority)
    : putMemberPhoto(ctx, system, passId, { png: encoded, includeInPass: false }, null, authority);
}

function prefix(kind: Kind, orgId: string, passId: string) {
  return kind === 'asset' ? `pass-assets/${passId}/logo.png/` : `member-photos/${orgId}/${passId}/`;
}

async function imageKey(kind: Kind, passId: string): Promise<string | null> {
  const sql =
    kind === 'asset'
      ? "SELECT r2_key FROM pass_assets WHERE pass_id = ? AND name = 'logo.png'"
      : 'SELECT r2_key FROM member_photos WHERE pass_id = ?';
  return (await first<{ r2_key: string }>(kit.env.DB, sql, [passId]))?.r2_key ?? null;
}

async function transfer(passId: string) {
  const expected = await getHolderPass(kit.env.DB, passId, null);
  if (!expected) throw new Error('Missing holder source');
  return startCredentialTransfer(
    jobCtxOf(kit),
    system,
    passId,
    { holderEmail: 'next@example.test', ownerUserId: null },
    null,
    { kind: 'tenant-holder', expected },
  );
}

/** A second pass references the writer's object from the opposite table. */
async function referenceFromOtherTable(
  kind: Kind,
  other: { id: string; orgId: string },
  key: string,
) {
  const bytes = kind === 'asset' ? logo : photo;
  const sha1 = await sha1Hex(bytes);
  if (kind === 'asset') {
    await run(
      kit.env.DB,
      `INSERT INTO member_photos
      (pass_id,org_id,r2_key,sha1,size,crc32,include_in_pass,version,updated_at)
      VALUES (?,?,?,?,?,?,0,?,?)`,
      [
        other.id,
        other.orgId,
        key,
        sha1,
        bytes.length,
        crc32(bytes),
        crypto.randomUUID(),
        kit.clock.now(),
      ],
    );
  } else {
    await run(
      kit.env.DB,
      `INSERT INTO pass_assets
      (pass_id,name,r2_key,sha1,size,width,height,crc32,created_at) VALUES (?,'logo.png',?,?,?,?,?,?,?)`,
      [other.id, key, sha1, bytes.length, 270, 270, crc32(bytes), kit.clock.now()],
    );
  }
}

/** Interleave real D1 work immediately before a CAS, or lose its response after it commits. */
function interposeWrite(kind: Kind, action: () => Promise<void>, afterCommit = false) {
  const db = kit.env.DB;
  const nativeStatements = new WeakMap<
    D1PreparedStatement,
    { statement: D1PreparedStatement; sql: string }
  >();
  const pattern =
    kind === 'asset' ? /^\s*INSERT INTO pass_assets\b/i : /^\s*INSERT INTO member_photos\b/i;
  let intercepted = false;
  const wrap = (statement: D1PreparedStatement, sql: string): D1PreparedStatement => {
    const wrapped = new Proxy(statement, {
      get(target, property) {
        if (property === 'bind') return (...values: unknown[]) => wrap(target.bind(...values), sql);
        if (property === 'run')
          return async () => {
            if (!intercepted && pattern.test(sql)) {
              intercepted = true;
              if (afterCommit) {
                await target.run();
                await action();
                throw new Error('D1 response lost after commit');
              }
              await action();
            }
            return target.run();
          };
        const value = Reflect.get(target, property, target);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    nativeStatements.set(wrapped, { statement, sql });
    return wrapped;
  };
  const proxy = new Proxy(db, {
    get(target, property) {
      if (property === 'prepare') return (sql: string) => wrap(target.prepare(sql), sql);
      if (property === 'batch')
        return async (statements: D1PreparedStatement[]) => {
          const selected =
            !intercepted &&
            statements.some((statement) =>
              pattern.test(nativeStatements.get(statement)?.sql ?? ''),
            );
          if (selected) {
            intercepted = true;
            if (!afterCommit) await action();
          }
          const result = await target.batch(
            statements.map((statement) => nativeStatements.get(statement)?.statement ?? statement),
          );
          if (selected && afterCommit) {
            await action();
            throw new Error('D1 response lost after commit');
          }
          return result;
        };
      const value = Reflect.get(target, property, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  return {
    ctx: { ...jobCtxOf(kit), env: { ...kit.ctx.env, DB: proxy } },
    intercepted: () => intercepted,
  };
}

describe('holder image write fences', () => {
  it.each(['asset', 'photo'] as const)(
    'allocates a different key for every identical %s upload',
    async (kind) => {
      const pass = await kit.pass();
      await upload(kind, jobCtxOf(kit), pass.id);
      const firstKey = await imageKey(kind, pass.id);
      if (!firstKey) throw new Error('Missing first image');
      await upload(kind, jobCtxOf(kit), pass.id);
      const secondKey = await imageKey(kind, pass.id);
      expect(secondKey).toBeTruthy();
      expect(secondKey).not.toBe(firstKey);
      const object = await kit.env.BUCKET.get(secondKey!);
      expect(object).not.toBeNull();
      const expected = kind === 'asset' ? logo : memberPhotoPixels(photo);
      expect(new Uint8Array(await object!.arrayBuffer())).toEqual(expected);
      const table = kind === 'asset' ? 'pass_assets' : 'member_photos';
      expect(
        await first(kit.env.DB, `SELECT sha1, size, crc32 FROM ${table} WHERE pass_id = ?`, [
          pass.id,
        ]),
      ).toEqual({ sha1: await sha1Hex(expected), size: expected.length, crc32: crc32(expected) });
      expect(
        await first(kit.env.DB, 'SELECT 1 FROM pass_transfer_asset_gc WHERE r2_key = ?', [
          firstKey,
        ]),
      ).not.toBeNull();
    },
    120_000,
  );

  it.each(['asset', 'photo'] as const)(
    'preserves a %s object shared with the other table when replacing it',
    async (kind) => {
      const pass = await kit.pass();
      const other = await kit.pass();
      await upload(kind, jobCtxOf(kit), pass.id);
      const oldKey = await imageKey(kind, pass.id);
      if (!oldKey) throw new Error('Missing original image');
      await referenceFromOtherTable(kind, other, oldKey);
      await upload(kind, jobCtxOf(kit), pass.id);
      expect(await imageKey(kind, pass.id)).not.toBe(oldKey);
      expect(await kit.env.BUCKET.get(oldKey)).not.toBeNull();
      expect(
        await first(kit.env.DB, 'SELECT 1 FROM pass_transfer_asset_gc WHERE r2_key = ?', [oldKey]),
      ).not.toBeNull();
    },
    120_000,
  );

  it('keeps a cross-table shared key while another replacement may still roll back', async () => {
    const assetPass = await kit.pass();
    const photoPass = await kit.pass();
    await upload('asset', jobCtxOf(kit), assetPass.id);
    const shared = await imageKey('asset', assetPass.id);
    if (!shared) throw new Error('Missing shared image');
    await referenceFromOtherTable('asset', photoPass, shared);
    const assetEntered = deferred.withResolvers<void>();
    const photoEntered = deferred.withResolvers<void>();
    const assetGate = deferred.withResolvers<void>();
    const photoGate = deferred.withResolvers<void>();
    const original = kit.env.BUCKET.put.bind(kit.env.BUCKET);
    const spy = vi.spyOn(kit.env.BUCKET, 'put').mockImplementation(async (key, bytes, options) => {
      if (key.startsWith(`passes/${assetPass.id}/`)) {
        assetEntered.resolve();
        await assetGate.promise;
      } else if (key.startsWith(`passes/${photoPass.id}/`)) {
        photoEntered.resolve();
        await photoGate.promise;
        throw new Error('Photo publication unavailable');
      }
      return original(key, bytes, options);
    });
    try {
      const assetWork = upload('asset', jobCtxOf(kit), assetPass.id);
      const photoWork = putMemberPhoto(
        jobCtxOf(kit),
        system,
        photoPass.id,
        { png: encoded, includeInPass: true },
        null,
      ).then(
        () => null,
        (error: unknown) => error,
      );
      await Promise.all([assetEntered.promise, photoEntered.promise]);
      assetGate.resolve();
      await assetWork;
      expect(await kit.env.BUCKET.get(shared)).not.toBeNull();
      expect(
        await first(kit.env.DB, 'SELECT 1 FROM pass_transfer_asset_gc WHERE r2_key = ?', [shared]),
      ).not.toBeNull();
      photoGate.resolve();
      expect(await photoWork).toMatchObject({ message: 'Photo publication unavailable' });
      expect(await imageKey('photo', photoPass.id)).toBe(shared);
      expect(await kit.env.BUCKET.get(shared)).not.toBeNull();
    } finally {
      assetGate.resolve();
      photoGate.resolve();
      spy.mockRestore();
    }
  }, 120_000);

  it.each(['asset', 'photo'] as const)(
    'does not PUT a retired %s key or overwrite an existing R2 object',
    async (kind) => {
      const pass = await kit.pass();
      const state = await captureImageWriteState(kit.ctx, pass);
      const retired = `${prefix(kind, pass.orgId, pass.id)}retired.png`;
      await retireUnusedPassAssetKey(kit.env.DB, { key: retired, now: kit.clock.now() });
      const spy = vi.spyOn(kit.env.BUCKET, 'put');
      try {
        await expect(putPassImageObject(kit.ctx, state, retired, logo)).rejects.toMatchObject({
          code: 'PASS_CONFLICT',
        });
        expect(spy).not.toHaveBeenCalled();
      } finally {
        spy.mockRestore();
      }
      const occupied = `${prefix(kind, pass.orgId, pass.id)}occupied.png`;
      await kit.env.BUCKET.put(occupied, photo);
      await expect(putPassImageObject(kit.ctx, state, occupied, logo)).rejects.toMatchObject({
        code: 'PASS_CONFLICT',
      });
      const object = await kit.env.BUCKET.get(occupied);
      expect(new Uint8Array(await object!.arrayBuffer())).toEqual(photo);
      expect(
        await first(kit.env.DB, 'SELECT 1 FROM pass_transfer_asset_gc WHERE r2_key = ?', [
          occupied,
        ]),
      ).toBeNull();
      expect(
        await first(kit.env.DB, 'SELECT 1 FROM pass_transfer_asset_uploads WHERE r2_key = ?', [
          occupied,
        ]),
      ).toBeNull();
    },
    120_000,
  );

  it.each(['asset', 'photo'] as const)(
    'rejects a forced %s upload token collision with a retired key before R2',
    async (kind) => {
      const pass = await kit.pass();
      const nonce = 'forced-collision';
      const bytes = kind === 'asset' ? logo : memberPhotoPixels(photo);
      const key = `${prefix(kind, pass.orgId, pass.id)}${nonce}-${await sha1Hex(bytes)}.png`;
      await retireUnusedPassAssetKey(kit.env.DB, { key, now: kit.clock.now() });
      const ctx = {
        ...jobCtxOf(kit),
        ids: {
          ...kit.ctx.ids,
          token: (length?: number) => (length === 32 ? nonce : kit.ctx.ids.token(length)),
        },
      };
      const spy = vi.spyOn(kit.env.BUCKET, 'put');
      try {
        await expect(upload(kind, ctx, pass.id)).rejects.toMatchObject({ status: 409 });
        expect(spy).not.toHaveBeenCalled();
        expect(await imageKey(kind, pass.id)).toBeNull();
      } finally {
        spy.mockRestore();
      }
    },
    120_000,
  );

  it.each(['asset', 'photo'] as const)(
    'retains an opposite-table %s reference when the D1 insert trigger fails',
    async (kind) => {
      const pass = await kit.pass();
      const other = await kit.pass();
      const table = kind === 'asset' ? 'pass_assets' : 'member_photos';
      const trigger = `fail_image_${kind}`;
      await run(
        kit.env.DB,
        `CREATE TRIGGER ${trigger} BEFORE INSERT ON ${table}
        BEGIN SELECT RAISE(ABORT, 'forced image insert failure'); END`,
      );
      let written = '';
      const original = kit.env.BUCKET.put.bind(kit.env.BUCKET);
      const spy = vi
        .spyOn(kit.env.BUCKET, 'put')
        .mockImplementation(async (key, bytes, options) => {
          const result = await original(key, bytes, options);
          if (key.startsWith(prefix(kind, pass.orgId, pass.id))) {
            written = key;
            await referenceFromOtherTable(kind, other, key);
          }
          return result;
        });
      try {
        await expect(upload(kind, jobCtxOf(kit), pass.id)).rejects.toThrow(
          'forced image insert failure',
        );
        expect(written).not.toBe('');
        expect(await imageKey(kind, pass.id)).toBeNull();
        expect(await kit.env.BUCKET.get(written)).not.toBeNull();
        expect(
          await first(kit.env.DB, 'SELECT 1 FROM pass_transfer_asset_gc WHERE r2_key = ?', [
            written,
          ]),
        ).not.toBeNull();
      } finally {
        spy.mockRestore();
        await run(kit.env.DB, `DROP TRIGGER ${trigger}`);
      }
    },
    120_000,
  );

  it.each(['asset', 'photo'] as const)(
    'does not delete a shared %s object when the D1 commit response is lost',
    async (kind) => {
      const pass = await kit.pass();
      const other = await kit.pass();
      let written = '';
      const original = kit.env.BUCKET.put.bind(kit.env.BUCKET);
      const spy = vi
        .spyOn(kit.env.BUCKET, 'put')
        .mockImplementation(async (key, bytes, options) => {
          const result = await original(key, bytes, options);
          if (key.startsWith(prefix(kind, pass.orgId, pass.id))) written = key;
          return result;
        });
      const intercepted = interposeWrite(
        kind,
        async () => {
          if (!written) throw new Error('Missing uploaded key');
          await referenceFromOtherTable(kind, other, written);
        },
        true,
      );
      try {
        await expect(upload(kind, intercepted.ctx, pass.id)).rejects.toThrow(
          'D1 response lost after commit',
        );
        expect(intercepted.intercepted()).toBe(true);
        expect(await imageKey(kind, pass.id)).toBeNull();
        expect(await kit.env.BUCKET.get(written)).not.toBeNull();
        expect(
          await first(kit.env.DB, 'SELECT 1 FROM pass_transfer_asset_gc WHERE r2_key = ?', [
            written,
          ]),
        ).not.toBeNull();
      } finally {
        spy.mockRestore();
      }
    },
    120_000,
  );

  it.each(['asset', 'photo'] as const)(
    'rechecks %s operator authority after the R2 PUT',
    async (kind) => {
      const pass = await kit.pass();
      const user = await makeUser(kit.fx);
      await grantKitMembership(kit, pass.orgId, user.id);
      const session = await createSession(kit.ctx, {
        userId: user.id,
        roles: ['user'],
        amr: 'oidc',
        ipPrefix: null,
        userAgent: null,
      });
      const resolved = await resolveSession(kit.env, kit.clock, session.cookieValue);
      if (!resolved) throw new Error('Missing session');
      const authority = await tenantAuthorityOf(
        kit.ctx,
        { ...resolved, mode: 'live' },
        pass.orgId,
        'passes:operate',
      );
      if (authority.kind !== 'session') throw new Error('Expected session authority');
      let written = '';
      const original = kit.env.BUCKET.put.bind(kit.env.BUCKET);
      const spy = vi
        .spyOn(kit.env.BUCKET, 'put')
        .mockImplementation(async (key, bytes, options) => {
          const result = await original(key, bytes, options);
          if (key.startsWith(prefix(kind, pass.orgId, pass.id))) {
            written = key;
            await run(kit.env.DB, 'UPDATE sessions SET revoked_at = ? WHERE id_hash = ?', [
              kit.clock.now(),
              authority.sessionId,
            ]);
          }
          return result;
        });
      try {
        await expect(upload(kind, jobCtxOf(kit), pass.id, authority)).rejects.toMatchObject({
          status: 403,
        });
        expect(written).not.toBe('');
        expect(await imageKey(kind, pass.id)).toBeNull();
        expect(
          await first(kit.env.DB, 'SELECT 1 FROM pass_transfer_asset_gc WHERE r2_key = ?', [
            written,
          ]),
        ).not.toBeNull();
      } finally {
        spy.mockRestore();
      }
    },
    120_000,
  );

  it.each(['asset', 'photo'] as const)(
    'checks %s operator authority in the final D1 CAS',
    async (kind) => {
      const pass = await kit.pass();
      const user = await makeUser(kit.fx);
      await grantKitMembership(kit, pass.orgId, user.id);
      const session = await createSession(kit.ctx, {
        userId: user.id,
        roles: ['user'],
        amr: 'oidc',
        ipPrefix: null,
        userAgent: null,
      });
      const resolved = await resolveSession(kit.env, kit.clock, session.cookieValue);
      if (!resolved) throw new Error('Missing session');
      const authority = await tenantAuthorityOf(
        kit.ctx,
        { ...resolved, mode: 'live' },
        pass.orgId,
        'passes:operate',
      );
      if (authority.kind !== 'session') throw new Error('Expected session authority');
      const intercepted = interposeWrite(kind, async () => {
        await run(kit.env.DB, 'UPDATE sessions SET revoked_at = ? WHERE id_hash = ?', [
          kit.clock.now(),
          authority.sessionId,
        ]);
      });
      await expect(upload(kind, intercepted.ctx, pass.id, authority)).rejects.toMatchObject({
        status: 403,
      });
      expect(intercepted.intercepted()).toBe(true);
      expect(await imageKey(kind, pass.id)).toBeNull();
    },
    120_000,
  );

  it.each(['asset', 'photo'] as const)(
    'does not start a %s PUT while a real credential transfer is pending',
    async (kind) => {
      const pass = await kit.pass();
      const entered = deferred.withResolvers<void>();
      const gate = deferred.withResolvers<void>();
      const original = kit.env.BUCKET.put.bind(kit.env.BUCKET);
      let imagePuts = 0;
      const spy = vi
        .spyOn(kit.env.BUCKET, 'put')
        .mockImplementation(async (key, bytes, options) => {
          if (key.startsWith(prefix(kind, pass.orgId, pass.id))) imagePuts++;
          if (key.startsWith(`passes/${pass.id}/`)) {
            entered.resolve();
            await gate.promise;
          }
          return original(key, bytes, options);
        });
      try {
        const pending = transfer(pass.id);
        await entered.promise;
        await expect(upload(kind, jobCtxOf(kit), pass.id)).rejects.toMatchObject({ status: 409 });
        expect(imagePuts).toBe(0);
        gate.resolve();
        expect((await pending).state).toBe('completed');
        expect(await imageKey(kind, pass.id)).toBeNull();
      } finally {
        gate.resolve();
        spy.mockRestore();
      }
    },
    120_000,
  );

  it('does not upload a derived image after transfer wins during resizing', async () => {
    const pass = await kit.pass();
    const entered = deferred.withResolvers<void>();
    const gate = deferred.withResolvers<void>();
    const original = kit.env.BUCKET.put.bind(kit.env.BUCKET);
    const keys: string[] = [];
    const spy = vi.spyOn(kit.env.BUCKET, 'put').mockImplementation(async (key, bytes, options) => {
      if (key.startsWith(`pass-assets/${pass.id}/`)) keys.push(key);
      return original(key, bytes, options);
    });
    try {
      const work = putPassAsset(jobCtxOf(kit), system, pass.id, 'thumbnail@3x.png', photo, null, {
        resize: async (_bytes, width, height) => {
          entered.resolve();
          await gate.promise;
          return makePng(width, height);
        },
      }).then(
        () => null,
        (error: unknown) => error,
      );
      await entered.promise;
      expect(keys).toHaveLength(1);
      expect((await transfer(pass.id)).state).toBe('completed');
      expect(
        await first(kit.env.DB, 'SELECT 1 FROM pass_transfer_asset_gc WHERE r2_key = ?', [keys[0]]),
      ).not.toBeNull();
      gate.resolve();
      expect(await work).toMatchObject({ status: 409 });
      expect(keys).toHaveLength(1);
      expect(
        await first(kit.env.DB, 'SELECT 1 FROM pass_assets WHERE pass_id = ?', [pass.id]),
      ).toBeNull();
    } finally {
      gate.resolve();
      spy.mockRestore();
    }
  }, 120_000);

  it.each(['asset', 'photo'] as const)(
    'rejects a %s upload when transfer completes between preflight and D1 CAS',
    async (kind) => {
      const pass = await kit.pass();
      let written = '';
      const original = kit.env.BUCKET.put.bind(kit.env.BUCKET);
      const spy = vi
        .spyOn(kit.env.BUCKET, 'put')
        .mockImplementation(async (key, bytes, options) => {
          const result = await original(key, bytes, options);
          if (key.startsWith(prefix(kind, pass.orgId, pass.id))) written = key;
          return result;
        });
      const intercepted = interposeWrite(kind, async () => {
        expect((await transfer(pass.id)).state).toBe('completed');
      });
      try {
        await expect(upload(kind, intercepted.ctx, pass.id)).rejects.toMatchObject({ status: 409 });
        expect(intercepted.intercepted()).toBe(true);
        expect(await imageKey(kind, pass.id)).toBeNull();
        expect(
          await first(kit.env.DB, 'SELECT 1 FROM pass_transfer_asset_gc WHERE r2_key = ?', [
            written,
          ]),
        ).not.toBeNull();
        expect(await kit.env.BUCKET.get(written)).toBeNull();
      } finally {
        spy.mockRestore();
      }
    },
    120_000,
  );

  it.each(['asset', 'photo'] as const)(
    'retires both %s generations when transfer wins after staging but before publication',
    async (kind) => {
      const pass = await kit.pass();
      await upload(kind, jobCtxOf(kit), pass.id);
      const previous = await imageKey(kind, pass.id);
      if (!previous) throw new Error('Missing prior image');
      const entered = deferred.withResolvers<void>();
      const gate = deferred.withResolvers<void>();
      const original = kit.env.BUCKET.put.bind(kit.env.BUCKET);
      let held = false;
      const spy = vi
        .spyOn(kit.env.BUCKET, 'put')
        .mockImplementation(async (key, bytes, options) => {
          if (!held && key.startsWith(`passes/${pass.id}/`)) {
            held = true;
            entered.resolve();
            await gate.promise;
          }
          return original(key, bytes, options);
        });
      try {
        const work = (
          kind === 'asset'
            ? upload(kind, jobCtxOf(kit), pass.id)
            : putMemberPhoto(
                jobCtxOf(kit),
                system,
                pass.id,
                { png: encoded, includeInPass: true },
                null,
              )
        ).then(
          () => null,
          (error: unknown) => error,
        );
        await entered.promise;
        const staged = await imageKey(kind, pass.id);
        if (!staged || staged === previous) throw new Error('Missing newly staged image');
        expect((await transfer(pass.id)).state).toBe('completed');
        // This must already be durable if the blocked uploader crashes before its catch runs.
        for (const key of [previous, staged])
          expect(
            await first(kit.env.DB, 'SELECT 1 FROM pass_transfer_asset_gc WHERE r2_key = ?', [key]),
          ).not.toBeNull();
        gate.resolve();
        expect(await work).toMatchObject({ status: 409 });
        expect(await imageKey(kind, pass.id)).toBeNull();
        for (const key of [previous, staged]) {
          expect(
            await first(kit.env.DB, 'SELECT 1 FROM pass_transfer_asset_gc WHERE r2_key = ?', [key]),
          ).not.toBeNull();
          await sweepOneTransferAssetGc(jobCtxOf(kit), key);
          expect(await kit.env.BUCKET.get(key)).toBeNull();
        }
      } finally {
        gate.resolve();
        spy.mockRestore();
      }
    },
    120_000,
  );

  it.each([
    ['asset', 'before'],
    ['asset', 'after'],
    ['photo', 'before'],
    ['photo', 'after'],
  ] as const)(
    'fences a %s upload paused %s its R2 PUT across a complete transfer',
    async (kind, when) => {
      const pass = await kit.pass();
      await upload(kind, jobCtxOf(kit), pass.id);
      const oldKey = await imageKey(kind, pass.id);
      if (!oldKey) throw new Error('Missing prior holder image');
      const entered = deferred.withResolvers<void>();
      const gate = deferred.withResolvers<void>();
      const original = kit.env.BUCKET.put.bind(kit.env.BUCKET);
      let written = '';
      const spy = vi
        .spyOn(kit.env.BUCKET, 'put')
        .mockImplementation(async (key, bytes, options) => {
          if (!key.startsWith(prefix(kind, pass.orgId, pass.id)))
            return original(key, bytes, options);
          written = key;
          if (when === 'before') {
            entered.resolve();
            await gate.promise;
            return original(key, bytes, options);
          }
          const result = await original(key, bytes, options);
          entered.resolve();
          await gate.promise;
          return result;
        });
      try {
        const pending = upload(kind, jobCtxOf(kit), pass.id).then(
          () => null,
          (error: unknown) => error,
        );
        await entered.promise;
        expect(
          await first(
            kit.env.DB,
            `SELECT pass_id, credential_generation FROM pass_transfer_asset_uploads
          WHERE r2_key = ?`,
            [written],
          ),
        ).toEqual({ pass_id: pass.id, credential_generation: pass.credentialGeneration });
        expect((await transfer(pass.id)).state).toBe('completed');
        // A crash here must still leave even an uncommitted upload durably retired.
        expect(
          await first(kit.env.DB, 'SELECT 1 FROM pass_transfer_asset_gc WHERE r2_key = ?', [
            written,
          ]),
        ).not.toBeNull();
        expect(
          await first(kit.env.DB, 'SELECT 1 FROM pass_transfer_asset_uploads WHERE r2_key = ?', [
            written,
          ]),
        ).toBeNull();
        gate.resolve();
        expect(await pending).toMatchObject({ status: 409 });
        expect(written).not.toBe(oldKey);
        expect(await imageKey(kind, pass.id)).toBeNull();
        for (const key of [oldKey, written])
          expect(
            await first(kit.env.DB, 'SELECT 1 FROM pass_transfer_asset_gc WHERE r2_key = ?', [key]),
          ).not.toBeNull();
        expect(await kit.env.BUCKET.get(written)).toBeNull();
        spy.mockRestore();
        await upload(kind, jobCtxOf(kit), pass.id);
        const fresh = await imageKey(kind, pass.id);
        expect(fresh).toBeTruthy();
        expect([oldKey, written]).not.toContain(fresh);
        expect(await kit.env.BUCKET.get(fresh!)).not.toBeNull();
      } finally {
        gate.resolve();
        spy.mockRestore();
      }
    },
    120_000,
  );
});
