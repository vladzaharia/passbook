import { beforeAll, describe, expect, it, vi } from 'vitest';
import { run } from '../../platform/db.ts';
import { jobCtxOf } from '../delivery/delivery-test-fixtures.ts';
import { startCredentialTransfer } from '../passes/credential-transfer.ts';
import { putMemberPhoto } from '../passes/member-photo.ts';
import { memberPhoto } from '../passes/repo-member-photo.ts';
import { getPass } from '../passes/repo-read-pass.ts';
import { claimRemoval, getPassLifecycle, releaseRemoval } from '../passes/repo-remove.ts';
import { makePng } from '../templates/package/fixtures.ts';
import { assetActorFor, observeCancellation } from './asset-test-fixtures.ts';
import { assetGrantValid, mintAssetGrant } from './assets.ts';
import { candidateById } from './repo-lookup.ts';
import { type ScanKit, setupScanKit } from './test-kit.ts';

let kit: ScanKit;
let template: string;
beforeAll(async () => {
  kit = await setupScanKit();
  template = await kit.scanTemplate('Transfer asset lineage', {
    actions: [{ id: 'check_in', label: 'Check in', kind: 'check_in' }],
  });
});

async function fixture(withPhoto = false) {
  const scanner = await kit.scanner({ templateIds: [template] });
  const actor = await assetActorFor(kit, scanner);
  const pass = await kit.scanPass(template);
  if (withPhoto) {
    const png = makePng(270, 270);
    await putMemberPhoto(
      kit.ctx,
      { type: 'system', id: null },
      pass.id,
      {
        png: btoa(String.fromCharCode(...png)),
        includeInPass: false,
      },
      null,
    );
  }
  const candidate = await candidateById(kit.env.DB, kit.org.id, pass.id);
  if (!candidate || candidate.transferPending || candidate.pass.credentialGeneration < 1)
    throw new Error('Transfer-free pass fixture missing');
  const grant = await mintAssetGrant(
    kit.ctx,
    actor,
    candidate,
    candidate.connectionGeneration,
    candidate.activeTemplateVersion,
    undefined,
    withPhoto,
    'commit',
  );
  return { scanner, actor, pass, candidate, grant };
}

async function stagePending(passId: string) {
  const expected = await getPass(kit.env.DB, passId, null);
  if (!expected) throw new Error('Transfer source missing');
  const put = vi
    .spyOn(kit.env.BUCKET, 'put')
    .mockRejectedValueOnce(new Error('Storage unavailable'));
  try {
    const transfer = await startCredentialTransfer(
      jobCtxOf(kit),
      { type: 'system', id: null },
      passId,
      { holderEmail: 'next@example.test', ownerUserId: null },
      null,
      { kind: 'tenant-holder', expected },
    );
    expect(transfer.state).toBe('pending');
  } finally {
    put.mockRestore();
  }
}

/** Claim and roll back a removal without publishing a Wallet version. */
async function removalRollback(passId: string) {
  const pass = await getPass(kit.env.DB, passId, null);
  if (!pass) throw new Error('Pass fixture missing');
  const lifecycle = await getPassLifecycle(kit.env.DB, pass);
  if (!lifecycle) throw new Error('Lifecycle fixture missing');
  const state = { at: kit.clock.now(), message: null, priorStatus: pass.status };
  const generation = await claimRemoval(kit.ctx, passId, state, {
    pass,
    generation: lifecycle.generation,
    now: kit.clock.now(),
  });
  if (generation === null) throw new Error('Removal claim failed');
  await releaseRemoval(kit.env.DB, passId, { pass, state, generation });
}

