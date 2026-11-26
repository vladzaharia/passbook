// CAND-1 authority at the database, for Samsung: the version author may approve a platform candidate that has
// omissions and it releases, retires and tombstones; the platform reviewer may not approve one with omissions; and a
// person's own Samsung candidate still refuses its version author.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { withoutTrigger } from '../../../../test/helpers/triggers.ts';
import { groupOf } from '../../../passkit/wallets/fidelity.ts';
import { samsungCompiler } from '../../../passkit/wallets/samsung/index.ts';
import type { CompileResult, FidelityItem } from '../../../passkit/wallets/types.ts';
import { all, first, run } from '../../platform/db.ts';
import { ensureCredentialRefKeyset } from '../passes/credential-keyset.ts';
import { authorizeTemplateWrite } from '../templates/access.ts';
import { getVersion } from '../templates/repo.ts';
import { getLatestRelease } from '../templates/repo-releases.ts';
import { computeProjectionPins } from './projection-pins.ts';
import {
  approveProjectionCandidate,
  createProjectionCandidate,
  listProjectionCandidates,
  publishProjectionRelease,
} from './projection-service.ts';
import { runSystemProjection } from './projection-system.ts';
import { SYSTEM_REVIEWER, systemAuthority } from './projection-system-authority.ts';
import { enrolSamsung, samsungCard } from './projection-system-samsung-fixtures.ts';
import { installV2Env, jobCtx, LOGO, S, setup } from './projection-v2-test-fixtures.ts';
import { setWalletProvidersEnabledForTest } from './provider-policy.ts';
import { samsungRetirementProjectionSql } from './repo-instance-retirement-sql.ts';
import { getProjectionCandidate } from './repo-projection-store.ts';
import { writeProjectionApproval } from './repo-projection-write.ts';

installV2Env();
const undo: (() => void)[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const f of undo.splice(0).reverse()) f();
});

const holderLoss: FidelityItem = {
  capability: 'field.back',
  path: 'backFields.terms',
  support: 'omitted',
  message: 'The back of the pass is not carried.',
};
/** A compiler update that loses a holder item: the candidate has an omission and needs a person. */
function loud() {
  const { revision, compile } = samsungCompiler;
  samsungCompiler.revision = revision + 1;
  samsungCompiler.compile = (view, options): CompileResult => {
    const r = compile(view, options);
    return {
      ...r,
      items: [...r.items.filter((i) => ['look', 'absent'].includes(groupOf(i))), holderLoss],
    };
  };
  undo.push(() => {
    samsungCompiler.revision = revision;
    samsungCompiler.compile = compile;
  });
}

async function loudCandidate() {
  loud();
  const kit = await setup({}, { schema: 1, google: { images: { logo: LOGO } }, samsung: {} });
  const samsung = await enrolSamsung(kit);
  undo.push(setWalletProvidersEnabledForTest(true));
  samsungCard(samsung);
  await runSystemProjection(jobCtx(kit.ctx), {
    kind: 'wallet.projection_system',
    orgId: kit.orgId,
    mode: 'live',
    templateId: kit.templateId,
    sourceReleaseId: kit.sourceId,
    version: kit.version,
    provider: 'samsung',
  });
  const scope = { orgId: kit.orgId, mode: 'live' as const, provider: 'samsung' as const };
  const listed = (await listProjectionCandidates(kit.ctx, kit.author, kit.templateId, scope))
    .items[0];
  const candidate = listed ? await getProjectionCandidate(S.env.DB, listed.id) : null;
  if (!candidate) throw new Error('No Samsung candidate.');
  return { kit, scope, candidate };
}

