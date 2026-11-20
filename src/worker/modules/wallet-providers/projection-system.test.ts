import { afterEach, describe, expect, it } from 'vitest';
import { groupOf } from '../../../passkit/wallets/fidelity.ts';
import type { CompileResult, FidelityItem } from '../../../passkit/wallets/types.ts';
import type { JobOf } from '../../jobs/types.ts';
import { all } from '../../platform/db.ts';
import { ConflictError } from '../../platform/errors.ts';
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
import { SYSTEM_AUTHOR, SYSTEM_REVIEWER, systemAuthority } from './projection-system-authority.ts';
import { queueSystemProjections } from './projection-system-queue.ts';
import {
  candidateOf,
  installV2Env,
  type Kit,
  lookup,
  pinsOf,
  proof,
  request,
  S,
  setup,
  updateCompiler,
} from './projection-v2-test-fixtures.ts';
import { getProjectionCandidate, insertProjectionApprovalStmt } from './repo-projection-store.ts';

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

describe('system-authored provider candidates (CW7b)', () => {
  it('publishes itself when only look and absent items remain, and audits each step', async () => {
    patch(quiet(lookLoss));
    const kit = await setup();
    await runSystemProjection(kit.ctx, jobOf(kit));

    const { items } = await candidates(kit);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ authorId: SYSTEM_AUTHOR });
    expect(items[0]?.projection).toMatchObject({ approvedOmissions: [] });
    expect(items[0]?.approvals.map((a) => a.reviewerId)).toEqual([SYSTEM_REVIEWER]);
    const active = await getApprovedProjection(kit.ctx, lookup(kit), await proof());
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
    await runSystemProjection(kit.ctx, jobOf(kit));
    await runSystemProjection(kit.ctx, jobOf(kit));
    expect((await candidates(kit)).items).toHaveLength(1);
  });

  it('waits for a human when a holder item is lost, and a solo admin can approve it', async () => {
    patch(loud);
    const kit = await setup();
    await runSystemProjection(kit.ctx, jobOf(kit));

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

  it('refuses the platform reviewer on a candidate that loses something, in the database', async () => {
    patch(loud);
    const kit = await setup();
    await runSystemProjection(kit.ctx, jobOf(kit));
    const listed = (await candidates(kit)).items[0];
    const candidate = listed ? await getProjectionCandidate(S.env.DB, listed.id) : null;
    if (!candidate) throw new Error('unreachable');
    const now = S.clock.now();
    const statement = insertProjectionApprovalStmt(
      S.env.DB,
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
      now,
      await proof(),
    );
    await expect(statement.run()).rejects.toThrow();
    expect((await candidates(kit)).items[0]?.approvals).toEqual([]);
  });

  it('does nothing for an org that is not active', async () => {
    patch(quiet(lookLoss));
    const kit = await setup();
    await S.env.DB.prepare("UPDATE orgs SET status = 'suspended' WHERE id = ?")
      .bind(kit.orgId)
      .run();
    await expect(runSystemProjection(kit.ctx, jobOf(kit))).rejects.toBeInstanceOf(ConflictError);
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
    const current = await getApprovedProjection(kit.ctx, lookup(kit), await proof());
    if (!current) throw new Error('No active release.');
    return current;
  };

  it('keeps offers open when a compiler update adds only a look item', async () => {
    patch(quiet(lookLoss));
    const kit = await setup();
    await runSystemProjection(kit.ctx, jobOf(kit));
    const release = await approved(kit);
    patch(add({ ...lookLoss, capability: 'colors.background', message: 'Background colour.' }));
    expect(await offersPaused(kit.ctx, release)).toBe(false);
  });

  it('pauses offers when a compiler update adds a holder item', async () => {
    patch(quiet(lookLoss));
    const kit = await setup();
    await runSystemProjection(kit.ctx, jobOf(kit));
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

  it('queues one job for Google only, since Samsung stays dark', async () => {
    const sent: unknown[] = [];
    await queueSystemProjections(
      ctxWith(async (messages) => void sent.push(...messages.map((m) => m.body))),
      release('apple', 'org1'),
    );
    expect(sent).toEqual([
      {
        kind: 'wallet.projection_system',
        orgId: 'org1',
        mode: 'live',
        templateId: 't1',
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
    await expect(
      queueSystemProjections(
        ctxWith(async () => {
          throw new Error('queue down');
        }),
        release('apple', 'org1'),
      ),
    ).resolves.toBeUndefined();
  });
});
