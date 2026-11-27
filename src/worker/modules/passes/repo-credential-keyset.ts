import { first, type SqlValue, stmt } from '../../platform/db.ts';
import { UnavailableError } from '../../platform/errors.ts';
import { RACE_KEYSET_INSERT } from '../../platform/race-tag.ts';

/** Bind the commitment captured before generating credential refs in the final SQL statement. */
export const credentialRefKeysetSql =
  'EXISTS (SELECT 1 FROM credential_ref_keyset WHERE id = 1 AND commitment = ?)';

/** The same check as a bindable predicate, for statements outside wallet-providers that must deny a foreign keyset themselves. */
export function credentialRefKeysetMatch(commitment: string): { sql: string; params: [string] } {
  return { sql: credentialRefKeysetSql, params: [commitment] };
}

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
    `${guard ? 'WITH keyset_proposal AS MATERIALIZED (SELECT ? AS commitment)\n    ' : ''}${RACE_KEYSET_INSERT} INSERT INTO credential_ref_keyset (id, commitment)
    SELECT 1, ${guard ? 'keyset_proposal.commitment FROM keyset_proposal' : '?'} WHERE (
      NOT EXISTS (SELECT 1 FROM credential_ref_keyset)
      AND NOT EXISTS (SELECT 1 FROM pass_credential_tombstones)
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
  return (await initializeKeysetWith(db, commitment, [])).ok;
}

/** Initialize (or match) the keyset and run `extra` statements in the same trip, after it. */
export async function initializeKeysetWith(
  db: D1Database,
  commitment: string,
  extra: D1PreparedStatement[],
): Promise<{ ok: boolean; extra: D1Result[] }> {
  const results = await db.batch<{ matches: number }>([
    credentialRefKeysetInitializeStmt(db, commitment),
    stmt(db, `SELECT 1 AS matches WHERE ${credentialRefKeysetSql}`, [commitment]),
    ...extra,
  ]);
  return { ok: results[1]?.results[0]?.matches === 1, extra: results.slice(2) };
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
