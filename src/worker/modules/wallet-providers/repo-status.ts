import type { WalletProvider } from '../../../shared/contracts/wallet-providers.ts';
import { all } from '../../platform/db.ts';
import type { TenantPassWrite } from '../passes/http.ts';
import type { Pass } from '../passes/repo.ts';
import { tenantPassAuthorityParams, tenantPassAuthoritySql } from '../passes/repo-authority.ts';
import { walletRetiredInstanceSettledSql } from './repo-instance-retirement.ts';

export interface WalletProviderStatusRow {
  provider: WalletProvider;
  lifecycle: string | null;
  operationVersion: number | null;
  operationKind: string | null;
  operationState: string | null;
  operationReason: string | null;
  priorRetirementPending: number;
  /** The provider's own save and removal reports (callbacks), never proof of installation. */
  savedAt: number | null;
  removedAt: number | null;
  /** The instance's Google class review as stored: UNREAD before the first read, null with no class. */
  classReview: string | null;
}

/** An empty array means the pass or authority snapshot no longer matches. */
export async function readWalletProviderStatus(
  db: D1Database,
  pass: Pass,
  authority: TenantPassWrite,
  now: number,
): Promise<WalletProviderStatusRow[]> {
  if (
    authority.orgId !== pass.orgId ||
    authority.mode !== pass.mode ||
    (authority.kind === 'session'
      ? authority.capability !== 'passes:read'
      : authority.scope !== 'passes:read')
  )
    return [];
  return all<WalletProviderStatusRow>(
    db,
    `WITH authorized_pass AS (
      SELECT p.id, p.org_id, p.mode, p.credential_generation FROM passes p
      WHERE p.id = ? AND p.org_id = ? AND p.mode = ? AND p.deleted_at IS NULL
        AND p.test_data_quarantined = 0 AND p.credential_generation = ?
        AND p.version = ? AND p.revision = ? AND p.link_generation = ? AND p.lifecycle_generation = ?
        AND ${tenantPassAuthoritySql(authority, 'p')}
    )
    SELECT provider.provider AS provider,
      i.lifecycle, op.version AS operationVersion, op.kind AS operationKind,
      op.state AS operationState, op.reason_code AS operationReason,
      i.saved_at AS savedAt, i.holder_removed_at AS removedAt,
      (SELECT COALESCE(c.review_status, 'UNREAD') FROM wallet_google_callback_bindings gb
        JOIN wallet_google_classes c ON c.class_id_hash = gb.class_id_hash
        WHERE gb.instance_id = i.id) AS classReview,
      EXISTS (SELECT 1 FROM wallet_provider_instances previous
        WHERE previous.pass_id = p.id AND previous.org_id = p.org_id AND previous.mode = p.mode
          AND previous.provider = provider.provider AND previous.credential_generation < p.credential_generation
          AND NOT (${walletRetiredInstanceSettledSql('previous')})) AS priorRetirementPending
    FROM authorized_pass p
    CROSS JOIN (SELECT 'google' AS provider UNION ALL SELECT 'samsung') provider
    LEFT JOIN wallet_provider_instances i ON i.pass_id = p.id AND i.org_id = p.org_id
      AND i.mode = p.mode AND i.provider = provider.provider
      AND i.credential_generation = p.credential_generation
      AND i.channel_epoch = (SELECT MAX(slot.channel_epoch) FROM wallet_provider_instances slot
        WHERE slot.pass_id = i.pass_id AND slot.provider = i.provider
          AND slot.credential_generation = i.credential_generation)
    LEFT JOIN wallet_provider_instance_operations op ON op.id = i.desired_operation_id
      AND op.instance_id = i.id AND op.version = i.desired_version
    ORDER BY provider LIMIT 2`,
    [
      pass.id,
      pass.orgId,
      pass.mode,
      pass.credentialGeneration,
      pass.version,
      pass.revision,
      pass.linkGeneration,
      pass.lifecycleGeneration,
      ...tenantPassAuthorityParams(authority, now),
    ],
  );
}
