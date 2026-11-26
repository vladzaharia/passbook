import { afterEach, describe, expect, it } from 'vitest';
import { makeOrg } from '../../../../test/helpers/index.ts';
import { groupOf } from '../../../passkit/wallets/fidelity.ts';
import type { CompileResult, FidelityItem } from '../../../passkit/wallets/types.ts';
import type { JobOf } from '../../jobs/types.ts';
import { all, first, run } from '../../platform/db.ts';
import { createServiceContext } from '../../platform/service-context.ts';
import { getLatestRelease } from '../templates/repo-releases.ts';
import { offersPaused } from './projection-pause.ts';
import {
  approveProjectionCandidate,
  getApprovedProjection,
  listProjectionCandidates,
  publishProjectionRelease,
} from './projection-service.ts';
import { runSystemProjection } from './projection-system.ts';
import {
  SYSTEM_AUTHOR,
  SYSTEM_REVIEWER,
  systemAuthority,
  versionAuthorIndependentSql,
} from './projection-system-authority.ts';
import { queueSystemProjections } from './projection-system-queue.ts';
import {
  candidateOf,
  installV2Env,
  jobCtx,
  type Kit,
  lookup,
  member,
  pinsOf,
  request,
  S,
  setup,
  updateCompiler,
} from './projection-v2-test-fixtures.ts';
import { walletInstanceProofSql } from './repo-instance-proof.ts';
import {
  getProjectionRetirementMetadata,
  projectionReleaseBindingValid,
} from './repo-projection.ts';
import { getProjectionCandidate } from './repo-projection-store.ts';
import { writeProjectionApproval } from './repo-projection-write.ts';

installV2Env();

let restore: (() => void)[] = [];
afterEach(() => {
  for (const undo of restore.reverse()) undo();
  restore = [];
});
const patch = (change: (result: CompileResult) => CompileResult) => {
  restore.push(updateCompiler(change));
};

const lookLoss: FidelityItem = {
  capability: 'colors.label',
  path: '',
  support: 'omitted',
  message: 'Label colour is not carried.',
};
const holderLoss: FidelityItem = {
  capability: 'field.back',
  path: 'backFields.terms',
  support: 'omitted',
  message: 'The back of the pass is not carried.',
};
/** Only what a holder or the door would not notice: look and absent items. */
const quiet = (extra: FidelityItem) => (result: CompileResult) => ({
  ...result,
  items: [...result.items.filter((i) => ['look', 'absent'].includes(groupOf(i))), extra],
});
const loud = (result: CompileResult): CompileResult => quiet(holderLoss)(result);

const jobOf = (kit: Kit): JobOf<'wallet.projection_system'> => ({
  kind: 'wallet.projection_system',
  orgId: kit.orgId,
  mode: 'live',
  templateId: kit.templateId,
  sourceReleaseId: kit.sourceId,
  version: kit.version,
  provider: 'google',
});
const candidates = (kit: Kit) =>
  listProjectionCandidates(kit.ctx, kit.author, kit.templateId, kit.scope);
const audit = (kit: Kit) =>
  all<{ action: string; actor_type: string; actor_id: string }>(
    S.env.DB,
    `SELECT action, actor_type, actor_id FROM audit_log
     WHERE org_id = ? AND action LIKE 'template.system_%' ORDER BY id`,
    [kit.orgId],
  );

/** The runtime reads that offers and upserts rely on find the sole release valid. */
async function expectBound(kit: Kit, releaseId: string) {
  expect(
    await projectionReleaseBindingValid(S.env.DB, {
      releaseId,
      orgId: kit.orgId,
      mode: 'live',
      provider: 'google',
      templateId: kit.templateId,
      version: kit.version,
      sourceReleaseId: kit.sourceId,
      now: S.clock.now(),
    }),
  ).toBe(true);
  expect(await getProjectionRetirementMetadata(S.env.DB, releaseId)).not.toBeNull();
}