describe('Samsung system candidate with omissions (CAND-1)', () => {
  it('refuses the platform reviewer, in the database', async () => {
    const { kit, candidate } = await loudCandidate();
    expect(candidate.projection).toMatchObject({
      approvedOmissions: ['field.back@backFields.terms'],
    });
    await expect(
      writeProjectionApproval(
        jobCtx(kit.ctx),
        {
          id: S.f.ids.id(),
          candidateId: candidate.id,
          candidateHash: candidate.candidateHash,
          reviewerId: SYSTEM_REVIEWER,
          kind: 'peer',
          createdAt: S.clock.now(),
        },
        candidate,
        systemAuthority('reviewer', kit.orgId, 'live'),
        { action: 'template.system_approve', detail: {} },
      ),
    ).rejects.toThrow();
    expect(
      await all(S.env.DB, 'SELECT 1 FROM template_approvals WHERE candidate_id = ?', [
        candidate.id,
      ]),
    ).toEqual([]);
  });

  it('lets the version author approve it, then releases, passes the retirement proof and tombstones', async () => {
    const { kit, scope, candidate } = await loudCandidate();
    const approval = await approveProjectionCandidate(
      kit.ctx,
      kit.author,
      kit.templateId,
      candidate.id,
      {
        ...scope,
        candidateHash: candidate.candidateHash,
      },
    );
    expect(approval).toMatchObject({ kind: 'peer', reviewerId: kit.author.userId });
    const release = await publishProjectionRelease(kit.ctx, kit.author, kit.templateId, {
      ...scope,
      candidateId: candidate.id,
      approvalId: approval.id,
      candidateHash: candidate.candidateHash,
      expectedGeneration: 0,
    });
    expect(release).toMatchObject({ generation: 1, createdBy: kit.author.userId });
    const db = S.env.DB;
    const proof = await first<{ ok: number }>(
      db,
      `WITH i AS (SELECT r.org_id, r.mode, c.provider_account_id AS account_id,
          r.id AS identity_projection_release_id, r.credential_keyset_commitment
        FROM template_releases r JOIN template_candidates c ON c.id = r.candidate_id WHERE r.id = ?)
       SELECT ${samsungRetirementProjectionSql('i')} AS ok FROM i`,
      [release.id],
    );
    expect(proof?.ok).toBe(1);
    // The reference-pin trigger needs a live fetch reference, which this kit has no pass for: it is lifted, so the
    // keyset trigger of 0230 and the release-evidence trigger decide.
    const commitment = await ensureCredentialRefKeyset(db, S.env);
    await withoutTrigger(db, 'wallet_samsung_tombstone_credential_pin', () =>
      run(
        db,
        `INSERT INTO wallet_samsung_tombstones
          (ref_hash, org_id, mode, account_id, account_revision, candidate_id, release_id,
           provider_identity_hash, retired_at, credential_keyset_commitment, credential_version_id)
         SELECT ?, c.org_id, c.mode, c.provider_account_id, c.provider_account_revision, c.id, r.id,
           c.provider_identity_hash, ?, ?,
           (SELECT s.current_version_id FROM wallet_credentials s WHERE s.id = a.credential_source_id)
         FROM template_releases r JOIN template_candidates c ON c.id = r.candidate_id
           JOIN wallet_provider_accounts a ON a.id = c.provider_account_id WHERE r.id = ?`,
        ['c'.repeat(64), S.clock.now(), commitment, release.id],
      ),
    );
    expect(
      await first(db, 'SELECT 1 FROM wallet_samsung_tombstones WHERE release_id = ?', [release.id]),
    ).not.toBeNull();
    expect(await getLatestRelease(db, { ...scope, templateId: kit.templateId })).toMatchObject({
      id: release.id,
    });
  });

  it('keeps the raw rule for a person-authored candidate: its version author is refused', async () => {
    const kit = await setup({}, { schema: 1, google: { images: { logo: LOGO } }, samsung: {} });
    await enrolSamsung(kit);
    const scope = { orgId: kit.orgId, mode: 'live' as const, provider: 'samsung' as const };
    const row = await getVersion(S.env.DB, kit.templateId, kit.version);
    if (!row) throw new Error('Version missing.');
    const { pins } = await computeProjectionPins(kit.ctx, 'samsung', row);
    // The reviewer writes the candidate; the version author (kit.author) approving it is the refused case.
    const candidate = await createProjectionCandidate(kit.ctx, kit.reviewer, kit.templateId, {
      ...scope,
      version: kit.version,
      sourceReleaseId: kit.sourceId,
      projection: { schema: 2, provider: 'samsung', approvedOmissions: pins.approvedOmissions },
    });
    const stored = await getProjectionCandidate(S.env.DB, candidate.id);
    if (!stored) throw new Error('No candidate.');
    const authority = await authorizeTemplateWrite(
      kit.ctx,
      kit.author,
      kit.orgId,
      'templates:review',
    );
    await expect(
      writeProjectionApproval(
        kit.ctx,
        {
          id: S.f.ids.id(),
          candidateId: stored.id,
          candidateHash: stored.candidateHash,
          reviewerId: kit.author.userId,
          kind: 'peer',
          createdAt: S.clock.now(),
        },
        stored,
        authority,
        { action: 'template.approve', detail: {} },
      ),
    ).rejects.toThrow();
    expect(
      await all(S.env.DB, 'SELECT 1 FROM template_approvals WHERE candidate_id = ?', [stored.id]),
    ).toEqual([]);
  });
});
