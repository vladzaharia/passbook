import { beforeAll, describe, expect, it, vi } from 'vitest';
import { jobCtxOf } from '../delivery/delivery-test-fixtures.ts';
import { assertPassSnapshot, capturePassSnapshot, type PassSnapshot } from '../public/snapshot.ts';
import { deleteMemberPhoto, putMemberPhoto, updateMemberPhoto } from './member-photo.ts';
import {
  actor,
  encoded,
  type MemberPhotoFixture,
  png,
  setupPhotoTestKit,
} from './member-photo-test-fixtures.ts';
import { expectValidZip } from './pass-test-fixtures.ts';
import { capturePassImageGeneration } from './repo-history-image.ts';
import { memberPhoto, replaceMemberPhoto } from './repo-member-photo.ts';
import { getPass } from './repo-read-pass.ts';

let kit: MemberPhotoFixture['kit'];
let get: MemberPhotoFixture['get'];
let files: MemberPhotoFixture['files'];
beforeAll(async () => {
  ({ kit, get, files } = await setupPhotoTestKit());
});

describe('member photo lineage', () => {
  it.each(['add', 'replace', 'update', 'delete'] as const)(
    'advances lineage on a failed Wallet %s and its rollback without breaking the public link',
    async (operation) => {
      const pass = await kit.pass();
      if (operation !== 'add') {
        await putMemberPhoto(
          jobCtxOf(kit),
          actor,
          pass.id,
          { png: encoded, includeInPass: operation === 'delete' },
          null,
        );
      }
      const before = await memberPhoto(kit.env.DB, pass.orgId, pass.id);
      const priorPass = (await getPass(kit.env.DB, pass.id))!;
      const priorSnapshot = await capturePassSnapshot(kit.ctx, priorPass);
      let duringPhoto = before;
      let duringSnapshot: PassSnapshot | undefined;
      const resolve = kit.registry.resolve.bind(kit.registry);
      const spy = vi.spyOn(kit.registry, 'resolve').mockImplementation(async (...args) => {
        const current = (await getPass(kit.env.DB, pass.id))!;
        if (current.linkGeneration === priorPass.linkGeneration + 1) {
          duringPhoto = await memberPhoto(kit.env.DB, pass.orgId, pass.id);
          expect(current.downloadToken).toBe(pass.downloadToken);
          duringSnapshot = await capturePassSnapshot(kit.ctx, current);
          throw new Error('Signing unavailable');
        }
        return resolve(...args);
      });
      try {
        const pending =
          operation === 'delete'
            ? deleteMemberPhoto(jobCtxOf(kit), actor, pass.id, null)
            : operation === 'update'
              ? updateMemberPhoto(jobCtxOf(kit), actor, pass.id, true, null)
              : putMemberPhoto(
                  jobCtxOf(kit),
                  actor,
                  pass.id,
                  { png: encoded, includeInPass: true },
                  null,
                );
        await expect(pending).rejects.toThrow('Signing unavailable');
      } finally {
        spy.mockRestore();
      }
      expect(await memberPhoto(kit.env.DB, pass.orgId, pass.id)).toEqual(before);
      const after = (await getPass(kit.env.DB, pass.id))!;
      expect(after.linkGeneration).toBe(priorPass.linkGeneration + 2);
      expect(after.downloadToken).toBe(pass.downloadToken);
      expect(after.version).toBe(priorPass.version);
      expect(duringSnapshot).toBeDefined();
      await expect(assertPassSnapshot(kit.ctx, priorSnapshot)).rejects.toMatchObject({
        status: 404,
      });
      await expect(assertPassSnapshot(kit.ctx, duringSnapshot!)).rejects.toMatchObject({
        status: 404,
      });
      if (before) {
        const object = await kit.env.BUCKET.get(before.r2_key);
        expect(object).not.toBeNull();
        expect(new Uint8Array(await object!.arrayBuffer())).toEqual(png);
      }
      if (operation === 'add' || operation === 'replace') {
        expect(duringPhoto).not.toBeNull();
        expect(duringPhoto!.r2_key).not.toBe(before?.r2_key);
        expect(await kit.env.BUCKET.get(duringPhoto!.r2_key)).toBeNull();
      }
      const download = await get(`/p/${pass.downloadToken}/pass.pkpass`);
      expect(download.status).toBe(200);
      expectValidZip(new Uint8Array(await download.arrayBuffer()));
      const page = await get(`/p/${pass.downloadToken}`);
      expect(page.status).toBe(200);
      expect(await page.text()).toContain(`/p/${pass.downloadToken}/pass.pkpass`);
      const contents = await files(pass.id);
      if (operation === 'delete') expect(contents['thumbnail@3x.png']).toEqual(png);
      else expect(contents['thumbnail@3x.png']).toBeUndefined();
    },
  );

  it('advances same-tick photo changes without rotating the link', async () => {
    const pass = await kit.pass();
    const now = kit.clock.now();
    const snapshots = [await capturePassSnapshot(kit.ctx, pass)];

    await putMemberPhoto(
      jobCtxOf(kit),
      actor,
      pass.id,
      { png: encoded, includeInPass: false },
      null,
    );
    const added = (await getPass(kit.env.DB, pass.id))!;
    const original = (await memberPhoto(kit.env.DB, pass.orgId, pass.id))!;
    expect(added.linkGeneration).toBe(pass.linkGeneration + 1);
    expect(original.updated_at).toBe(now);
    snapshots.push(await capturePassSnapshot(kit.ctx, added));

    await updateMemberPhoto(jobCtxOf(kit), actor, pass.id, false, null);
    const updated = (await getPass(kit.env.DB, pass.id))!;
    const edited = (await memberPhoto(kit.env.DB, pass.orgId, pass.id))!;
    expect(updated.linkGeneration).toBe(pass.linkGeneration + 2);
    expect(edited.updated_at).toBe(now);
    expect(edited.r2_key).toBe(original.r2_key);
    expect(edited.version).not.toBe(original.version);
    expect(await kit.env.BUCKET.get(edited.r2_key)).not.toBeNull();
    snapshots.push(await capturePassSnapshot(kit.ctx, updated));

    await putMemberPhoto(
      jobCtxOf(kit),
      actor,
      pass.id,
      { png: encoded, includeInPass: false },
      null,
    );
    const replaced = (await getPass(kit.env.DB, pass.id))!;
    const replacement = (await memberPhoto(kit.env.DB, pass.orgId, pass.id))!;
    expect(replaced.linkGeneration).toBe(pass.linkGeneration + 3);
    expect(replacement.updated_at).toBe(now);
    expect(replacement.sha1).toBe(original.sha1);
    expect(replacement.r2_key).not.toBe(original.r2_key);
    expect(await kit.env.BUCKET.get(original.r2_key)).toBeNull();
    expect(await kit.env.BUCKET.get(replacement.r2_key)).not.toBeNull();
    snapshots.push(await capturePassSnapshot(kit.ctx, replaced));

    await deleteMemberPhoto(jobCtxOf(kit), actor, pass.id, null);
    const deleted = (await getPass(kit.env.DB, pass.id))!;
    expect(deleted.linkGeneration).toBe(pass.linkGeneration + 4);
    expect(deleted.downloadToken).toBe(pass.downloadToken);
    expect(deleted.version).toBe(pass.version);
    expect(kit.clock.now()).toBe(now);
    expect(await memberPhoto(kit.env.DB, pass.orgId, pass.id)).toBeNull();
    expect(await kit.env.BUCKET.get(replacement.r2_key)).toBeNull();
    for (const snapshot of snapshots)
      await expect(assertPassSnapshot(kit.ctx, snapshot)).rejects.toMatchObject({ status: 404 });

    const page = await get(`/p/${pass.downloadToken}`);
    expect(page.status).toBe(200);
    expect(await page.text()).toContain(`/p/${pass.downloadToken}/pass.pkpass`);
    const download = await get(`/p/${pass.downloadToken}/pass.pkpass`);
    expect(download.status).toBe(200);
    expectValidZip(new Uint8Array(await download.arrayBuffer()));
  });

  it('compares lineage and version across absent, replaced and restored photos', async () => {
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
    const snapshot = await capturePassSnapshot(kit.ctx, priorPass);
    const generation = priorPass.linkGeneration;
    const replacement = { ...original, version: kit.ctx.ids.token(16) };
    const newer = { ...original, version: kit.ctx.ids.token(16) };
    let candidateId: number | null = null;
    const replace = async (
      next: typeof original | null,
      version: string | null,
      expected: number,
      passVersion = priorPass.version,
    ) => {
      const current = (await getPass(kit.env.DB, pass.id))!;
      const now = kit.clock.now();
      const imageGeneration = await capturePassImageGeneration(kit.env.DB, current, now);
      if (imageGeneration === null) throw new Error('Pass image snapshot is missing');
      const guarded = { ...current, linkGeneration: expected, version: passVersion };
      const result = await replaceMemberPhoto(kit.env.DB, pass.orgId, pass.id, next, version, {
        pass: guarded,
        now,
        imageGeneration,
        ...(next && version === null && candidateId !== null ? { candidateId } : {}),
      });
      if (result.saved && next === null) {
        if (result.candidateId === null) throw new Error('Photo rollback hold is missing');
        candidateId = result.candidateId;
      }
      return result.saved;
    };

    expect(await replace(null, original.version, generation - 1)).toBe(false);
    expect(await replace(null, replacement.version, generation)).toBe(false);
    expect(await replace(replacement, replacement.version, generation)).toBe(false);
    expect(await replace(replacement, null, generation)).toBe(false);
    expect(await replace(null, null, generation)).toBe(false);
    expect(await replace(replacement, original.version, generation, priorPass.version - 1)).toBe(
      false,
    );
    expect(await replace(null, original.version, generation, priorPass.version - 1)).toBe(false);
    const imageGeneration = await capturePassImageGeneration(
      kit.env.DB,
      priorPass,
      kit.clock.now(),
    );
    if (imageGeneration === null) throw new Error('Pass image snapshot is missing');
    expect(
      (
        await replaceMemberPhoto(kit.env.DB, pass.orgId, pass.id, replacement, original.version, {
          pass: priorPass,
          now: kit.clock.now(),
          imageGeneration: imageGeneration + 1,
        })
      ).saved,
    ).toBe(false);
    expect(
      (
        await replaceMemberPhoto(
          kit.env.DB,
          `${pass.orgId}-other`,
          pass.id,
          replacement,
          original.version,
          { pass: priorPass, now: kit.clock.now(), imageGeneration },
        )
      ).saved,
    ).toBe(false);
    await expect(
      replace({ ...original, include_in_pass: 2 }, original.version, generation),
    ).rejects.toThrow();
    expect(await memberPhoto(kit.env.DB, pass.orgId, pass.id)).toEqual(original);
    expect((await getPass(kit.env.DB, pass.id))!.linkGeneration).toBe(generation);

    expect(await replace(null, original.version, generation)).toBe(true);
    // A stale update cannot silently become an insert.
    expect(await replace(replacement, original.version, generation + 1)).toBe(false);
    expect(await memberPhoto(kit.env.DB, pass.orgId, pass.id)).toBeNull();
    expect((await getPass(kit.env.DB, pass.id))!.linkGeneration).toBe(generation + 1);
    expect(await replace(replacement, null, generation + 1, priorPass.version - 1)).toBe(false);
    expect(await memberPhoto(kit.env.DB, pass.orgId, pass.id)).toBeNull();
    expect((await getPass(kit.env.DB, pass.id))!.linkGeneration).toBe(generation + 1);
    expect(await replace(replacement, null, generation + 1)).toBe(true);
    expect(await replace(null, replacement.version, generation + 2)).toBe(true);
    // This is a new absence, not the one observed at generation + 1.
    expect(await replace(original, null, generation + 1)).toBe(false);
    expect(await memberPhoto(kit.env.DB, pass.orgId, pass.id)).toBeNull();
    expect((await getPass(kit.env.DB, pass.id))!.linkGeneration).toBe(generation + 3);
    expect(await replace(newer, null, generation + 3)).toBe(true);
    expect(await replace(null, original.version, generation + 4)).toBe(false);
    expect(await memberPhoto(kit.env.DB, pass.orgId, pass.id)).toEqual(newer);
    expect((await getPass(kit.env.DB, pass.id))!.linkGeneration).toBe(generation + 4);
    // Restoring the original version must not revive a writer from the old generation.
    expect(await replace(original, newer.version, generation + 4)).toBe(true);
    expect(await replace(replacement, original.version, generation)).toBe(false);
    expect(await memberPhoto(kit.env.DB, pass.orgId, pass.id)).toEqual(original);
    const after = (await getPass(kit.env.DB, pass.id))!;
    expect(after.linkGeneration).toBe(generation + 5);
    expect(after.downloadToken).toBe(pass.downloadToken);
    await expect(assertPassSnapshot(kit.ctx, snapshot)).rejects.toMatchObject({ status: 404 });
  });

  it('allows only one concurrent photo CAS to change the row and generation', async () => {
    const pass = await kit.pass();
    await putMemberPhoto(
      jobCtxOf(kit),
      actor,
      pass.id,
      { png: encoded, includeInPass: false },
      null,
    );
    const original = (await memberPhoto(kit.env.DB, pass.orgId, pass.id))!;
    const before = (await getPass(kit.env.DB, pass.id))!;
    const imageGeneration = await capturePassImageGeneration(kit.env.DB, before, kit.clock.now());
    if (imageGeneration === null) throw new Error('Pass image snapshot is missing');
    const candidates = [
      { ...original, version: kit.ctx.ids.token(16), include_in_pass: 0 },
      { ...original, version: kit.ctx.ids.token(16), include_in_pass: 1 },
    ];
    const results = await Promise.all(
      candidates.map((next) =>
        replaceMemberPhoto(kit.env.DB, pass.orgId, pass.id, next, original.version, {
          pass: before,
          now: kit.clock.now(),
          imageGeneration,
        }),
      ),
    );
    expect(results.filter((result) => result.saved)).toHaveLength(1);
    expect(await memberPhoto(kit.env.DB, pass.orgId, pass.id)).toEqual(
      candidates[results.findIndex((result) => result.saved)],
    );
    const after = (await getPass(kit.env.DB, pass.id))!;
    expect(after.linkGeneration).toBe(before.linkGeneration + 1);
    expect(after.downloadToken).toBe(pass.downloadToken);
  });
});
