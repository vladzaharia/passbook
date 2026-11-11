import { stmt } from '../../platform/db.ts';
import { credentialRefKeysetSql } from '../passes/repo-credential-keyset.ts';
import { packedPredicate } from './repo-action-authority.ts';
import { boundOutputPredicate, type OutputPredicate } from './repo-output-predicates.ts';
import type { ScanRow } from './repo-scans.ts';
import { scanSecretSlots } from './repo-secret-binds.ts';

/** Allow initialization before the credential keyset has been established. */
export function initialClaimCredentialPredicate(commitment: string): OutputPredicate {
  return {
    sql: `(NOT EXISTS (SELECT 1 FROM credential_ref_keyset) OR (${credentialRefKeysetSql}))`,
    params: [commitment],
  };
}

/** Validate the original packing contract, but defer packing until the consuming statement. */
export function claimPredicate(sql: string, params: OutputPredicate['params']): OutputPredicate {
  const packed = packedPredicate(sql, [...params]);
  return packed.sql === '0' ? packed : { sql, params };
}

/** Preserve the normal safety checks while avoiding a deep wrapper when direct binds fit. */
export function boundedClaimPredicate(predicate: OutputPredicate, reserved = 0): OutputPredicate {
  const packed = boundOutputPredicate(predicate);
  if (
    packed.sql === '0' ||
    predicate.params.length + reserved > 90 ||
    !scanSecretSlots(predicate.sql, predicate.params.length)
  )
    return packed;
  const encoder = new TextEncoder();
  if (encoder.encode(predicate.sql).byteLength > 90_000) return packed;
  for (const value of predicate.params) {
    const bytes =
      typeof value === 'string'
        ? encoder.encode(value).byteLength
        : value instanceof ArrayBuffer
          ? value.byteLength
          : value instanceof Uint8Array
            ? value.byteLength
            : 0;
    if (bytes > 1_900_000) return packed;
  }
  return predicate;
}

/** One bounded claim-authority read, with every labeled value kept in its own bind. */
export function claimOutputPredicateStmt(db: D1Database, predicate: OutputPredicate) {
  const bounded = boundedClaimPredicate(predicate);
  return stmt(
    db,
    `SELECT CASE WHEN (${bounded.sql}) THEN 1 ELSE 0 END AS authorized`,
    bounded.params,
  );
}

/** Bind the actor, CSRF and credential fences together for a claim. */
export function claimAuthorityPredicate(
  actor: OutputPredicate,
  csrf: OutputPredicate,
  credentials: OutputPredicate,
) {
  return claimPredicate(`(${actor.sql}) AND ((${csrf.sql}) AND (${credentials.sql}))`, [
    ...actor.params,
    ...csrf.params,
    ...credentials.params,
  ]);
}

/** Match the observed collision under the current actor and credential authority. */
export function observedClaimCollisionPredicate(
  guard: OutputPredicate,
  row: ScanRow,
  actorKey: string,
  idempotencyKey: string,
): OutputPredicate {
  return {
    sql: `(${guard.sql}) AND EXISTS (SELECT 1 FROM scans existing
          WHERE existing.id=?/* scan-ephemeral-scan-id */ AND existing.at=? AND existing.state=?
            AND existing.reason IS ? AND existing.actor_key=?/* scan-ephemeral-actor-key */
            AND existing.idempotency_key=?/* scan-ephemeral-idempotency-key */
            AND existing.request_hash=?/* scan-ephemeral-request-hash */)`,
    params: [
      ...guard.params,
      row.id,
      row.at,
      row.state,
      row.reason,
      actorKey,
      idempotencyKey,
      row.requestHash,
    ],
  };
}
