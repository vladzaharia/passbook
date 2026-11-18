import { afterEach, describe, expect, it } from 'vitest';
import type { ShippedAsset } from '../../../passkit/build-assets.ts';
import { all, first, run } from '../../platform/db.ts';
import { removeTemplate } from '../templates/mutations.ts';
import { artRequests, sizeShipped, type WalletArt } from './projection-art.ts';
import { purgeWalletArt } from './projection-art-purge.ts';
import { offersPaused, setPauseProbeForTest } from './projection-pause.ts';
import { pipelineAddsLoss } from './projection-pins.ts';
import {
  approveProjectionCandidate,
  getApprovedProjection,
  rollbackProjectionRelease,
} from './projection-service.ts';
import {
  addsSharingLoss,
  candidateOf,
  installV2Env,
  type Kit,
  lookup,
  pinsOf,
  proof,
  released,
  request,
  S,
  setup,
  updateCompiler,
} from './projection-v2-test-fixtures.ts';

installV2Env();

let restore: (() => void)[] = [];
afterEach(() => {
  for (const undo of restore.reverse()) undo();
  restore = [];
});
const patch = (...args: Parameters<typeof updateCompiler>) => {
  const undo = updateCompiler(...args);
  restore.push(undo);
  return undo;
};

/** A published release and what the offer paths see for it. */
async function published(kit: Kit, omissions?: string[]) {
  const candidate = await candidateOf(
    kit,
    request(omissions ?? (await pinsOf(kit)).approvedOmissions),
  );
  const release = await released(kit, candidate);
  const approved = await getApprovedProjection(kit.ctx, lookup(kit), await proof());
  if (!approved) throw new Error('Release is not current.');
  return { candidate, release, approved };
}
const memoRows = (candidateId: string) =>
  first<{ n: number }>(
    S.env.DB,
    'SELECT count(*) AS n FROM wallet_projection_pause_checks WHERE candidate_id = ?',
    [candidateId],
  );

