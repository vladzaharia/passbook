import { beforeAll, describe, expect, it } from 'vitest';
import { first } from '../../platform/db.ts';
import { jobCtxOf } from '../delivery/delivery-test-fixtures.ts';
import { overrideDeps } from './deps.ts';
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
let files: MemberPhotoFixture['files'];
beforeAll(async () => {
  ({ kit, files } = await setupPhotoTestKit());
});

describe('member photo publication failure', () => {
  it.each(['put', 'update', 'delete'] as const)(
    'does not roll back a %s after the Wallet artifact commits',
    async (operation) => {
      const pass = await kit.pass();
      await putMemberPhoto(
        jobCtxOf(kit),
        actor,
        pass.id,
        { png: encoded, includeInPass: operation === 'delete' },
        null,
      );
      const before = (await memberPhoto(kit.env.DB, pass.orgId, pass.id))!;
      const prior = (await getPass(kit.env.DB, pass.id))!;
      const failAfterCommit = {
        ...jobCtxOf(kit),
        waitUntil() {
          throw new Error('Post-publication dispatch unavailable');
        },
      };
      const pending =
        operation === 'delete'
          ? deleteMemberPhoto(failAfterCommit, actor, pass.id, null)
          : operation === 'update'
            ? updateMemberPhoto(failAfterCommit, actor, pass.id, true, null)
            : putMemberPhoto(
                failAfterCommit,
                actor,
                pass.id,
                { png: encoded, includeInPass: true },
                null,
              );
      await expect(pending).rejects.toThrow('Post-publication dispatch unavailable');

      const after = (await getPass(kit.env.DB, pass.id))!;
      expect(after.version).toBe(prior.version + 1);
      expect(after.linkGeneration).toBe(prior.linkGeneration + 1);
      expect(after.downloadToken).toBe(prior.downloadToken);
      const current = await memberPhoto(kit.env.DB, pass.orgId, pass.id);
      const contents = await files(pass.id);
      if (operation === 'delete') {
        expect(current).toBeNull();
        expect(contents['thumbnail@3x.png']).toBeUndefined();
      } else {
        expect(current).not.toBeNull();
        expect(current!.include_in_pass).toBe(1);
        expect(current!.version).not.toBe(before.version);
        if (operation === 'put') expect(current!.r2_key).not.toBe(before.r2_key);
        const object = await kit.env.BUCKET.get(current!.r2_key);
        expect(object).not.toBeNull();
        expect(new Uint8Array(await object!.arrayBuffer())).toEqual(png);
        expect(contents['thumbnail@3x.png']).toEqual(png);
      }
      if (operation === 'update') {
        // Setting-only updates keep the original object referenced.
        expect(await kit.env.BUCKET.get(before.r2_key)).not.toBeNull();
      } else {
        // A detached key is durably protected for rollback or queued for GC.
        expect(
          await first(
            kit.env.DB,
            `SELECT 1 FROM pass_transfer_asset_gc WHERE r2_key = ?
           UNION ALL SELECT 1 FROM pass_transfer_asset_candidates WHERE r2_key = ? LIMIT 1`,
            [before.r2_key, before.r2_key],
          ),
        ).not.toBeNull();
      }
    },
  );

  it('preserves the committed photo after an ambiguous D1 publish response', async () => {
    const pass = await kit.pass();
    await putMemberPhoto(
      jobCtxOf(kit),
      actor,
      pass.id,
      { png: encoded, includeInPass: false },
      null,
    );
    const before = (await memberPhoto(kit.env.DB, pass.orgId, pass.id))!;
    const prior = (await getPass(kit.env.DB, pass.id))!;
    let injected = false;
    const db = new Proxy(kit.env.DB, {
      get(target, property) {
        if (property === 'batch')
          return async (statements: D1PreparedStatement[]) => {
            const results = await target.batch(statements);
            const current = await getPass(target, pass.id);
            if (!injected && current && current.version > prior.version) {
              injected = true;
              throw new Error('Ambiguous D1 publish response');
            }
            return results;
          };
        const value = Reflect.get(target, property, target);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    const env = { ...kit.env, DB: db };
    overrideDeps(env, { registry: kit.registry, apns: kit.apns, mailer: kit.mailer });
    const ctx = { ...jobCtxOf(kit), env };
    await expect(
      putMemberPhoto(ctx, actor, pass.id, { png: encoded, includeInPass: true }, null),
    ).rejects.toThrow('Ambiguous D1 publish response');
    expect(injected).toBe(true);
    const after = (await getPass(kit.env.DB, pass.id))!;
    expect(after.version).toBe(prior.version + 1);
    expect(after.linkGeneration).toBe(prior.linkGeneration + 1);
    expect(after.downloadToken).toBe(prior.downloadToken);
    const photo = (await memberPhoto(kit.env.DB, pass.orgId, pass.id))!;
    expect(photo.version).not.toBe(before.version);
    expect(photo.r2_key).not.toBe(before.r2_key);
    expect(photo.include_in_pass).toBe(1);
    const object = await kit.env.BUCKET.get(photo.r2_key);
    expect(object).not.toBeNull();
    expect(new Uint8Array(await object!.arrayBuffer())).toEqual(png);
    expect(
      await first(
        kit.env.DB,
        `SELECT 1 FROM pass_transfer_asset_gc WHERE r2_key = ?
       UNION ALL SELECT 1 FROM pass_transfer_asset_candidates WHERE r2_key = ? LIMIT 1`,
        [before.r2_key, before.r2_key],
      ),
    ).not.toBeNull();
    expect((await files(pass.id))['thumbnail@3x.png']).toEqual(png);
  });
});