describe('system-authored provider candidates (CW7b)', () => {
  it('publishes itself when only look and absent items remain, and audits each step', async () => {
    patch(quiet(lookLoss));
    const kit = await setup();
    await runSystemProjection(jobCtx(kit.ctx), jobOf(kit));

    const { items } = await candidates(kit);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ authorId: SYSTEM_AUTHOR });
    expect(items[0]?.projection).toMatchObject({ approvedOmissions: [] });
    expect(items[0]?.approvals.map((a) => a.reviewerId)).toEqual([SYSTEM_REVIEWER]);
    const active = await getApprovedProjection(kit.ctx, lookup(kit));
    expect(active?.release).toMatchObject({ createdBy: SYSTEM_REVIEWER, generation: 1 });
    expect(await audit(kit)).toEqual([
      { action: 'template.system_candidate', actor_type: 'system', actor_id: SYSTEM_AUTHOR },
      { action: 'template.system_approve', actor_type: 'system', actor_id: SYSTEM_REVIEWER },
      { action: 'template.system_release', actor_type: 'system', actor_id: SYSTEM_REVIEWER },
    ]);
  });

  it('runs once per Apple release: a retried job adds nothing', async () => {
    patch(quiet(lookLoss));
    const kit = await setup();
    await runSystemProjection(jobCtx(kit.ctx), jobOf(kit));
    await runSystemProjection(jobCtx(kit.ctx), jobOf(kit));
    expect((await candidates(kit)).items).toHaveLength(1);
  });

  it('waits for a human when a holder item is lost, and a solo admin can approve it', async () => {
    patch(loud);
    const kit = await setup();
    await runSystemProjection(jobCtx(kit.ctx), jobOf(kit));

    const { items } = await candidates(kit);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ authorId: SYSTEM_AUTHOR, approvals: [] });
    expect(items[0]?.projection).toMatchObject({
      approvedOmissions: ['field.back@backFields.terms'],
    });
    expect(
      await getLatestRelease(S.env.DB, { ...kit.scope, templateId: kit.templateId }),
    ).toBeNull();
    expect((await audit(kit)).map((a) => a.action)).toEqual(['template.system_candidate']);

    // `kit.author` wrote the Apple version: a system candidate is not their own work.
    const candidate = items[0];
    if (!candidate) throw new Error('unreachable');
    const approval = await approveProjectionCandidate(
      kit.ctx,
      kit.author,
      kit.templateId,
      candidate.id,
      {
        ...kit.scope,
        candidateHash: candidate.candidateHash,
      },
    );
    const release = await publishProjectionRelease(kit.ctx, kit.author, kit.templateId, {
      ...kit.scope,
      candidateId: candidate.id,
      approvalId: approval.id,
      candidateHash: candidate.candidateHash,
      expectedGeneration: 0,
    });
    expect(release).toMatchObject({ generation: 1, createdBy: kit.author.userId });
  });

  it('keeps author and reviewer apart for a human candidate', async () => {
    const kit = await setup();
    const candidate = await candidateOf(kit, request());
    expect(candidate.authorId).toBe(kit.author.userId);
    const approve = (auth: Kit['author']) =>
      approveProjectionCandidate(kit.ctx, auth, kit.templateId, candidate.id, {
        ...kit.scope,
        candidateHash: candidate.candidateHash,
      });
    await expect(approve(kit.author)).rejects.toMatchObject({ code: 'TEMPLATE_SELF_APPROVAL' });
    const other = await candidateOf(
      { ...kit, author: kit.reviewer },
      request((await pinsOf(kit)).approvedOmissions),
    );
    // The reviewer wrote this candidate; the version's author may approve it, a human candidate's author may not.
    await expect(
      approveProjectionCandidate(kit.ctx, kit.reviewer, kit.templateId, other.id, {
        ...kit.scope,
        candidateHash: other.candidateHash,
      }),
    ).rejects.toMatchObject({ code: 'TEMPLATE_SELF_APPROVAL' });
  });

  it('lets the only reviewer approve and publish their own class once they confirm', async () => {
    const kit = await setup();
    const candidate = await candidateOf(kit, request());
    await run(
      S.env.DB,
      'UPDATE org_memberships SET revoked_at = ? WHERE org_id = ? AND user_id = ?',
      [S.clock.now(), kit.orgId, kit.reviewer.userId],
    );
    const approve = (alone?: boolean) =>
      approveProjectionCandidate(kit.ctx, kit.author, kit.templateId, candidate.id, {
        ...kit.scope,
        candidateHash: candidate.candidateHash,
        ...(alone === undefined ? {} : { alone }),
      });
    await expect(approve()).rejects.toMatchObject({ code: 'TEMPLATE_SELF_APPROVAL' });
    const approval = await approve(true);
    expect(approval).toMatchObject({ kind: 'sole', reviewerId: kit.author.userId });
    const release = await publishProjectionRelease(kit.ctx, kit.author, kit.templateId, {
      ...kit.scope,
      candidateId: candidate.id,
      approvalId: approval.id,
      candidateHash: candidate.candidateHash,
      expectedGeneration: 0,
    });
    expect(release).toMatchObject({ generation: 1, approvalId: approval.id });
    await expectBound(kit, release.id);
  });

  it('runs a one-member org from its sole Apple release to a sole wallet class release', async () => {
    const orgId = (await makeOrg(S.f)).id;
    const author = await member(orgId);
    const kit = await setup({}, undefined, { orgId, author, reviewer: author }, true);
    const candidate = await candidateOf(kit, request());
    const approval = await approveProjectionCandidate(
      kit.ctx,
      kit.author,
      kit.templateId,
      candidate.id,
      { ...kit.scope, candidateHash: candidate.candidateHash, alone: true },
    );
    expect(approval.kind).toBe('sole');
    const release = await publishProjectionRelease(kit.ctx, kit.author, kit.templateId, {
      ...kit.scope,
      candidateId: candidate.id,
      approvalId: approval.id,
      candidateHash: candidate.candidateHash,
      expectedGeneration: 0,
    });
    expect(release.generation).toBe(1);
    await expectBound(kit, release.id);
    expect(await getApprovedProjection(kit.ctx, lookup(kit))).not.toBeNull();
  });

  it('voids a sole class approval when a reviewer joins before release', async () => {
    const kit = await setup();
    const candidate = await candidateOf(kit, request());
    await run(
      S.env.DB,
      'UPDATE org_memberships SET revoked_at = ? WHERE org_id = ? AND user_id = ?',
      [S.clock.now(), kit.orgId, kit.reviewer.userId],
    );
    const approval = await approveProjectionCandidate(
      kit.ctx,
      kit.author,
      kit.templateId,
      candidate.id,
      { ...kit.scope, candidateHash: candidate.candidateHash, alone: true },
    );
    S.clock.advance(1000);
    await member(kit.orgId);
    await expect(
      publishProjectionRelease(kit.ctx, kit.author, kit.templateId, {
        ...kit.scope,
        candidateId: candidate.id,
        approvalId: approval.id,
        candidateHash: candidate.candidateHash,
        expectedGeneration: 0,
      }),
    ).rejects.toBeDefined();
    expect(
      await getLatestRelease(S.env.DB, { ...kit.scope, templateId: kit.templateId }),
    ).toBeNull();
  });

  it('refuses the platform reviewer on a candidate that loses something, in the database', async () => {
    patch(loud);
    const kit = await setup();
    await runSystemProjection(jobCtx(kit.ctx), jobOf(kit));
    const listed = (await candidates(kit)).items[0];
    const candidate = listed ? await getProjectionCandidate(S.env.DB, listed.id) : null;
    if (!candidate) throw new Error('unreachable');
    const now = S.clock.now();
    await expect(
      writeProjectionApproval(
        jobCtx(kit.ctx),
        {
          id: S.f.ids.id(),
          candidateId: candidate.id,
          candidateHash: candidate.candidateHash,
          reviewerId: SYSTEM_REVIEWER,
          kind: 'peer',
          createdAt: now,
        },
        candidate,
        systemAuthority('reviewer', kit.orgId, 'live'),
        { action: 'template.system_approve', detail: {} },
      ),
    ).rejects.toThrow();
    expect((await candidates(kit)).items[0]?.approvals).toEqual([]);
  });

  it('does nothing for an org that is not active', async () => {
    patch(quiet(lookLoss));
    const kit = await setup();
    await S.env.DB.prepare("UPDATE orgs SET status = 'suspended' WHERE id = ?")
      .bind(kit.orgId)
      .run();
    // The grant refuses a suspended org; the job skips it instead of failing into the queue's retries.
    await expect(runSystemProjection(jobCtx(kit.ctx), jobOf(kit))).resolves.toBeUndefined();
    const rows = await all(
      S.env.DB,
      'SELECT id FROM template_candidates WHERE org_id = ? AND provider = ?',
      [kit.orgId, 'google'],
    );
    expect(rows).toEqual([]);
  });
});

