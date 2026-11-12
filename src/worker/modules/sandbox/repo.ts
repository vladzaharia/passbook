import { all, batch, first, run } from '../../platform/db.ts';
import { mapPass, type Pass, type PassDbRow } from '../passes/repo-map.ts';
import {
  walletNoProviderArtifactsSql,
  walletRetirementIntentStatements,
} from '../wallet-providers/repo-instance-retirement.ts';
import { providerRetirementCompleteSql } from '../wallet-providers/repo-sync-retention.ts';

export async function deleteCapturedBefore(
  db: D1Database,
  before: number,
  limit: number,
): Promise<number> {
  const { changes } = await run(
    db,
    `DELETE FROM captured_emails WHERE id IN (
       SELECT c.id FROM captured_emails c WHERE c.created_at < ?
         AND NOT EXISTS (
           SELECT 1 FROM sandbox_forwards f
           WHERE f.capture_id = c.id AND f.state IN ('sending', 'unknown')
         )
       ORDER BY c.created_at LIMIT ?)`,
    [before, limit],
  );
  return changes;
}

/** Test broadcasts past the cutoff that will not run again; scheduled and sending ones stay. */
export async function deleteTestBroadcastsBefore(
  db: D1Database,
  before: number,
  limit: number,
): Promise<number> {
  const { changes } = await run(
    db,
    `DELETE FROM broadcasts WHERE id IN (
       SELECT id FROM broadcasts WHERE mode = 'test' AND created_at < ?
         AND state NOT IN ('scheduled', 'sending') ORDER BY created_at LIMIT ?)`,
    [before, limit],
  );
  return changes;
}

const UNRESERVED_BUNDLE = `
  NOT EXISTS (
    SELECT 1 FROM sandbox_forwards f
    WHERE f.bundle_id = bundles.id AND f.state IN ('sending', 'unknown')
  )
  AND NOT EXISTS (
    SELECT 1 FROM bundle_passes bp
    JOIN sandbox_forward_passes fp ON fp.pass_id = bp.pass_id
    JOIN sandbox_forwards f ON f.id = fp.forward_id
    WHERE bp.bundle_id = bundles.id AND f.state IN ('sending', 'unknown')
  )
  AND NOT EXISTS (
    SELECT 1 FROM captured_emails c JOIN sandbox_forwards f ON f.capture_id = c.id
    WHERE c.bundle_id = bundles.id AND f.state IN ('sending', 'unknown')
  )`;

/** The oldest test bundles past the cutoff. */
export function expiredTestBundles(
  db: D1Database,
  before: number,
  limit: number,
): Promise<{ id: string }[]> {
  return all<{ id: string }>(
    db,
    `SELECT id FROM bundles WHERE mode = 'test' AND created_at < ?
       AND ${UNRESERVED_BUNDLE} ORDER BY created_at LIMIT ?`,
    [before, limit],
  );
}

export async function deleteBundlesByIds(db: D1Database, ids: string[]): Promise<number> {
  if (ids.length === 0) return 0;
  const { changes } = await run(
    db,
    `DELETE FROM bundles WHERE mode = 'test' AND id IN (${ids.map(() => '?').join(', ')})
       AND ${UNRESERVED_BUNDLE}`,
    ids,
  );
  return changes;
}

/** Forwarding and pending credential transfers keep a pass out of sandbox retention. */
const UNRESERVED_PASS = `NOT EXISTS (
    SELECT 1 FROM sandbox_forward_passes fp JOIN sandbox_forwards f ON f.id = fp.forward_id
    WHERE fp.pass_id = p.id AND f.state IN ('sending', 'unknown')
  ) AND NOT EXISTS (
    SELECT 1 FROM bundle_passes bp JOIN sandbox_forwards f ON f.bundle_id = bp.bundle_id
    WHERE bp.pass_id = p.id AND f.state IN ('sending', 'unknown')
  ) AND NOT EXISTS (
    SELECT 1 FROM captured_emails c JOIN sandbox_forwards f ON f.capture_id = c.id
    WHERE c.pass_id = p.id AND f.state IN ('sending', 'unknown')
  ) AND NOT EXISTS (
    SELECT 1 FROM pass_credential_transfers t WHERE t.pass_id = p.id AND t.state = 'pending'
  )`;

const SCOPED_PROVIDER_ACCOUNT = `EXISTS (
  SELECT 1 FROM wallet_provider_accounts a WHERE a.id = i.account_id
    AND a.org_id = i.org_id AND a.mode = i.mode AND a.provider = i.provider
)`;

