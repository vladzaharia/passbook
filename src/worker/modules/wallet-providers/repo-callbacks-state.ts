import type { Envelope } from '../../platform/crypto.ts';
import { all, batch, first, type SqlValue, stmt } from '../../platform/db.ts';
import { type InstancePass, instancePass } from './repo-callbacks-identity.ts';
import { samsungHolderEventStmt } from './repo-holder-events.ts';
import { pinnedKeysetSql } from './repo-keyset-pin.ts';

export type SamsungCardEvent = 'ADDED' | 'DELETED' | 'UPDATED' | 'PROVISIONED';

export interface SamsungReplayClaim {
  tokenHash: string;
  claimId: string;
  expiresAt: number;
  now: number;
}

export function validClaim(c: SamsungReplayClaim): boolean {
  return (
    /^[A-Za-z0-9_-]{43}$/.test(c.tokenHash) &&
    !!c.claimId &&
    Number.isSafeInteger(c.now) &&
    Number.isSafeInteger(c.expiresAt) &&
    c.expiresAt > c.now
  );
}

export interface SamsungReceipt {
  id: string;
  signedAt: number;
  envelope: Envelope;
  /** From the query, which the token does not sign unless `queryBound`: a routing hint until ADDED. */
  countryHint: string | null;
  event: SamsungCardEvent | null;
  /** The validated `x-request-id`; a trace id that is also part of the delivery key. */
  requestId: string;
  /** True only when the token's signature covered the query that carried the hint. */
  queryBound: boolean;
}

/** A ref and the instance it belongs to: all a receipt's effects need to name. */
export interface SamsungStateRef {
  referenceId: string;
  instanceId: string;
}

/** A token already recorded for this ref: the same delivery again, whatever its request id. */
export async function samsungTokenRecorded(
  db: D1Database,
  tokenHash: string,
  referenceId: string,
): Promise<boolean> {
  const row = await first(
    db,
    'SELECT 1 FROM wallet_samsung_callback_receipts WHERE token_hash = ? AND ref_id = ?',
    [tokenHash, referenceId],
  );
  return row !== null;
}

export const stateJoins = `FROM wallet_samsung_fetch_refs r
  JOIN wallet_provider_instances i ON i.id = r.instance_id
  JOIN wallet_provider_instance_operations op ON op.id = i.desired_operation_id
    AND op.instance_id = i.id AND op.version = i.desired_version
  JOIN passes p ON p.id = i.pass_id CROSS JOIN (SELECT ? AS now) clock`;

/**
 * The effect of a receipt, applied in the receipt's own batch and only if it was inserted (so the
 * fences of the receipt held): ADDED promotes the ref once, keeps its market and marks the
 * instance saved; DELETED records the holder's removal. Nothing here erases or revokes.
 * `requireServed` is for a ref outside its live fences: only one that served card data may be
 * promoted then.
 */
function effectStatements(
  db: D1Database,
  ref: SamsungStateRef,
  claim: SamsungReplayClaim,
  receipt: SamsungReceipt,
  requireServed: boolean,
  pass: InstancePass | null,
): D1PreparedStatement[] {
  const inserted = `EXISTS (SELECT 1 FROM wallet_samsung_callback_receipts rc
    WHERE rc.id = ? AND rc.event = ?)`;
  // A retired ref belongs to a previous holder or generation: its callbacks are recorded, never applied.
  const live = `EXISTS (SELECT 1 FROM wallet_samsung_fetch_refs live WHERE live.id = ? AND live.retired_at IS NULL)`;
  const reported = (event: 'saved' | 'removed') =>
    pass ? [samsungHolderEventStmt(db, pass, ref.referenceId, receipt.id, event, claim.now)] : [];
  if (receipt.event === 'DELETED')
    return [
      ...reported('removed'),
      stmt(
        db,
        `UPDATE wallet_provider_instances SET holder_removed_at = MAX(COALESCE(holder_removed_at, 0), ?)
        WHERE id = ? AND ${inserted} AND ${live}`,
        [claim.now, ref.instanceId, receipt.id, 'DELETED', ref.referenceId],
      ),
    ];
  if (receipt.event !== 'ADDED') return [];
  const statements = [
    ...reported('saved'),
    stmt(
      db,
      `UPDATE wallet_provider_instances SET saved_at = MAX(COALESCE(saved_at, 0), ?)
      WHERE id = ? AND ${inserted} AND ${live}`,
      [claim.now, ref.instanceId, receipt.id, 'ADDED', ref.referenceId],
    ),
  ];
  // The market is the ADDED event's own cc2, never a hint from an earlier or other callback.
  if (receipt.countryHint)
    statements.unshift(
      stmt(
        db,
        `UPDATE wallet_samsung_fetch_refs SET promoted_at = ?, market_cc2 = ?, market_query_bound = ?
        WHERE id = ? AND promoted_at IS NULL AND retired_at IS NULL
          AND (? = 0 OR served_at IS NOT NULL) AND ${inserted}`,
        [
          claim.now,
          receipt.countryHint,
          receipt.queryBound ? 1 : 0,
          ref.referenceId,
          requireServed ? 1 : 0,
          receipt.id,
          'ADDED',
        ],
      ),
    );
  return statements;
}