describe('Q21 after a system release', () => {
  const add = (item: FidelityItem) => (result: CompileResult) => ({
    ...result,
    items: [...result.items, item],
  });
  const approved = async (kit: Kit) => {
    const current = await getApprovedProjection(kit.ctx, lookup(kit));
    if (!current) throw new Error('No active release.');
    return current;
  };

  it('keeps offers open when a compiler update adds only a look item', async () => {
    patch(quiet(lookLoss));
    const kit = await setup();
    await runSystemProjection(jobCtx(kit.ctx), jobOf(kit));
    const release = await approved(kit);
    patch(add({ ...lookLoss, capability: 'colors.background', message: 'Background colour.' }));
    expect(await offersPaused(kit.ctx, release)).toBe(false);
  });

  it('pauses offers when a compiler update adds a holder item', async () => {
    patch(quiet(lookLoss));
    const kit = await setup();
    await runSystemProjection(jobCtx(kit.ctx), jobOf(kit));
    const release = await approved(kit);
    patch(add(holderLoss));
    expect(await offersPaused(kit.ctx, release)).toBe(true);
  });
});

describe('the Apple release hook', () => {
  const release = (provider: 'apple' | 'google', orgId: string | null) =>
    ({ id: 'r1', templateId: 't1', orgId, mode: 'live', provider, version: 'v1' }) as never;
  const ctxWith = (sendBatch: (messages: { body: unknown }[]) => Promise<void>) =>
    createServiceContext({ ...S.env, JOBS: { sendBatch } } as never, { clock: S.clock });

  it('queues one job for Google only, and only for an org with an account', async () => {
    const kit = await setup();
    const sent: unknown[] = [];
    const ctx = ctxWith(async (messages) => void sent.push(...messages.map((m) => m.body)));
    await queueSystemProjections(ctx, release('apple', 'org-without-account'));
    expect(sent).toEqual([]);
    await queueSystemProjections(ctx, {
      id: 'r1',
      templateId: kit.templateId,
      orgId: kit.orgId,
      mode: 'live',
      provider: 'apple',
      version: 'v1',
    } as never);
    expect(sent).toEqual([
      {
        kind: 'wallet.projection_system',
        orgId: kit.orgId,
        mode: 'live',
        templateId: kit.templateId,
        sourceReleaseId: 'r1',
        version: 'v1',
        provider: 'google',
      },
    ]);
  });

  it('ignores provider and platform releases, and a failed enqueue does not fail the release', async () => {
    const sent: unknown[] = [];
    const ctx = ctxWith(async (messages) => void sent.push(...messages));
    await queueSystemProjections(ctx, release('google', 'org1'));
    await queueSystemProjections(ctx, release('apple', null));
    expect(sent).toEqual([]);
    const kit = await setup();
    await expect(
      queueSystemProjections(
        ctxWith(async () => {
          throw new Error('queue down');
        }),
        release('apple', kit.orgId),
      ),
    ).resolves.toBeUndefined();
  });
});

