import { afterEach, describe, expect, it } from 'vitest';
import { makeUser } from '../../../../test/helpers/index.ts';
import { editFixedColumns, withoutTrigger } from '../../../../test/helpers/triggers.ts';
import { groupOf } from '../../../passkit/wallets/fidelity.ts';
import type { CompileResult, FidelityItem } from '../../../passkit/wallets/types.ts';
import type { SessionAuth } from '../../platform/auth.ts';
import { first } from '../../platform/db.ts';
import { sha256Hex } from '../../platform/ids.ts';
import { createSession, resolveSession } from '../auth/sessions.ts';
import { approveAppleRelease, grantKitMembership } from '../passes/apple-release-test-fixtures.ts';
import { setupKit } from '../passes/pass-test-fixtures.ts';
import {
  claimWalletOperation,
  newWalletClaimHandle,
  readWalletPassSnapshot,
  requestWalletRetirement,
} from './instance.ts';
import { makeProviderTestTemplate, setupWalletOfferKit } from './offers-test-fixtures.ts';
import { projectionPolicy } from './projection-contract.ts';
import { approveProjectionCandidate, publishProjectionRelease } from './projection-service.ts';
import { runSystemProjection } from './projection-system.ts';
import { SYSTEM_AUTHOR, SYSTEM_REVIEWER } from './projection-system-authority.ts';
import { jobCtx, updateCompiler } from './projection-v2-test-fixtures.ts';
import { queueWalletOperation } from './queue-test-fixtures.ts';
import { selectProjectionCandidates } from './repo-projection-store.ts';
import { seedHistoricalProviderInstance } from './runtime-historical-fixtures.ts';
import { walletJobCtx } from './wallet-job-ctx-test-fixtures.ts';

const holderLoss: FidelityItem = {
  capability: 'field.back',
  path: 'backFields.terms',
  support: 'omitted',
  message: 'The back of the pass is not carried.',
};
const quietOr = (extra: FidelityItem[]) => (result: CompileResult) => ({
  ...result,
  items: [...result.items.filter((i) => ['look', 'absent'].includes(groupOf(i))), ...extra],
});

let restore: (() => void) | null = null;
afterEach(() => {
  restore?.();
  restore = null;
});

/**
 * A system-authored Google release, then an instance on it, then a revoke: the revoke claim holds
 * the same reviewer independence the release did, so a version author who approved a system
 * candidate is not locked out of retiring its instances.
 */
