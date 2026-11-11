import { first, type SqlValue, stmt } from '../../platform/db.ts';
import { UnavailableError } from '../../platform/errors.ts';

/** Bind the commitment captured before generating credential refs in the final SQL statement. */
export const credentialRefKeysetSql =
  'EXISTS (SELECT 1 FROM credential_ref_keyset WHERE id = 1 AND commitment = ?)';

function unavailable(): UnavailableError {
  return new UnavailableError(
    'Credential references are unavailable.',
    'CREDENTIAL_REF_KEYSET_UNAVAILABLE',
  );
}

/** Optional predicates are trusted application SQL; their values must be bound parameters. */
export function credentialRefKeysetInitializeStmt(
  db: D1Database,
  commitment: string,
  guard?: { sql: string; params: readonly SqlValue[] },
): D1PreparedStatement {
  if (!/^[0-9a-f]{64}$/.test(commitment)) throw unavailable();
  // Keep blocker checks in sync with credential_ref_keyset_insert_guard. A guarded
  // initialization resolves the dynamic authority in a separate compound SELECT,
  // so its depth does not accumulate with the blocking-event view.
  return stmt(
    db,
    `${guard ? 'WITH keyset_proposal AS MATERIALIZED (SELECT ?/* scan-ephemeral-proof */ AS commitment)\n    ' : ''}INSERT INTO credential_ref_keyset (id, commitment)
    SELECT 1, ${guard ? 'keyset_proposal.commitment FROM keyset_proposal' : '?/* scan-ephemeral-proof */'} WHERE (
      NOT EXISTS (SELECT 1 FROM credential_ref_keyset)
      AND NOT EXISTS (SELECT 1 FROM pass_credential_tombstones)
      AND NOT EXISTS (SELECT 1 FROM scan_asset_grant_provenance)
      AND NOT EXISTS (SELECT 1 FROM connection_webhook_retention)
      AND NOT EXISTS (SELECT 1 FROM workflow_runs WHERE credential_keyset_commitment IS NOT NULL)
    ) AND (
      NOT EXISTS (SELECT 1 FROM connection_webhook_items
        WHERE claim_snapshot IS NOT NULL)
      AND NOT EXISTS (SELECT 1 FROM scan_retention_proofs)
      AND NOT EXISTS (SELECT 1 FROM scan_retention_event_transitions WHERE pass_ref IS NOT NULL)
      AND NOT EXISTS (SELECT 1 FROM scan_retention_delete_intents)
    ) AND (
      NOT EXISTS (SELECT 1 FROM scan_retained_gates)
      AND NOT EXISTS (SELECT 1 FROM credential_ref_keyset_blocking_events)
      AND NOT EXISTS (SELECT 1 FROM template_candidates
        WHERE provider IN ('google', 'samsung') OR credential_keyset_commitment IS NOT NULL)
      AND NOT EXISTS (SELECT 1 FROM template_approvals WHERE credential_keyset_commitment IS NOT NULL)
      AND NOT EXISTS (SELECT 1 FROM template_releases
        WHERE provider IN ('google', 'samsung') OR credential_keyset_commitment IS NOT NULL)
    ) AND (
      NOT EXISTS (SELECT 1 FROM wallet_provider_projection_evidence)
      AND NOT EXISTS (SELECT 1 FROM wallet_provider_projection_evidence_history)
      AND NOT EXISTS (SELECT 1 FROM wallet_provider_instances)
      AND NOT EXISTS (SELECT 1 FROM wallet_provider_instance_operations)
      AND NOT EXISTS (SELECT 1 FROM wallet_provider_offer_refs)
    ) AND (
      NOT EXISTS (SELECT 1 FROM wallet_google_callback_bindings)
      AND NOT EXISTS (SELECT 1 FROM wallet_samsung_fetch_refs)
      AND NOT EXISTS (SELECT 1 FROM wallet_samsung_tombstones)
      AND NOT EXISTS (SELECT 1 FROM wallet_google_callback_replays)
      AND NOT EXISTS (SELECT 1 FROM wallet_samsung_auth_replays)
    )${guard ? ` INTERSECT SELECT 1, keyset_proposal.commitment FROM keyset_proposal WHERE (${guard.sql})` : ''}`,
    [commitment, ...(guard?.params ?? [])],
  );
}

export async function initializeCredentialRefKeyset(
  db: D1Database,
  commitment: string,
): Promise<boolean> {
  const results = await db.batch<{ matches: number }>([
    credentialRefKeysetInitializeStmt(db, commitment),
    stmt(db, `SELECT 1 AS matches WHERE ${credentialRefKeysetSql}`, [commitment]),
  ]);
  return results[1]?.results[0]?.matches === 1;
}

export async function matchesCredentialRefKeyset(
  db: D1Database,
  commitment: string,
): Promise<boolean> {
  const match = await first<{ matches: number }>(
    db,
    `SELECT 1 AS matches WHERE ${credentialRefKeysetSql}`,
    [commitment],
  );
  return match?.matches === 1;
}