describe('Q21: a pipeline change that loses something pauses new offers', () => {
  it('carries forward an unchanged report, pauses on a new omission, re-opens on re-approval', async () => {
    const kit = await setup();
    const { release, approved } = await published(kit);
    expect(await offersPaused(kit.ctx, approved)).toBe(false);

    // Same report under a new revision: the approval carries forward.
    let undo = patch(undefined, 1);
    expect(await offersPaused(kit.ctx, approved)).toBe(false);
    undo();

    undo = patch(addsSharingLoss, 2);
    // The release stays current for passes already on the wallet; only new offers wait.
    const current = await getApprovedProjection(kit.ctx, lookup(kit), await proof());
    expect(current?.release.id).toBe(release.id);
    expect(await offersPaused(kit.ctx, approved)).toBe(true);

    // Re-approval is a new candidate under the current pipeline.
    const next = await candidateOf(kit, request((await pinsOf(kit)).approvedOmissions));
    expect(next.projection).toMatchObject({ approvedOmissions: ['sharing'] });
    const second = await released(kit, next, 1);
    expect(second.generation).toBe(2);
    const reapproved = await getApprovedProjection(kit.ctx, lookup(kit), await proof());
    expect(reapproved?.release.id).toBe(second.id);
    if (!reapproved) throw new Error('unreachable');
    expect(await offersPaused(kit.ctx, reapproved)).toBe(false);
  });

  it('pauses when the compiled type changes or the target becomes blocked', async () => {
    const kit = await setup();
    const { approved } = await published(kit);
    patch((result) => ({ ...result, type: `${result.type}-other` }), 1);
    expect(await offersPaused(kit.ctx, approved)).toBe(true);
    patch(
      (result) => ({ ...result, blocked: { code: 'REQUIRED_ROLE_EMPTY', message: 'No title.' } }),
      2,
    );
    expect(await offersPaused(kit.ctx, approved)).toBe(true);
  });

  it('lets a pipeline that only removes omissions carry forward', async () => {
    const kit = await setup();
    const undo = updateCompiler(addsSharingLoss, 1);
    let approved: Awaited<ReturnType<typeof published>>['approved'];
    try {
      approved = (await published(kit)).approved;
      expect(approved.projection).toMatchObject({ approvedOmissions: ['sharing'] });
    } finally {
      undo();
    }
    patch(undefined, 2);
    expect(await offersPaused(kit.ctx, approved)).toBe(false);
  });

  it('computes once per (candidate, pipeline) and never on the read path', async () => {
    const kit = await setup();
    const { candidate, approved } = await published(kit);
    let calls = 0;
    restore.push(
      setPauseProbeForTest(async (ctx, pinned, version) => {
        calls += 1;
        return pipelineAddsLoss(ctx, pinned, version);
      }),
    );
    const undo = patch(addsSharingLoss, 1);
    // Reads of the release do not recompile.
    await getApprovedProjection(kit.ctx, lookup(kit), await proof());
    expect(calls).toBe(0);
    expect(await offersPaused(kit.ctx, approved)).toBe(true);
    expect(await offersPaused(kit.ctx, approved)).toBe(true);
    expect(calls).toBe(1);
    expect((await memoRows(candidate.id))?.n).toBe(1);
    // A different pipeline is a different memo row.
    undo();
    patch(undefined, 2);
    expect(await offersPaused(kit.ctx, approved)).toBe(false);
    expect(calls).toBe(2);
    expect((await memoRows(candidate.id))?.n).toBe(2);
  });

  it('treats a failed check as paused, logs it, and leaves the read path alone', async () => {
    const kit = await setup();
    const { candidate, approved } = await published(kit);
    restore.push(
      setPauseProbeForTest(async () => {
        throw new Error('compiler exploded');
      }),
    );
    patch(undefined, 1);
    const logged: { event: string; data: Record<string, unknown> }[] = [];
    const ctx = {
      ...kit.ctx,
      log: {
        ...kit.ctx.log,
        warn: (event: string, data: Record<string, unknown>) => logged.push({ event, data }),
      },
    } as typeof kit.ctx;
    expect(await offersPaused(ctx, approved)).toBe(true);
    expect(logged).toEqual([
      {
        event: 'wallet.offer_pause_check_failed',
        data: expect.objectContaining({ code: 'WALLET_OFFER_PAUSE_CHECK' }),
      },
    ]);
    // Not memoized: the next call tries again.
    expect((await memoRows(candidate.id))?.n).toBe(0);
    // The release itself is still readable for sync and scheduling.
    expect((await getApprovedProjection(kit.ctx, lookup(kit), await proof()))?.release.id).toBe(
      approved.release.id,
    );
  });

  it('refuses to approve a candidate whose pipeline moved', async () => {
    const kit = await setup();
    const candidate = await candidateOf(kit, request());
    patch(undefined, 1);
    await expect(
      approveProjectionCandidate(kit.ctx, kit.reviewer, kit.templateId, candidate.id, {
        ...kit.scope,
        candidateHash: candidate.candidateHash,
      }),
    ).rejects.toMatchObject({ code: 'WALLET_PROJECTION_CONFLICT' });
  });

  it('refuses a candidate that drops a real omission from the list', async () => {
    const kit = await setup();
    patch(addsSharingLoss, 1);
    expect((await pinsOf(kit)).approvedOmissions).toEqual(['sharing']);
    await expect(candidateOf(kit, request([]))).rejects.toMatchObject({
      code: 'WALLET_PROJECTION_CONFLICT',
    });
    // Naming an omission the report does not have is refused as well.
    await expect(candidateOf(kit, request(['sharing', 'nfc']))).rejects.toMatchObject({
      code: 'WALLET_PROJECTION_CONFLICT',
    });
    expect((await candidateOf(kit, request(['sharing']))).projection).toMatchObject({
      approvedOmissions: ['sharing'],
    });
  });
});

