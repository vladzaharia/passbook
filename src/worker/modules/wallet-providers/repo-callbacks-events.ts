import { batch, stmt } from '../../platform/db.ts';
import { credentialRefKeysetSql } from '../passes/repo-credential-keyset.ts';
import {
  type SamsungFetchSnapshot,
  samsungPassJsonCurrentSql,
  samsungSnapshotParams,
  samsungSnapshotPredicate,
} from './repo-callbacks.ts';
import { instancePass } from './repo-callbacks-identity.ts';
import {
  receiptStatements,
  type SamsungReceipt,
  type SamsungReplayClaim,
  stateJoins,
  validClaim,
} from './repo-callbacks-state.ts';
import { samsungInitialWindowSql } from './repo-callbacks-window.ts';

/** The live fence: current operation, pass and initial window or promotion. Binds `now` twice. */
function liveGate(snapshot: SamsungFetchSnapshot, now: number, rawPassJson: string) {
  return {
    sql: `${samsungSnapshotPredicate()} AND ${samsungInitialWindowSql}
      AND ${samsungPassJsonCurrentSql}`,
    params: [...samsungSnapshotParams(snapshot), now, now, rawPassJson],
  };
}

function claimStatement(
  db: D1Database,
  snapshot: SamsungFetchSnapshot,
  claim: SamsungReplayClaim,
  rawPassJson: string,
): D1PreparedStatement {
  const gate = liveGate(snapshot, claim.now, rawPassJson);
  return stmt(
    db,
    `INSERT INTO wallet_samsung_auth_replays (token_hash, claim_id, expires_at)
    SELECT ?, ?, ? ${stateJoins} WHERE ${gate.sql}
    ON CONFLICT DO NOTHING
    RETURNING token_hash`,
    [claim.tokenHash, claim.claimId, claim.expiresAt, claim.now, ...gate.params],
  );
}

/**
 * Replay reservation never promotes a ref: only a verified ADDED receipt does. A ref may answer
 * inside its initial window (a delivered wrapper) or once promoted. The first admitted fetch
 * records `served_at`: from then on the card may be on a device, even if no ADDED ever arrives.
 */
export async function claimSamsungFetch(
  db: D1Database,
  snapshot: SamsungFetchSnapshot,
  claim: SamsungReplayClaim,
  rawPassJson: string,
): Promise<boolean> {
  if (!validClaim(claim)) return false;
  const results = await batch(db, [
    stmt(
      db,
      `DELETE FROM wallet_samsung_auth_replays WHERE expires_at <= ? AND ${credentialRefKeysetSql}`,
      [claim.now, snapshot.credentialKeysetCommitment],
    ),
    claimStatement(db, snapshot, claim, rawPassJson),
    stmt(
      db,
      `UPDATE wallet_samsung_fetch_refs SET served_at = ?
      WHERE id = ? AND served_at IS NULL AND EXISTS (SELECT 1 FROM wallet_samsung_auth_replays replay
        WHERE replay.token_hash = ? AND replay.claim_id = ?)`,
      [claim.now, snapshot.referenceId, claim.tokenHash, claim.claimId],
    ),
  ]);
  return results[1]?.results.length === 1;
}

/** Store untrusted raw bytes encrypted only after authenticated replay-safe admission. */
export async function claimSamsungReceipt(
  db: D1Database,
  snapshot: SamsungFetchSnapshot,
  claim: SamsungReplayClaim,
  receipt: SamsungReceipt,
  rawPassJson: string,
): Promise<boolean> {
  if (
    !validClaim(claim) ||
    !Number.isSafeInteger(receipt.signedAt) ||
    !/^[A-Za-z0-9_-]{1,64}$/.test(receipt.requestId) ||
    (receipt.countryHint !== null && !/^[A-Z]{2}$/.test(receipt.countryHint))
  )
    return false;
  const [receiptInsert, ...effects] = receiptStatements(
    db,
    snapshot,
    claim,
    receipt,
    liveGate(snapshot, claim.now, rawPassJson),
    false,
    await instancePass(db, snapshot.instanceId),
  );
  const results = await batch(db, [
    stmt(
      db,
      `DELETE FROM wallet_samsung_auth_replays WHERE expires_at <= ? AND ${credentialRefKeysetSql}`,
      [claim.now, snapshot.credentialKeysetCommitment],
    ),
    receiptInsert as D1PreparedStatement,
    claimStatement(db, snapshot, claim, rawPassJson),
    ...effects,
  ]);
  return results[1]?.results.length === 1 && results[2]?.results.length === 1;
}
