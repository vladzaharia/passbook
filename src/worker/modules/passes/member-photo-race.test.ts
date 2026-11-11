import { beforeAll, describe, expect, it, vi } from 'vitest';
import { first } from '../../platform/db.ts';
import { jobCtxOf } from '../delivery/delivery-test-fixtures.ts';
import { deleteMemberPhoto, putMemberPhoto, updateMemberPhoto } from './member-photo.ts';
import {
  actor,
  encoded,
  type MemberPhotoFixture,
  png,
  setupPhotoTestKit,
} from './member-photo-test-fixtures.ts';
import { memberPhoto } from './repo-member-photo.ts';
import { getPass } from './repo-read-pass.ts';

let kit: MemberPhotoFixture['kit'];
let api: MemberPhotoFixture['api'];
beforeAll(async () => {
  ({ kit, api } = await setupPhotoTestKit());
});

describe('member photo mutation races', () => {
  it('does not let a losing upload delete the winning identical image', async () => {
    const pass = await kit.pass();
    const prefix = `member-photos/${pass.orgId}/${pass.id}/`;
    const put = kit.env.BUCKET.put.bind(kit.env.BUCKET);
    let firstKey = '';
    let reachedPut!: () => void;
    let releasePut!: () => void;
    const firstWritten = new Promise<void>((resolve) => {
      reachedPut = resolve;
    });
    const paused = new Promise<void>((resolve) => {
      releasePut = resolve;
    });
    const spy = vi.spyOn(kit.env.BUCKET, 'put').mockImplementation(async (key, value, options) => {
      const object = await put(key, value, options);
      if (key.startsWith(prefix) && !firstKey) {
        firstKey = key;
        reachedPut();
        await paused;
      }
      return object;
    });
    const firstUpload = putMemberPhoto(
      jobCtxOf(kit),
      actor,
      pass.id,
      { png: encoded, includeInPass: false },
      null,
    );
    void firstUpload.catch(() => {});
    try {
      await Promise.race([
        firstWritten,
        firstUpload.then(() => {
          throw new Error('Upload completed before the test pause');
        }),
      ]);
      await putMemberPhoto(
        jobCtxOf(kit),
        actor,
        pass.id,
        { png: encoded, includeInPass: false },
        null,
      );
      const winner = (await memberPhoto(kit.env.DB, pass.orgId, pass.id))!;
      expect(winner.r2_key).not.toBe(firstKey);
      releasePut();
      await expect(firstUpload).rejects.toMatchObject({ status: 409, code: 'PASS_CONFLICT' });
      expect(await memberPhoto(kit.env.DB, pass.orgId, pass.id)).toEqual(winner);
      expect(await kit.env.BUCKET.get(firstKey)).toBeNull();
      expect(
        await first(kit.env.DB, 'SELECT 1 FROM pass_transfer_asset_gc WHERE r2_key = ?', [
          firstKey,
        ]),
      ).not.toBeNull();
      const object = await kit.env.BUCKET.get(winner.r2_key);
      expect(object).not.toBeNull();
      expect(new Uint8Array(await object!.arrayBuffer())).toEqual(png);
      const after = (await getPass(kit.env.DB, pass.id))!;
      expect(after.linkGeneration).toBe(pass.linkGeneration + 1);
      expect(after.downloadToken).toBe(pass.downloadToken);
    } finally {
      releasePut();
      await firstUpload.catch(() => {});
      spy.mockRestore();
    }
  });

  it.each(['put', 'update'] as const)(
    'keeps the %s object needed by a later failed-delete rollback when an earlier rollback loses',
    async (operation) => {
      const pass = await kit.pass();
      await putMemberPhoto(
        jobCtxOf(kit),
        actor,
        pass.id,
        { png: encoded, includeInPass: false },
        null,
      );
      const original = (await memberPhoto(kit.env.DB, pass.orgId, pass.id))!;
      const priorPass = (await getPass(kit.env.DB, pass.id))!;
      const resolve = kit.registry.resolve.bind(kit.registry);
      let superseded: typeof original | undefined;
      let deletion: Promise<unknown> | undefined;
      let deletionStarted!: () => void;
      let rejectDeletion!: (error: Error) => void;
      const deletionReachedBuild = new Promise<void>((signal) => {
        deletionStarted = signal;
      });
      const deletionBuild = new Promise<never>((_, reject) => {
        rejectDeletion = reject;
      });
      void deletionBuild.catch(() => {});
      let calls = 0;
      const spy = vi.spyOn(kit.registry, 'resolve').mockImplementation(async (...args) => {
        calls += 1;
        if (calls === 1) return resolve(...args);
        if (calls === 2) {
          superseded = (await memberPhoto(kit.env.DB, pass.orgId, pass.id))!;
          deletion = deleteMemberPhoto(jobCtxOf(kit), actor, pass.id, null);
          void deletion.catch(() => {});
          await Promise.race([
            deletionReachedBuild,
            deletion.then(() => {
              throw new Error('Deletion completed before the test pause');
            }),
          ]);
          throw new Error('First signing unavailable');
        }
        if (calls === 3) {
          deletionStarted();
          return deletionBuild;
        }
        return resolve(...args);
      });
      try {
        const pending =
          operation === 'put'
            ? putMemberPhoto(
                jobCtxOf(kit),
                actor,
                pass.id,
                { png: encoded, includeInPass: true },
                null,
              )
            : updateMemberPhoto(jobCtxOf(kit), actor, pass.id, true, null);
        await expect(pending).rejects.toThrow('First signing unavailable');
        expect(await memberPhoto(kit.env.DB, pass.orgId, pass.id)).toBeNull();
        expect(superseded).toBeDefined();
        if (operation === 'put') expect(superseded!.r2_key).not.toBe(original.r2_key);
        else expect(superseded!.r2_key).toBe(original.r2_key);
        expect(await kit.env.BUCKET.get(superseded!.r2_key)).not.toBeNull();
        const deletionResult = expect(deletion!).rejects.toThrow('Second signing unavailable');
        rejectDeletion(new Error('Second signing unavailable'));
        await deletionResult;
        const restored = (await memberPhoto(kit.env.DB, pass.orgId, pass.id))!;
        expect(restored).toEqual(superseded);
        expect(restored.include_in_pass).toBe(1);
        expect(restored.version).not.toBe(original.version);
        const object = await kit.env.BUCKET.get(restored.r2_key);
        expect(object).not.toBeNull();
        expect(new Uint8Array(await object!.arrayBuffer())).toEqual(png);
        const after = (await getPass(kit.env.DB, pass.id))!;
        expect(after.linkGeneration).toBe(priorPass.linkGeneration + 3);
        expect(after.downloadToken).toBe(pass.downloadToken);
      } finally {
        rejectDeletion(new Error('Test cleanup'));
        if (deletion !== undefined) await deletion.catch(() => {});
        spy.mockRestore();
      }
    },
  );

  it('reports a failed delete when a concurrent replacement wins', async () => {
    const pass = await kit.pass();
    await putMemberPhoto(
      jobCtxOf(kit),
      actor,
      pass.id,
      { png: encoded, includeInPass: true },
      null,
    );
    const original = (await memberPhoto(kit.env.DB, pass.orgId, pass.id))!;
    const priorPass = (await getPass(kit.env.DB, pass.id))!;
    let deletionStarted!: () => void;
    let rejectDeletion!: (error: Error) => void;
    const deletionReachedBuild = new Promise<void>((resolve) => {
      deletionStarted = resolve;
    });
    const deletionBuild = new Promise<never>((_, reject) => {
      rejectDeletion = reject;
    });
    void deletionBuild.catch(() => {});
    const spy = vi.spyOn(kit.registry, 'resolve').mockImplementationOnce(async () => {
      deletionStarted();
      return deletionBuild;
    });
    const deletion = api(pass.id, 'DELETE');
    void deletion.catch(() => {});
    try {
      await Promise.race([
        deletionReachedBuild,
        deletion.then(() => {
          throw new Error('Deletion completed before the test pause');
        }),
      ]);
      expect(await memberPhoto(kit.env.DB, pass.orgId, pass.id)).toBeNull();
      await putMemberPhoto(
        jobCtxOf(kit),
        actor,
        pass.id,
        { png: encoded, includeInPass: false },
        null,
      );
      const replacement = (await memberPhoto(kit.env.DB, pass.orgId, pass.id))!;
      expect(replacement.r2_key).not.toBe(original.r2_key);
      expect(await kit.env.BUCKET.get(original.r2_key)).not.toBeNull();
      rejectDeletion(new Error('Signing unavailable'));
      const deletionResponse = await deletion;
      expect(deletionResponse.ok).toBe(false);
      expect([409, 500]).toContain(deletionResponse.status);
      expect(deletionResponse.headers.get('content-type')).toContain('application/problem+json');
      expect(await deletionResponse.json()).toMatchObject({
        status: deletionResponse.status,
        detail: expect.stringMatching(/reload|try again/i),
      });
      expect(await memberPhoto(kit.env.DB, pass.orgId, pass.id)).toEqual(replacement);
      const object = await kit.env.BUCKET.get(replacement.r2_key);
      expect(object).not.toBeNull();
      expect(new Uint8Array(await object!.arrayBuffer())).toEqual(png);
      expect(
        await first(kit.env.DB, 'SELECT 1 FROM pass_transfer_asset_gc WHERE r2_key = ?', [
          original.r2_key,
        ]),
      ).not.toBeNull();
      const after = (await getPass(kit.env.DB, pass.id))!;
      expect(after.linkGeneration).toBe(priorPass.linkGeneration + 2);
      expect(after.downloadToken).toBe(pass.downloadToken);
    } finally {
      rejectDeletion(new Error('Test cleanup'));
      await deletion.catch(() => {});
      spy.mockRestore();
    }
  });

  it('keeps a shared object when a stale setting edit loses to a pending delete', async () => {
    const pass = await kit.pass();
    await putMemberPhoto(
      jobCtxOf(kit),
      actor,
      pass.id,
      { png: encoded, includeInPass: true },
      null,
    );
    const original = (await memberPhoto(kit.env.DB, pass.orgId, pass.id))!;
    const priorPass = (await getPass(kit.env.DB, pass.id))!;
    let reachedBatch!: () => void;
    let releaseBatch!: () => void;
    const batchReached = new Promise<void>((resolve) => {
      reachedBatch = resolve;
    });
    const paused = new Promise<void>((resolve) => {
      releaseBatch = resolve;
    });
    const db = new Proxy(kit.env.DB, {
      get(target, property) {
        if (property === 'batch')
          return async (statements: D1PreparedStatement[]) => {
            reachedBatch();
            await paused;
            return target.batch(statements);
          };
        const value = Reflect.get(target, property, target);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    const pausedCtx = { ...jobCtxOf(kit), env: { ...kit.env, DB: db } };
    let deletionStarted!: () => void;
    let rejectDeletion!: (error: Error) => void;
    const deletionReachedBuild = new Promise<void>((resolve) => {
      deletionStarted = resolve;
    });
    const deletionBuild = new Promise<never>((_, reject) => {
      rejectDeletion = reject;
    });
    void deletionBuild.catch(() => {});
    const spy = vi.spyOn(kit.registry, 'resolve').mockImplementationOnce(async () => {
      deletionStarted();
      return deletionBuild;
    });
    const update = updateMemberPhoto(pausedCtx, actor, pass.id, false, null);
    void update.catch(() => {});
    let deletion: Promise<unknown> | undefined;
    try {
      await Promise.race([
        batchReached,
        update.then(() => {
          throw new Error('Update completed before the test pause');
        }),
      ]);
      deletion = deleteMemberPhoto(jobCtxOf(kit), actor, pass.id, null);
      void deletion.catch(() => {});
      await Promise.race([
        deletionReachedBuild,
        deletion.then(() => {
          throw new Error('Deletion completed before the test pause');
        }),
      ]);
      releaseBatch();
      await expect(update).rejects.toMatchObject({ code: 'MEMBER_PHOTO_CHANGED' });
      expect(await memberPhoto(kit.env.DB, pass.orgId, pass.id)).toBeNull();
      expect(await kit.env.BUCKET.get(original.r2_key)).not.toBeNull();
      const deletionResult = expect(deletion).rejects.toThrow('Deletion signing unavailable');
      rejectDeletion(new Error('Deletion signing unavailable'));
      await deletionResult;
      expect(await memberPhoto(kit.env.DB, pass.orgId, pass.id)).toEqual(original);
      const object = await kit.env.BUCKET.get(original.r2_key);
      expect(object).not.toBeNull();
      expect(new Uint8Array(await object!.arrayBuffer())).toEqual(png);
      const after = (await getPass(kit.env.DB, pass.id))!;
      expect(after.linkGeneration).toBe(priorPass.linkGeneration + 2);
      expect(after.downloadToken).toBe(pass.downloadToken);
    } finally {
      releaseBatch();
      rejectDeletion(new Error('Test cleanup'));
      await update.catch(() => {});
      if (deletion !== undefined) await deletion.catch(() => {});
      spy.mockRestore();
    }
  });
});
