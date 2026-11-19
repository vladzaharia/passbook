import type { Mode } from '../../../shared/contracts/common.ts';
import type { WalletProviderScope } from '../../../shared/contracts/wallet-providers.ts';
import { all, first } from '../../platform/db.ts';

type Blob = number[] | Uint8Array | ArrayBuffer | null;

export interface SourceVersionRow {
  version_id: string;
  credential_id: string;
  version_identity: string;
  card_map: string;
  kek_version: number;
  iv: Blob;
  wrapped_dek: Blob;
  ciphertext: Blob;
  scope: 'platform' | 'org';
  credential_org_id: string | null;
  mode: Mode;
  provider: WalletProviderScope['provider'];
  credential_identity: string;
  revoked_at: number | null;
}

export interface EnrolmentRef {
  id: string;
  orgId: string;
  mode: Mode;
  provider: WalletProviderScope['provider'];
}

const COLUMNS = `v.id AS version_id, v.credential_id, v.identity_hash AS version_identity, v.card_map,
  v.kek_version, v.iv, v.wrapped_dek, v.ciphertext, c.scope, c.org_id AS credential_org_id, c.mode,
  c.provider, c.identity_hash AS credential_identity, c.revoked_at`;

/** The enrolment's own source pointer and identity, read by the org-scoped key. */
export function findEnrolmentSource(
  db: D1Database,
  a: EnrolmentRef,
): Promise<{ source_id: string | null; account_identity: string | null } | null> {
  return first(
    db,
    `SELECT credential_source_id AS source_id, identity_hash AS account_identity
    FROM wallet_provider_accounts WHERE id = ? AND org_id = ? AND mode = ? AND provider = ?`,
    [a.id, a.orgId, a.mode, a.provider],
  );
}

/** The current version of the enrolment's source: platform, or a credential of the enrolment's own org. */
export function findCurrentSourceVersion(
  db: D1Database,
  a: EnrolmentRef,
): Promise<SourceVersionRow | null> {
  return first(
    db,
    `SELECT ${COLUMNS} FROM wallet_provider_accounts a
    JOIN wallet_credentials c ON c.id = a.credential_source_id AND c.mode = a.mode
      AND c.provider = a.provider AND (c.scope = 'platform' OR c.org_id = a.org_id)
    JOIN wallet_credential_versions v ON v.id = c.current_version_id AND v.credential_id = c.id
    WHERE a.id = ? AND a.org_id = ? AND a.mode = ? AND a.provider = ?`,
    [a.id, a.orgId, a.mode, a.provider],
  );
}

/**
 * A pinned version, then (with `later`) the later versions of the same credential, oldest first. The
 * credential must be platform or the caller's own org: another org's version id resolves to nothing.
 */
export function findPinnedVersions(
  db: D1Database,
  a: EnrolmentRef,
  versionId: string,
  later: boolean,
): Promise<SourceVersionRow[]> {
  return all(
    db,
    `SELECT ${COLUMNS} FROM wallet_credential_versions pin
    JOIN wallet_credentials c ON c.id = pin.credential_id AND c.mode = ? AND c.provider = ?
      AND (c.scope = 'platform' OR c.org_id = ?)
    JOIN wallet_credential_versions v ON v.credential_id = c.id
      AND ${later ? 'v.rowid >= pin.rowid' : 'v.id = pin.id'}
    WHERE pin.id = ? ORDER BY v.rowid LIMIT 33`,
    [a.mode, a.provider, a.orgId, versionId],
  );
}

/** The pin an operation of this instance carries. */
export async function findOperationPin(
  db: D1Database,
  instanceId: string,
  by: { operationId: string } | { version: number },
): Promise<string | null> {
  const row = await first<{ pin: string | null }>(
    db,
    `SELECT credential_version_id AS pin FROM wallet_provider_instance_operations
    WHERE instance_id = ? AND ${'operationId' in by ? 'id = ?' : 'version = ?'}`,
    [instanceId, 'operationId' in by ? by.operationId : by.version],
  );
  return row?.pin ?? null;
}

/** Pin SQL for a row written for an enrolment: the current version of its source, NULL without one. */
export const sourcePinSql = (
  accountExpr: string,
) => `(SELECT sc.current_version_id FROM wallet_provider_accounts sa
  JOIN wallet_credentials sc ON sc.id = sa.credential_source_id WHERE sa.id = ${accountExpr})`;