describe('scanner asset credential lineage', () => {
  it('refuses a previously pending evaluation even after current state is clear', async () => {
    const { actor, candidate, grant } = await fixture();
    const pending = { ...candidate, transferPending: true };
    await expect(
      mintAssetGrant(
        kit.ctx,
        actor,
        pending,
        pending.connectionGeneration,
        pending.activeTemplateVersion,
        undefined,
        false,
        'commit',
      ),
    ).rejects.toMatchObject({ code: 'ASSET_NOT_FOUND' });
    expect(
      await assetGrantValid(
        kit.ctx,
        actor,
        pending,
        pending.connectionGeneration,
        grant,
        undefined,
        'commit',
        false,
      ),
    ).toBe(false);
  });

  it('rejects a missing or foreign credential keyset even with no submitted refs', async () => {
    const { actor, candidate, grant } = await fixture();
    expect(candidate.credentialTombstoneRefs).toEqual([]);
    for (const credentialKeysetCommitment of ['', '0'.repeat(64)]) {
      const stale = { ...candidate, credentialKeysetCommitment };
      expect(
        await assetGrantValid(
          kit.ctx,
          actor,
          stale,
          stale.connectionGeneration,
          grant,
          undefined,
          'commit',
          false,
        ),
      ).toBe(false);
      await expect(
        mintAssetGrant(
          kit.ctx,
          actor,
          stale,
          stale.connectionGeneration,
          stale.activeTemplateVersion,
          undefined,
          false,
          'commit',
        ),
      ).rejects.toMatchObject({ code: 'ASSET_NOT_FOUND' });
    }
  });

  it('rejects nonpositive or unsafe credential generations', async () => {
    const { actor, candidate, grant } = await fixture();
    for (const generation of [0, -1, Number.NaN, Number.MAX_SAFE_INTEGER + 1]) {
      const stale = { ...candidate, pass: { ...candidate.pass, credentialGeneration: generation } };
      expect(
        await assetGrantValid(
          kit.ctx,
          actor,
          stale,
          stale.connectionGeneration,
          grant,
          undefined,
          'commit',
          false,
        ),
      ).toBe(false);
    }
  });

  it('rejects negative or unsafe lifecycle generations', async () => {
    const { actor, candidate, grant } = await fixture();
    for (const generation of [-1, Number.NaN, Number.MAX_SAFE_INTEGER + 1]) {
      const stale = { ...candidate, pass: { ...candidate.pass, lifecycleGeneration: generation } };
      expect(
        await assetGrantValid(
          kit.ctx,
          actor,
          stale,
          stale.connectionGeneration,
          grant,
          undefined,
          'commit',
          false,
        ),
      ).toBe(false);
    }
  });

  it('masks assets while a credential transfer is pending', async () => {
    const { scanner, actor, pass, grant } = await fixture();
    await stagePending(pass.id);
    const current = await candidateById(kit.env.DB, kit.org.id, pass.id);
    if (!current) throw new Error('Pass fixture missing');
    expect(current.transferPending).toBe(true);
    expect(
      await assetGrantValid(
        kit.ctx,
        actor,
        current,
        current.connectionGeneration,
        grant,
        undefined,
        'commit',
        false,
      ),
    ).toBe(false);
    await expect(
      mintAssetGrant(
        kit.ctx,
        actor,
        current,
        current.connectionGeneration,
        current.activeTemplateVersion,
        undefined,
        false,
        'commit',
      ),
    ).rejects.toMatchObject({ code: 'ASSET_NOT_FOUND' });
    const response = await kit.get(
      scanner.headers,
      `/passes/${pass.id}/assets/icon.png?g=${grant}`,
    );
    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({ code: 'ASSET_NOT_FOUND' });
  });

  it('cancels an open member photo when a transfer becomes pending during R2 access', async () => {
    const { scanner, pass, grant } = await fixture(true);
    const photo = await memberPhoto(kit.env.DB, kit.org.id, pass.id);
    if (!photo) throw new Error('Photo fixture missing');
    const originalGet = kit.env.BUCKET.get.bind(kit.env.BUCKET);
    let opened = false;
    let cancelled = 0;
    const spy = vi.spyOn(kit.env.BUCKET, 'get').mockImplementation(async (key, options) => {
      const object = await originalGet(key, options);
      if (key !== photo.r2_key || !object) return object;
      opened = true;
      await stagePending(pass.id);
      return observeCancellation(object, () => cancelled++);
    });
    let response: Response;
    try {
      response = await kit.get(scanner.headers, `/passes/${pass.id}/assets/member.png?g=${grant}`);
    } finally {
      spy.mockRestore();
    }
    expect(opened).toBe(true);
    expect(cancelled).toBe(1);
    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({ code: 'ASSET_NOT_FOUND' });
  });

  it('does not revive a grant after same-tick removal and rollback', async () => {
    const { scanner, actor, pass, candidate, grant } = await fixture();
    await removalRollback(pass.id);
    const current = await candidateById(kit.env.DB, kit.org.id, pass.id);
    if (!current) throw new Error('Pass fixture missing');
    expect(current.pass.lifecycleGeneration).toBeGreaterThan(candidate.pass.lifecycleGeneration);
    expect(current.pass.credentialGeneration).toBe(candidate.pass.credentialGeneration);
    expect(
      await assetGrantValid(
        kit.ctx,
        actor,
        current,
        current.connectionGeneration,
        grant,
        undefined,
        'commit',
        false,
      ),
    ).toBe(false);
    const response = await kit.get(
      scanner.headers,
      `/passes/${pass.id}/assets/icon.png?g=${grant}`,
    );
    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({ code: 'ASSET_NOT_FOUND' });
  });

  it('cancels an open photo after removal and rollback during R2 access', async () => {
    const { scanner, pass, grant } = await fixture(true);
    const photo = await memberPhoto(kit.env.DB, kit.org.id, pass.id);
    if (!photo) throw new Error('Photo fixture missing');
    const originalGet = kit.env.BUCKET.get.bind(kit.env.BUCKET);
    let opened = false;
    let cancelled = 0;
    const spy = vi.spyOn(kit.env.BUCKET, 'get').mockImplementation(async (key, options) => {
      const object = await originalGet(key, options);
      if (key !== photo.r2_key || !object) return object;
      opened = true;
      await removalRollback(pass.id);
      return observeCancellation(object, () => cancelled++);
    });
    let response: Response;
    try {
      response = await kit.get(scanner.headers, `/passes/${pass.id}/assets/member.png?g=${grant}`);
    } finally {
      spy.mockRestore();
    }
    expect(opened).toBe(true);
    expect(cancelled).toBe(1);
    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({ code: 'ASSET_NOT_FOUND' });
  });

  it('rejects an unreserved credential generation and an invented evaluated generation', async () => {
    const { scanner, actor, pass, candidate, grant } = await fixture();
    const forged = {
      ...candidate,
      pass: { ...candidate.pass, credentialGeneration: candidate.pass.credentialGeneration + 1 },
    };
    expect(
      await assetGrantValid(
        kit.ctx,
        actor,
        forged,
        forged.connectionGeneration,
        grant,
        undefined,
        'commit',
        false,
      ),
    ).toBe(false);
    await expect(
      run(
        kit.env.DB,
        'UPDATE passes SET credential_generation = credential_generation + 1 WHERE id = ?',
        [pass.id],
      ),
    ).rejects.toThrow();
    const current = await candidateById(kit.env.DB, kit.org.id, pass.id);
    if (!current) throw new Error('Pass fixture missing');
    expect(current.pass.linkGeneration).toBe(candidate.pass.linkGeneration);
    expect(current.pass.credentialGeneration).toBe(candidate.pass.credentialGeneration);
    expect(
      await assetGrantValid(
        kit.ctx,
        actor,
        current,
        current.connectionGeneration,
        grant,
        undefined,
        'commit',
        false,
      ),
    ).toBe(true);
    const response = await kit.get(
      scanner.headers,
      `/passes/${pass.id}/assets/icon.png?g=${grant}`,
    );
    expect(response.status).toBe(200);
  });
});