/**
 * Receipt insert, routing hint and effects. The first statement (the receipt) must run just before
 * the replay claim, which it reads as unclaimed; the rest run after the claim. `gate` is the fence the receipt is admitted under; its `?` values bind in order.
 */
export function receiptStatements(
  db: D1Database,
  ref: SamsungStateRef,
  claim: SamsungReplayClaim,
  receipt: SamsungReceipt,
  gate: { sql: string; params: SqlValue[] },
  requireServed: boolean,
  pass: InstancePass | null,
): D1PreparedStatement[] {
  const { envelope } = receipt;
  const statements = [
    stmt(
      db,
      `INSERT INTO wallet_samsung_callback_receipts
      (id, ref_id, instance_id, account_id, org_id, mode, operation_version, kind,
       signed_at, received_at, kek_version, iv, wrapped_dek, ciphertext,
       event, cc2, query_bound, token_hash, request_id)
      SELECT ?, r.id, i.id, i.account_id, i.org_id, i.mode, op.version, 'state_callback',
        ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ? ${stateJoins}
      WHERE ${gate.sql}
        AND NOT EXISTS (SELECT 1 FROM wallet_samsung_auth_replays prior WHERE prior.token_hash = ?)
      RETURNING id`,
      [
        receipt.id,
        receipt.signedAt,
        claim.now,
        envelope.kekVersion,
        envelope.iv,
        envelope.wrappedDek,
        envelope.ciphertext,
        receipt.event,
        receipt.countryHint,
        receipt.queryBound ? 1 : 0,
        claim.tokenHash,
        receipt.requestId,
        claim.now,
        ...gate.params,
        claim.tokenHash,
      ],
    ),
  ];
  if (receipt.countryHint) {
    // Marked dirty only for a country this ref has not reported yet, so it runs before the hint insert.
    statements.push(
      stmt(
        db,
        `INSERT INTO wallet_provider_instance_dirty (instance_id, generation)
      SELECT rc.instance_id, 1 FROM wallet_samsung_callback_receipts rc
      JOIN wallet_samsung_fetch_refs live ON live.id = rc.ref_id AND live.retired_at IS NULL
      WHERE rc.id = ? AND rc.cc2 = ?
        AND NOT EXISTS (SELECT 1 FROM wallet_samsung_country_hints known
          WHERE known.ref_id = rc.ref_id AND known.country_code = ?)
      ON CONFLICT(instance_id) DO UPDATE SET generation = generation + 1, next_attempt_at = 0`,
        [receipt.id, receipt.countryHint, receipt.countryHint],
      ),
      stmt(
        db,
        `INSERT INTO wallet_samsung_country_hints (ref_id, country_code, received_at)
      SELECT rc.ref_id, ?, ? FROM wallet_samsung_callback_receipts rc
      JOIN wallet_samsung_fetch_refs live ON live.id = rc.ref_id AND live.retired_at IS NULL
      WHERE rc.id = ? AND rc.cc2 = ?
      ON CONFLICT(ref_id, country_code) DO NOTHING`,
        [receipt.countryHint, claim.now, receipt.id, receipt.countryHint],
      ),
    );
  }
  statements.push(...effectStatements(db, ref, claim, receipt, requireServed, pass));
  return statements;
}

export interface SamsungIssuedRef {
  orgId: string;
  mode: 'live' | 'test';
  accountId: string;
  /** The newest revision of one credential this instance has operated under. */
  accountRevision: number;
  referenceId: string;
  instanceId: string;
  refHash: string;
}

const dead = `(r.retired_at IS NULL OR NOT EXISTS (
  SELECT 1 FROM wallet_samsung_tombstones tomb WHERE tomb.ref_hash = r.ref_hash))`;