describe('revoke claims on a system release', () => {
  it.each([
    ['published by a solo admin the version author', [holderLoss], 'admin'],
    ['published by the platform', [], 'platform'],
  ] as const)('claims a revoke after a system release %s', async (_name, loss, who) => {
    const kit = await setupKit({ template: makeProviderTestTemplate });
    kit.env.KEK_V1 = btoa(String.fromCharCode(...new Uint8Array(32).fill(7)));
    const db = kit.env.DB;
    restore = updateCompiler(quietOr([...loss]));
    // The fixture version has no author; the exemption only matters when it has one.
    const versionAuthor = (await makeUser(kit.fx)).id;
    await withoutTrigger(db, 'template_versions_immutable', () =>
      editFixedColumns(
        db,
        'template_versions',
        'UPDATE template_versions SET created_by = ? WHERE template_id = ? AND version = ?',
        [versionAuthor, kit.template.id, kit.template.version],
      ),
    );
    const apple = await approveAppleRelease(kit);
    const pass = await kit.pass({});
    const f = await setupWalletOfferKit({
      google: 'configured',
      samsung: 'absent',
      source: { kit, apple, pass, barcode: 'none' },
    });
    const scope = {
      orgId: kit.org.id,
      mode: 'live' as const,
      provider: 'google' as const,
      templateId: kit.template.id,
    };
    await runSystemProjection(jobCtx(kit.ctx), {
      kind: 'wallet.projection_system',
      orgId: scope.orgId,
      mode: 'live',
      templateId: scope.templateId,
      sourceReleaseId: f.apple.id,
      version: kit.template.version,
      provider: 'google',
    });
    const [candidate] = await selectProjectionCandidates(db, scope);
    if (!candidate) throw new Error('No system candidate');
    expect(candidate.authorId).toBe(SYSTEM_AUTHOR);

    let release = await first<{ id: string; created_by: string }>(
      db,
      `SELECT id, created_by FROM template_releases
       WHERE org_id = ? AND provider = 'google' AND candidate_id = ?`,
      [scope.orgId, candidate.id],
    );
    if (who === 'admin') {
      expect(release).toBeNull();
      // The Apple version's author is the only admin: their approval is allowed on a system candidate.
      const author = versionAuthor;
      expect(candidate.versionAuthorId).toBe(author);
      await grantKitMembership(kit, scope.orgId, author, ['org_admin']);
      const session = await createSession(kit.ctx, {
        userId: author,
        roles: ['user'],
        amr: 'oidc',
        ipPrefix: null,
        userAgent: null,
      });
      const resolved = await resolveSession(kit.env, kit.clock, session.cookieValue);
      if (!resolved) throw new Error('Session did not resolve');
      const auth: SessionAuth = { ...resolved, mode: 'live' };
      const common = { orgId: scope.orgId, mode: 'live' as const, provider: 'google' as const };
      const approval = await approveProjectionCandidate(
        kit.ctx,
        auth,
        scope.templateId,
        candidate.id,
        {
          ...common,
          candidateHash: candidate.candidateHash,
        },
      );
      expect(approval.reviewerId).toBe(author);
      const released = await publishProjectionRelease(kit.ctx, auth, scope.templateId, {
        ...common,
        candidateId: candidate.id,
        approvalId: approval.id,
        candidateHash: candidate.candidateHash,
        expectedGeneration: 0,
      });
      release = { id: released.id, created_by: author };
    } else {
      expect(release?.created_by).toBe(SYSTEM_REVIEWER);
    }
    if (!release) throw new Error('No release');

    const keyset = f.credentialKeysetCommitment;
    const snapshot = await readWalletPassSnapshot(db, {
      ...scope,
      passId: f.pass.id,
    });
    if (!snapshot?.issuingReleaseId) throw new Error('No issuing release');
    const policy = projectionPolicy('google');
    const proof = {
      orgId: scope.orgId,
      mode: 'live' as const,
      provider: 'google' as const,
      credentialKeysetCommitment: keyset,
      passId: f.pass.id,
      passVersion: snapshot.passVersion,
      passRevision: snapshot.passRevision,
      passCredentialGeneration: snapshot.credentialGeneration,
      lifecycleGeneration: snapshot.lifecycleGeneration,
      issuingReleaseId: snapshot.issuingReleaseId,
      projectionReleaseId: release.id,
      accountId: candidate.accountId,
      accountRevision: candidate.accountRevision,
      adapterRevision: policy.adapterRevision,
      policyRevision: policy.audiencePolicyRevision,
    };
    const now = kit.clock.now();
    const operationId = crypto.randomUUID();
    const instanceId = crypto.randomUUID();
    const issued = await seedHistoricalProviderInstance(db, {
      id: instanceId,
      operationId,
      passId: f.pass.id,
      orgId: scope.orgId,
      mode: 'live',
      provider: 'google',
      credentialGeneration: snapshot.credentialGeneration,
      credentialKeysetCommitment: keyset,
      accountId: candidate.accountId,
      releaseId: release.id,
      now,
      upsert: { requestHash: await sha256Hex(operationId), state: 'succeeded' },
    });
    if (!issued) throw new Error('No instance operation');
    const ref = {
      orgId: scope.orgId,
      mode: 'live' as const,
      provider: 'google' as const,
      instanceId,
    };
    expect(
      await requestWalletRetirement(db, { ...ref, version: issued.version, ...proof, now }),
    ).toBe(true);
    const revoke = await queueWalletOperation(walletJobCtx(db), {
      ...proof,
      instanceId,
      expectedVersion: issued.version,
      kind: 'revoke',
      requestKey: crypto.randomUUID(),
      newId: () => crypto.randomUUID(),
      now,
    });
    if (!revoke) throw new Error('Revoke not queued');
    expect(
      await claimWalletOperation(walletJobCtx(db), {
        ...ref,
        version: revoke.version,
        claimHandle: newWalletClaimHandle(),
        now,
      }),
    ).toBe('claimed');
  });
});