describe('resuming and edge cases of the system job', () => {
  const nfcLoss: FidelityItem = {
    capability: 'nfc',
    path: '',
    support: 'unsupported',
    message: 'No NFC here.',
  };
  const count = async (kit: Kit, table: string) =>
    (
      await all(
        S.env.DB,
        `SELECT 1 FROM ${table} t WHERE ${table === 'template_approvals' ? "candidate_id IN (SELECT id FROM template_candidates WHERE org_id = ? AND provider = 'google')" : "org_id = ? AND provider = 'google'"}`,
        [kit.orgId],
      )
    ).length;

  it('a lost NFC counts as a door loss: it waits for a human', async () => {
    patch((r) => ({ ...quiet(lookLoss)(r), items: [...quiet(lookLoss)(r).items, nfcLoss] }));
    const kit = await setup();
    await runSystemProjection(jobCtx(kit.ctx), jobOf(kit));
    const [candidate] = (await candidates(kit)).items;
    expect(candidate?.projection).toMatchObject({ approvedOmissions: ['nfc'] });
    expect(candidate?.approvals).toEqual([]);
  });

  it.each([3, 4])(
    'retries after a failure at compile %i without repeating a step',
    async (failAt) => {
      let calls = 0;
      patch((r) => {
        calls += 1;
        if (calls === failAt) throw new Error('boom');
        return quiet(lookLoss)(r);
      });
      const kit = await setup();
      calls = 0;
      await expect(runSystemProjection(jobCtx(kit.ctx), jobOf(kit))).rejects.toThrow('boom');
      await runSystemProjection(jobCtx(kit.ctx), jobOf(kit));
      expect({
        candidates: await count(kit, 'template_candidates'),
        approvals: await count(kit, 'template_approvals'),
        releases: await count(kit, 'template_releases'),
      }).toEqual({ candidates: 1, approvals: 1, releases: 1 });
      const active = await getApprovedProjection(kit.ctx, lookup(kit));
      expect(active?.release.createdBy).toBe(SYSTEM_REVIEWER);
    },
  );

  it('the revoke proof exempts the version author from a system candidate only', async () => {
    const row = (author: string, provider = 'google') =>
      first<{ ok: number }>(
        S.env.DB,
        `SELECT ${versionAuthorIndependentSql('c', 'r.id')} AS ok
         FROM (SELECT 'u1' AS version_author_id, ? AS author_id, ? AS provider) c, (SELECT 'u1' AS id) r`,
        [author, provider],
      );
    expect((await row(SYSTEM_AUTHOR))?.ok).toBe(1);
    expect((await row('u2'))?.ok).toBe(0);
    expect((await row(SYSTEM_AUTHOR, 'samsung'))?.ok).toBe(1);
    expect((await row('u2', 'samsung'))?.ok).toBe(0);
    expect(walletInstanceProofSql('i', 'o', '1', false, 'revoke')).toContain(
      `author_id = '${SYSTEM_AUTHOR}'`,
    );
  });
});