/**
 * Any issued ref by hash that is not yet buried under a tombstone, whatever its operation state:
 * one row per distinct credential the instance has operated under (newest revision of each), so
 * the number of verifications is bounded by distinct certificates, not by revisions.
 */
export function findSamsungIssuedRefs(
  db: D1Database,
  refHash: string,
): Promise<SamsungIssuedRef[]> {
  return all<SamsungIssuedRef>(
    db,
    `SELECT i.org_id AS orgId, i.mode, i.account_id AS accountId,
      MAX(o.account_revision) AS accountRevision, r.id AS referenceId, i.id AS instanceId,
      r.ref_hash AS refHash
    FROM wallet_samsung_fetch_refs r JOIN wallet_provider_instances i ON i.id = r.instance_id
    JOIN wallet_provider_instance_operations o ON o.instance_id = i.id
    LEFT JOIN wallet_provider_account_events e ON e.account_id = i.account_id AND e.org_id = i.org_id
      AND e.mode = i.mode AND e.provider = 'samsung' AND e.kind = 'configure'
      AND e.revision = o.account_revision
    WHERE r.ref_hash = ? AND i.provider = 'samsung' AND i.account_id IS NOT NULL
      AND (e.id IS NOT NULL OR r.credential_version_id IS NOT NULL)
      AND r.credential_keyset_commitment = i.credential_keyset_commitment
      AND i.credential_keyset_commitment = ${pinnedKeysetSql} AND ${dead}
    GROUP BY COALESCE(e.credential_id, r.credential_version_id) ORDER BY accountRevision DESC LIMIT 33`,
    [refHash],
  );
}

/**
 * The fence for a callback on an issued ref outside its live operation: the ref, its instance's
 * account and the keyset are the ones the verified credential belongs to. Nothing else is decided.
 */
function issuedGate(ref: SamsungIssuedRef) {
  return {
    sql: `r.id = ? AND r.ref_hash = ? AND i.org_id = ? AND i.mode = ? AND i.account_id = ?
      AND r.credential_keyset_commitment = i.credential_keyset_commitment
      AND i.credential_keyset_commitment = ${pinnedKeysetSql} AND ${dead}`,
    params: [ref.referenceId, ref.refHash, ref.orgId, ref.mode, ref.accountId],
  };
}

/**
 * Admit one authenticated delivery for an issued ref outside its live fences. A GET only reserves
 * its token (the answer carries no card data); a POST also leaves its receipt and effects. A ref
 * that never served card data is not promoted by an ADDED here.
 */
export async function claimSamsungIssuedDelivery(
  db: D1Database,
  ref: SamsungIssuedRef,
  claim: SamsungReplayClaim,
  receipt: SamsungReceipt | null,
): Promise<boolean> {
  if (!validClaim(claim) || (receipt && !/^[A-Za-z0-9_-]{1,64}$/.test(receipt.requestId)))
    return false;
  const gate = issuedGate(ref);
  const deleteExpired = stmt(db, `DELETE FROM wallet_samsung_auth_replays WHERE expires_at <= ?`, [
    claim.now,
  ]);
  const claimReplay = stmt(
    db,
    `INSERT INTO wallet_samsung_auth_replays (token_hash, claim_id, expires_at)
      SELECT ?, ?, ? ${stateJoins} WHERE ${gate.sql} ON CONFLICT DO NOTHING
      RETURNING token_hash`,
    [claim.tokenHash, claim.claimId, claim.expiresAt, claim.now, ...gate.params],
  );
  const receipts: D1PreparedStatement[] = [];
  // A pending transfer means the callback may speak for the next holder: it is answered, not recorded.
  if (receipt)
    receipts.push(
      ...receiptStatements(
        db,
        ref,
        claim,
        receipt,
        {
          sql: `${gate.sql} AND NOT EXISTS (SELECT 1 FROM pass_credential_transfers transfer
            WHERE transfer.pass_id = i.pass_id AND transfer.state = 'pending')`,
          params: gate.params,
        },
        true,
        await instancePass(db, ref.instanceId),
      ),
    );
  const [receiptInsert, ...effects] = receipts;
  const statements = receiptInsert
    ? [deleteExpired, receiptInsert, claimReplay, ...effects]
    : [deleteExpired, claimReplay];
  return (await batch(db, statements))[receiptInsert ? 2 : 1]?.results.length === 1;
}
