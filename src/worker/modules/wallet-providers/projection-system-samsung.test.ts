// CAND-1: the platform authors, approves and releases a Samsung candidate with no person, and the retirement proof
// accepts that release. The version author is a person here. The exemption of 0230 is what lets that person approve
// a system candidate with omissions (see projection-system-samsung-authority.test.ts).
import { afterEach, describe, expect, it, vi } from 'vitest';
import { all, first } from '../../platform/db.ts';
import { getLatestRelease } from '../templates/repo-releases.ts';
import { runSystemProjection } from './projection-system.ts';
import { SYSTEM_AUTHOR, SYSTEM_REVIEWER } from './projection-system-authority.ts';
import { enrolSamsung, samsungCard } from './projection-system-samsung-fixtures.ts';
import { installV2Env, jobCtx, LOGO, S, setup } from './projection-v2-test-fixtures.ts';
import { setWalletProvidersEnabledForTest } from './provider-policy.ts';
import { samsungRetirementProjectionSql } from './repo-instance-retirement-sql.ts';

installV2Env();
afterEach(() => vi.restoreAllMocks());

const PROOF_OBJECTS = [
  ['trigger', 'template_approvals_insert'],
  ['trigger', 'template_provider_approvals_insert'],
  ['trigger', 'template_provider_releases_insert'],
  ['trigger', 'wallet_samsung_tombstone_keyset_insert'],
  ['view', 'wallet_provider_retirement_complete_base'],
] as const;

const wallets = { schema: 1, google: { images: { logo: LOGO } }, samsung: {} };

async function systemRelease() {
  const kit = await setup({}, wallets);
  const samsung = await enrolSamsung(kit);
  const restore = setWalletProvidersEnabledForTest(true);
  samsungCard(samsung);
  try {
    await runSystemProjection(jobCtx(kit.ctx), {
      kind: 'wallet.projection_system',
      orgId: kit.orgId,
      mode: 'live',
      templateId: kit.templateId,
      sourceReleaseId: kit.sourceId,
      version: kit.version,
      provider: 'samsung',
    });
  } finally {
    restore();
  }
  const release = await getLatestRelease(S.env.DB, {
    templateId: kit.templateId,
    orgId: kit.orgId,
    mode: 'live',
    provider: 'samsung',
  });
  if (!release) throw new Error('No Samsung system release.');
  return { kit, release };
}

describe('Samsung system release (CAND-1)', () => {
  it('authors, approves and releases with no person, and audits each step', async () => {
    const { kit, release } = await systemRelease();
    expect(release).toMatchObject({ createdBy: SYSTEM_REVIEWER, generation: 1 });
    const candidate = await first<{ author_id: string; version_author_id: string | null }>(
      S.env.DB,
      'SELECT author_id, version_author_id FROM template_candidates WHERE id = ?',
      [release.candidateId],
    );
    expect(candidate?.author_id).toBe(SYSTEM_AUTHOR);
    expect(candidate?.version_author_id).toBe(kit.author.userId);
    const account = await first<{
      credential_id: string | null;
      credential_source_id: string | null;
    }>(
      S.env.DB,
      `SELECT a.credential_id, a.credential_source_id FROM template_candidates c
       JOIN wallet_provider_accounts a ON a.id = c.provider_account_id WHERE c.id = ?`,
      [release.candidateId],
    );
    // The enrolment model: a source and no legacy envelope.
    expect(account).toEqual({ credential_id: null, credential_source_id: expect.any(String) });
    const approvals = await all<{ reviewer_id: string; kind: string }>(
      S.env.DB,
      'SELECT reviewer_id, kind FROM template_approvals WHERE candidate_id = ?',
      [release.candidateId],
    );
    expect(approvals).toEqual([{ reviewer_id: SYSTEM_REVIEWER, kind: 'peer' }]);
    const actions = await all<{ action: string }>(
      S.env.DB,
      `SELECT action FROM audit_log WHERE org_id = ? AND action LIKE 'template.system_%' ORDER BY id`,
      [kit.orgId],
    );
    expect(actions.map((a) => a.action)).toEqual([
      'template.system_candidate',
      'template.system_approve',
      'template.system_release',
    ]);
  });

  it('passes the retirement proof', async () => {
    const { release } = await systemRelease();
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
  });

  it('keeps the system exemption in every recreated object, and the raw rule for the rest', async () => {
    await systemRelease();
    for (const [type, name] of PROOF_OBJECTS) {
      const row = await first<{ sql: string }>(
        S.env.DB,
        'SELECT sql FROM sqlite_master WHERE type = ? AND name = ?',
        [type, name],
      );
      expect(row?.sql, name).toContain("author_id = 'system:wallet-projection' AND");
      expect(row?.sql, name).toContain("provider IN ('google', 'samsung')");
      expect(row?.sql, name).not.toContain("provider = 'google')");
      expect(row?.sql, name).toMatch(/version_author_id != |!= (c|candidate)\.version_author_id/);
    }
  });
});
