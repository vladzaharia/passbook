// CAND-1: the platform authors, approves and releases a Samsung candidate, and the retirement and tombstone
// proofs accept that release as they accept a human one (0229). The version author is a person here, so the
// exemption is exercised: without it the approval and the proofs would refuse the system candidate.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createFixtureIdentity } from '../../../passkit/testing/fixture-identity.ts';
import type { SamsungWalletCredentials } from '../../../shared/contracts/wallet-providers.ts';
import { all, first, run } from '../../platform/db.ts';
import { ensureCredentialRefKeyset } from '../passes/credential-keyset.ts';
import { getLatestRelease } from '../templates/repo-releases.ts';
import { configureWalletProviderAccount } from './account-service.ts';
import { runSystemProjection } from './projection-system.ts';
import { SYSTEM_AUTHOR, SYSTEM_REVIEWER } from './projection-system-authority.ts';
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
  const identity = await createFixtureIdentity(undefined, { now: new Date(S.clock.now()) });
  const samsung: SamsungWalletCredentials = {
    partnerId: 'partner',
    certificateId: 'ABCD',
    cardId: 'membership',
    partnerPrivateKeyPem: identity.privateKey,
    partnerCertificatePem: identity.certificate,
    samsungCertificatePem: identity.certificate,
  };
  await configureWalletProviderAccount(kit.ctx, kit.author, {
    orgId: kit.orgId,
    mode: 'live',
    provider: 'samsung',
    expectedRevision: 0,
    credentials: samsung,
  });
  const restore = setWalletProvidersEnabledForTest(true);
  // The card read that a Samsung release needs: a launched loyalty card.
  vi.spyOn(globalThis, 'fetch').mockImplementation(async () =>
    Response.json({
      resultCode: '0',
      template: {
        cardId: samsung.cardId,
        state: 'ACTIVE',
        testingModeOff: 'Y',
        cardType: 'loyalty',
        subType: 'others',
        countryCode: 'GB',
      },
    }),
  );
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

  it('passes the retirement proof and the tombstone trigger', async () => {
    const { release } = await systemRelease();
    const db = S.env.DB;
    const commitment = await ensureCredentialRefKeyset(db, S.env);
    const proof = await first<{ ok: number }>(
      db,
      `WITH i AS (SELECT r.org_id, r.mode, c.provider_account_id AS account_id,
          r.id AS identity_projection_release_id, r.credential_keyset_commitment
        FROM template_releases r JOIN template_candidates c ON c.id = r.candidate_id WHERE r.id = ?)
       SELECT ${samsungRetirementProjectionSql('i')} AS ok FROM i`,
      [release.id],
    );
    expect(proof?.ok).toBe(1);
    await run(
      db,
      `INSERT INTO wallet_samsung_tombstones
        (ref_hash, org_id, mode, account_id, account_revision, candidate_id, release_id,
         provider_identity_hash, retired_at, credential_keyset_commitment)
       SELECT ?, c.org_id, c.mode, c.provider_account_id, c.provider_account_revision, c.id, r.id,
         c.provider_identity_hash, ?, ?
       FROM template_releases r JOIN template_candidates c ON c.id = r.candidate_id WHERE r.id = ?`,
      ['a'.repeat(64), S.clock.now(), commitment, release.id],
    );
    expect(
      await first(db, 'SELECT 1 FROM wallet_samsung_tombstones WHERE release_id = ?', [release.id]),
    ).not.toBeNull();
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