describe('rollback follows the Q21 rule, not exact pins', () => {
  it('restores an approval that still covers the current pipeline and refuses one that does not', async () => {
    const kit = await setup();
    const first = await published(kit);
    const undoLoss = patch(addsSharingLoss, 1);
    const withLoss = await candidateOf(kit, request(['sharing']));
    const head = await released(kit, withLoss, 1);
    expect(head.generation).toBe(2);
    const rollback = (expectedGeneration: number) =>
      rollbackProjectionRelease(kit.ctx, kit.author, kit.templateId, {
        ...kit.scope,
        releaseId: first.release.id,
        candidateHash: first.candidate.candidateHash,
        expectedGeneration,
        reason: 'Back to the first release.',
      });
    // The first release approved no omissions; the pipeline now has one.
    await expect(rollback(2)).rejects.toMatchObject({ code: 'WALLET_PROJECTION_CONFLICT' });
    undoLoss();
    restore.pop();

    // A newer pipeline with nothing lost: the pins differ, the approval still covers it.
    patch(undefined, 2);
    expect((await pinsOf(kit)).pipeline).not.toBe(
      (first.candidate.projection as { pipeline: string }).pipeline,
    );
    const restored = await rollback(2);
    expect(restored).toMatchObject({
      action: 'rollback',
      generation: 3,
      candidateId: first.candidate.id,
    });
  });
});

describe('art: derived at publication, recorded, purged with the template', () => {
  const rows = (sha: string) =>
    first<{ n: number }>(
      S.env.DB,
      'SELECT count(*) AS n FROM wallet_projection_art WHERE sha256 = ?',
      [sha],
    );

  it('records the hashes a publication wrote and removes an unshared copy with the template', async () => {
    // Other tests publish the same logo bytes: start from no rows so the counts are this test's.
    await run(S.env.DB, 'DELETE FROM wallet_projection_art');
    const kit = await setup();
    const { candidate } = await published(kit);
    const art = await all<{ sha256: string }>(
      S.env.DB,
      'SELECT sha256 FROM wallet_projection_art WHERE candidate_id = ?',
      [candidate.id],
    );
    expect(art).toHaveLength(1);
    const sha = (art[0] as { sha256: string }).sha256;
    expect(candidate.projection).toMatchObject({ schema: 2 });
    expect(await S.env.BUCKET.head(`wallet-art/${sha}`)).not.toBeNull();

    // The identical logo in another organization is the same object: it is shared.
    const other = await setup();
    await published(other);
    expect((await rows(sha))?.n).toBe(2);

    expect(await removeTemplate(kit.ctx, kit.author, kit.templateId)).toBe('deleted');
    expect((await rows(sha))?.n).toBe(1);
    expect(await S.env.BUCKET.head(`wallet-art/${sha}`)).not.toBeNull();

    expect(await purgeWalletArt(other.ctx, { orgId: other.orgId })).toBe(1);
    expect((await rows(sha))?.n).toBe(0);
    expect(await S.env.BUCKET.head(`wallet-art/${sha}`)).toBeNull();
  });
});

describe('art for a pass build that generates a file', () => {
  const generated: ShippedAsset = {
    name: 'strip@2x.png',
    source: 'stamps/3.png',
    width: 1000,
    height: 100,
  };
  const own: ShippedAsset = { name: 'logo.png', width: 400, height: 400 };
  const personal: ShippedAsset = { name: 'thumbnail.png', bytes: new Uint8Array(1) };
  const template = { manifest: {} } as Parameters<typeof artRequests>[0];

  it('sizes a generated file from the build, not from a template file of the same name', () => {
    const art: WalletArt = {
      urls: new Map(),
      sizes: new Map([
        ['strip@2x.png', { width: 1032, height: 300 }],
        ['logo.png', { width: 660, height: 660 }],
      ]),
      hashes: new Set(),
    };
    expect(sizeShipped([generated, own, personal], art)).toEqual([
      generated,
      { ...own, width: 660, height: 660 },
      personal,
    ]);
  });

  it('derives nothing for a generated or personal file', () => {
    expect(artRequests(template, 'google', [generated, own, personal])).toEqual([
      { target: 'google', slot: 'logo', asset: 'logo.png' },
    ]);
  });
});
