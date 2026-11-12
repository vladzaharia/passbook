import type { WalletProvider } from '../../../shared/contracts/wallet-providers.ts';
import { all } from '../../platform/db.ts';
import type { TenantPassWrite } from '../passes/http.ts';
import type { Pass } from '../passes/repo.ts';
import { tenantPassAuthorityParams, tenantPassAuthoritySql } from '../passes/repo-authority.ts';
import { credentialRefKeysetSql } from '../passes/repo-credential-keyset.ts';
import { walletRetiredInstanceSettledSql } from './repo-instance-retirement.ts';

export interface WalletProviderStatusRow {
  provider: WalletProvider;
  lifecycle: string | null;
  operationVersion: number | null;
  operationKind: string | null;
  operationState: string | null;
  operationReason: string | null;
  priorRetirementPending: number;
}

type WalletProviderStatusQueryRow =
  | (WalletProviderStatusRow & { keysetMatches: 1 })
  | { keysetMatches: 0 };

/**
 * Read the status and keyset fence against the same pass and authority snapshot.
 * The diagnostic row becomes null only when an otherwise-authorized pass has a stale keyset;
 * an empty array still means the pass or authority snapshot no longer matches.
 */
export async function readWalletProviderStatus(
  db: D1Database,
  pass: Pass,
  authority: TenantPassWrite,
  now: number,
  credentialKeysetCommitment: string,
): Promise<WalletProviderStatusRow[] | null> {
  if (
    authority.orgId !== pass.orgId ||
    authority.mode !== pass.mode ||
    (authority.kind === 'session'
      ? authority.capability !== 'passes:read'
      : authority.scope !== 'passes:read')
  )
    return [];
  const rows = await all<WalletProviderStatusQueryRow>(
    db,
    `WITH authorized_pass AS (
      SELECT p.id, p.org_id, p.mode, p.credential_generation FROM passes p
      WHERE p.id = ? AND p.org_id = ? AND p.mode = ? AND p.deleted_at IS NULL
        AND p.test_data_quarantined = 0 AND p.credential_generation = ?
        AND p.version = ? AND p.revision = ? AND p.link_generation = ? AND p.lifecycle_generation = ?
        AND ${tenantPassAuthoritySql(authority, 'p')}
    ), keyset AS (SELECT ${credentialRefKeysetSql} AS matches)
    SELECT provider.provider AS provider,
      i.lifecycle, op.version AS operationVersion, op.kind AS operationKind,
      op.state AS operationState, op.reason_code AS operationReason,
      EXISTS (SELECT 1 FROM wallet_provider_instances previous
        WHERE previous.pass_id = p.id AND previous.org_id = p.org_id AND previous.mode = p.mode
          AND previous.provider = provider.provider AND previous.credential_generation < p.credential_generation
          AND NOT (${walletRetiredInstanceSettledSql('previous')})) AS priorRetirementPending,
      1 AS keysetMatches
    FROM authorized_pass p CROSS JOIN keyset
    CROSS JOIN (SELECT 'google' AS provider UNION ALL SELECT 'samsung') provider
    LEFT JOIN wallet_provider_instances i ON i.pass_id = p.id AND i.org_id = p.org_id
      AND i.mode = p.mode AND i.provider = provider.provider
      AND i.credential_generation = p.credential_generation
    LEFT JOIN wallet_provider_instance_operations op ON op.id = i.desired_operation_id
      AND op.instance_id = i.id AND op.version = i.desired_version
    WHERE keyset.matches = 1
    UNION ALL
    SELECT NULL AS provider, NULL, NULL, NULL, NULL, NULL, NULL, 0
    FROM authorized_pass CROSS JOIN keyset
    WHERE keyset.matches = 0
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
      credentialKeysetCommitment,
    ],
  );
  return rows.every(
    (row): row is WalletProviderStatusRow & { keysetMatches: 1 } => row.keysetMatches === 1,
  )
    ? rows
    : null;
}
