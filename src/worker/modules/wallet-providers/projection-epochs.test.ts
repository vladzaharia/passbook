// PE5e: projection candidates, approvals, releases and evidence follow the account authority_epoch, not
// its revision (0148). A key rotation under the same identity keeps them; an identity change voids them.
import { describe, expect, it } from 'vitest';
import { first, run } from '../../platform/db.ts';
import { configureWalletProviderAccount, revokeWalletProviderAccount } from './account-service.ts';
import { getApprovedProjection } from './projection-service.ts';
import {
  approveOf,
  candidateOf,
  installV2Env,
  type Kit,
  lookup,
  pinsOf,
  released,
  request,
  S,
  setup,
} from './projection-v2-test-fixtures.ts';
import { findAccount } from './repo-accounts.ts';
import { getProjectionCandidate } from './repo-projection-store.ts';

installV2Env();

const revisionOf = async (kit: Kit) => (await findAccount(S.env.DB, kit.scope))?.revision ?? -1;
const epochOf = async (kit: Kit) => (await findAccount(S.env.DB, kit.scope))?.authority_epoch ?? -1;
const rotate = async (kit: Kit) =>
  configureWalletProviderAccount(kit.ctx, kit.author, {
    ...kit.scope,
    expectedRevision: await revisionOf(kit),
    credentials: S.google,
  });
/** The service keeps the issuer immutable, so an identity change is a revoke and a new configure. */
const revoke = async (kit: Kit) =>
  revokeWalletProviderAccount(kit.ctx, kit.author, {
    ...kit.scope,
    expectedRevision: await revisionOf(kit),
  });

describe('projection approvals and the account epoch', () => {
  it('keeps an unapproved candidate, its approval and its release across a same-identity rotation', async () => {
    const kit = await setup();
    const candidate = await candidateOf(kit, request((await pinsOf(kit)).approvedOmissions));
    const stored = await getProjectionCandidate(S.env.DB, candidate.id);
    expect(stored?.accountEpoch).toBe(await epochOf(kit));
    const epoch = await epochOf(kit);
    const revision = await revisionOf(kit);

    await rotate(kit);
    expect(await revisionOf(kit), 'the rotation moved the revision').toBe(revision + 1);
    expect(await epochOf(kit), 'and not the epoch').toBe(epoch);

    // Approval and release both pass the 0148 triggers and the verified candidate read.
    const release = await released(kit, candidate);
    expect((await getApprovedProjection(kit.ctx, lookup(kit)))?.release.id).toBe(release.id);

    await rotate(kit);
    expect(
      (await getApprovedProjection(kit.ctx, lookup(kit)))?.release.id,
      'a later rotation keeps the release current',
    ).toBe(release.id);
  });

  it('voids a candidate and a release when the identity changes', async () => {
    const kit = await setup();
    const candidate = await candidateOf(kit, request((await pinsOf(kit)).approvedOmissions));
    const approval = await approveOf(kit, candidate);
    await revoke(kit);
    await rotate(kit);
    await expect(
      // The approval trigger now refuses a candidate captured under the old epoch.
      run(
        S.env.DB,
        `INSERT INTO template_approvals (id, candidate_id, candidate_hash, reviewer_id, created_at,
           credential_keyset_commitment)
         SELECT ?, c.id, c.candidate_hash, 'other-reviewer', 1, c.credential_keyset_commitment
         FROM template_candidates c WHERE c.id = ?`,
        [crypto.randomUUID(), candidate.id],
      ),
    ).rejects.toThrow();
    expect(approval.id).toBeTruthy();
    expect(await getApprovedProjection(kit.ctx, lookup(kit))).toBeNull();

    // A fresh candidate under the new identity works again.
    const next = await candidateOf(kit, request((await pinsOf(kit)).approvedOmissions));
    const release = await released(kit, next);
    expect((await getApprovedProjection(kit.ctx, lookup(kit)))?.release.id).toBe(release.id);

    await rotate(kit);
    expect((await getApprovedProjection(kit.ctx, lookup(kit)))?.release.id).toBe(release.id);
    await revoke(kit);
    expect(await getApprovedProjection(kit.ctx, lookup(kit)), 'a revoke voids it').toBeNull();
  });

  it('still refuses a reviewer who is the candidate author, in the trigger', async () => {
    const kit = await setup();
    const candidate = await candidateOf(kit, request((await pinsOf(kit)).approvedOmissions));
    const stored = await first<{ author_id: string }>(
      S.env.DB,
      'SELECT author_id FROM template_candidates WHERE id = ?',
      [candidate.id],
    );
    await expect(
      run(
        S.env.DB,
        `INSERT INTO template_approvals (id, candidate_id, candidate_hash, reviewer_id, created_at,
           credential_keyset_commitment)
         SELECT ?, c.id, c.candidate_hash, c.author_id, 1, c.credential_keyset_commitment
         FROM template_candidates c WHERE c.id = ?`,
        [crypto.randomUUID(), candidate.id],
      ),
    ).rejects.toThrow();
    expect(stored?.author_id).toBeTruthy();
  });
});

describe('0141 exemption scope', () => {
  it('limits the version-author exemption to Google in the approval and release triggers', async () => {
    for (const name of [
      'template_provider_approvals_insert',
      'template_approvals_insert',
      'template_provider_releases_insert',
    ]) {
      const row = await first<{ sql: string }>(
        S.env.DB,
        "SELECT sql FROM sqlite_master WHERE type = 'trigger' AND name = ?",
        [name],
      );
      expect(row?.sql, name).toContain(
        "c.author_id = 'system:wallet-projection' AND c.provider = 'google'",
      );
    }
  });
});

describe('wallet_provider_accounts no-replace', () => {
  it('refuses INSERT OR REPLACE of an account id and keeps its epoch', async () => {
    const kit = await setup();
    await revoke(kit);
    const before = await epochOf(kit);
    expect(before).toBeGreaterThan(1);
    await expect(
      run(
        S.env.DB,
        'INSERT OR REPLACE INTO wallet_provider_accounts SELECT * FROM wallet_provider_accounts WHERE id = ?',
        [(await findAccount(S.env.DB, kit.scope))?.id],
      ),
    ).rejects.toThrow(/provider account identity is immutable/);
    expect(await epochOf(kit)).toBe(before);
  });
});