const NEEDS_PROVIDER_RETIREMENT = `EXISTS (
  SELECT 1 FROM wallet_provider_instances i WHERE i.pass_id = p.id
    AND i.org_id = p.org_id AND i.mode = p.mode
    AND ((i.lifecycle IN ('blocked', 'ready') AND ${walletNoProviderArtifactsSql('i')})
      OR (i.lifecycle IN ('active', 'revoking', 'revoked')
        AND i.retirement_requested_at IS NULL AND ${SCOPED_PROVIDER_ACCOUNT}))
)`;
const PROVIDER_RETIREMENT_COMPLETE = providerRetirementCompleteSql('p.id');

export interface ExpiredTestPass extends Pass {
  lifecycleGeneration: number;
  credentialGeneration: number;
  providerRetirementNeeded: boolean;
  providerRetirementComplete: boolean;
}

/** The oldest test passes past the cutoff, served by passes_test_age. Removed ones included. */
export async function expiredTestPasses(
  db: D1Database,
  before: number,
  limit: number,
  options: { after?: { createdAt: number; id: string }; actionableOnly?: boolean } = {},
): Promise<ExpiredTestPass[]> {
  const rows = await all<
    PassDbRow & {
      lifecycle_generation: number;
      credential_generation: number;
      provider_retirement_needed: number;
      provider_retirement_complete: number;
    }
  >(
    db,
    `SELECT p.*, ${NEEDS_PROVIDER_RETIREMENT} AS provider_retirement_needed,
       ${PROVIDER_RETIREMENT_COMPLETE} AS provider_retirement_complete
     FROM passes p WHERE p.mode = 'test' AND p.created_at < ? AND ${UNRESERVED_PASS}
       AND (? = 0 OR ${NEEDS_PROVIDER_RETIREMENT} OR ${PROVIDER_RETIREMENT_COMPLETE})
       AND (? IS NULL OR p.created_at > ? OR (p.created_at = ? AND p.id > ?))
     ORDER BY p.created_at, p.id LIMIT ?`,
    [
      before,
      options.actionableOnly ? 1 : 0,
      options.after?.createdAt ?? null,
      options.after?.createdAt ?? null,
      options.after?.createdAt ?? null,
      options.after?.id ?? null,
      limit,
    ],
  );
  return rows.map((row) => ({
    ...mapPass(row),
    lifecycleGeneration: row.lifecycle_generation,
    credentialGeneration: row.credential_generation,
    providerRetirementNeeded: row.provider_retirement_needed === 1,
    providerRetirementComplete: row.provider_retirement_complete === 1,
  }));
}

/**
 * Commit retirement intent and dirty markers together, but only for this selected snapshot while
 * it is still an expired test pass and no forwarding reservation has appeared.
 */
export async function stageExpiredTestPassRetirement(
  db: D1Database,
  pass: ExpiredTestPass,
  before: number,
  now: number,
  credentialKeysetCommitment: string,
): Promise<void> {
  await batch(
    db,
    walletRetirementIntentStatements(
      db,
      {
        passId: pass.id,
        orgId: pass.orgId,
        mode: pass.mode,
        passVersion: pass.version,
        passRevision: pass.revision,
        passCredentialGeneration: pass.credentialGeneration,
        lifecycleGeneration: pass.lifecycleGeneration,
        issuingReleaseId: pass.releaseId,
        now,
        credentialKeysetCommitment,
      },
      {
        sql: `p.mode = 'test' AND p.created_at = ? AND p.created_at < ?
      AND p.identity_id = ? AND p.template_id = ? AND p.template_version = ?
      AND p.serial = ? AND p.auth_token = ? AND p.connection_id IS ? AND p.external_ref IS ?
      AND p.holder_email IS ? AND p.owner_user_id IS ?
      AND p.link_generation = ? AND p.download_token = ? AND p.object_key = ?
      AND p.status = ? AND p.removed_at IS ? AND p.deleted_at IS ?
      AND p.test_data_quarantined = ? AND ${UNRESERVED_PASS}`,
        params: [
          pass.createdAt,
          before,
          pass.identityId,
          pass.templateId,
          pass.templateVersion,
          pass.serial,
          pass.authToken,
          pass.connectionId,
          pass.externalRef,
          pass.holderEmail,
          pass.ownerUserId,
          pass.linkGeneration,
          pass.downloadToken,
          pass.objectKey,
          pass.status,
          pass.removedAt,
          pass.deletedAt,
          pass.testDataQuarantined ? 1 : 0,
        ],
      },
    ),
  );
}

/** The signed-in user's own verified address: the primary one when verified, else any. */
export async function verifiedEmailOf(db: D1Database, userId: string): Promise<string | null> {
  const row = await first<{ email: string }>(
    db,
    `SELECT e.email FROM users u JOIN user_emails e ON e.user_id = u.id
     WHERE u.id = ? AND u.status = 'active' AND e.verified_at IS NOT NULL
     ORDER BY (e.email = u.primary_email) DESC, e.verified_at LIMIT 1`,
    [userId],
  );
  return row?.email ?? null;
}
