import { all, first, run } from '../../platform/db.ts';
import { hasCredentialSql } from './account-presence.ts';
import { walletEnrolmentIssuesSql } from './repo-enrolment-gate.ts';

/** What a live read of one compiled card's template left behind. */
export interface SamsungCardState {
  candidateId: string;
  candidateHash: string;
  accountId: string;
  accountEpoch: number;
  cardType: string;
  state: string;
  testingModeOff: 'Y' | 'N';
  verifiedAt: number;
  expiresAt: number;
}

/** Replaces the candidate's row, but only while the candidate and its account epoch are still what was read. */
export async function putSamsungCardState(db: D1Database, s: SamsungCardState): Promise<boolean> {
  const { changes } = await run(
    db,
    `INSERT INTO wallet_samsung_card_state
      (candidate_id, candidate_hash, account_id, account_epoch, card_type, state, testing_mode_off, verified_at, expires_at)
    SELECT c.id, c.candidate_hash, c.provider_account_id, c.provider_account_epoch, ?, ?, ?, ?, ?
    FROM template_candidates c JOIN wallet_provider_accounts a ON a.id = c.provider_account_id
      AND a.authority_epoch = c.provider_account_epoch AND a.revoked_at IS NULL
    WHERE c.id = ? AND c.candidate_hash = ? AND c.provider = 'samsung'
      AND c.provider_account_id = ? AND c.provider_account_epoch = ?
      AND json_extract(c.projection_json, '$.type') = ?
    ON CONFLICT(candidate_id) DO UPDATE SET candidate_hash = excluded.candidate_hash,
      account_id = excluded.account_id, account_epoch = excluded.account_epoch,
      card_type = excluded.card_type, state = excluded.state,
      testing_mode_off = excluded.testing_mode_off, verified_at = excluded.verified_at,
      expires_at = excluded.expires_at`,
    [
      s.cardType,
      s.state,
      s.testingModeOff,
      s.verifiedAt,
      s.expiresAt,
      s.candidateId,
      s.candidateHash,
      s.accountId,
      s.accountEpoch,
      s.cardType,
    ],
  );
  return changes > 0;
}

/** A card that failed its read is not usable: its row goes, so no request path keeps offering it. */
export async function clearSamsungCardState(db: D1Database, candidateId: string): Promise<void> {
  await run(db, 'DELETE FROM wallet_samsung_card_state WHERE candidate_id = ?', [candidateId]);
}

/** The row alone, never Samsung: a request path (an offer, a page, an email) asks only this. */
export async function samsungCardStateFresh(
  db: D1Database,
  c: { id: string; candidateHash: string; accountId: string; accountEpoch: number; mode: string },
  cardType: string,
  now: number,
  /** Time the row must still have, for a decision that is followed by a write (a publish). */
  marginMs = 0,
): Promise<boolean> {
  const row = await first<{ ok: number }>(
    db,
    `SELECT 1 AS ok FROM wallet_samsung_card_state st
    WHERE st.candidate_id = ? AND st.candidate_hash = ? AND st.account_id = ? AND st.account_epoch = ?
      AND st.card_type = ?
      AND ((st.state = 'ACTIVE' AND st.testing_mode_off = 'Y')${c.mode === 'test' ? " OR st.state IN ('ACTIVE', 'DRAFT', 'VERIFYING')" : ''})
      AND st.verified_at <= ? AND ? < st.expires_at`,
    [c.id, c.candidateHash, c.accountId, c.accountEpoch, cardType, now, now + marginMs],
  );
  return row !== null;
}

/**
 * Compiled cards of the current head release, in an active org under the account's current epoch,
 * whose row is missing or lapses within `ahead`: the sync job reads them live. Oldest first.
 */
export function selectSamsungCardsToRefresh(
  db: D1Database,
  now: number,
  ahead: number,
  limit: number,
): Promise<{ id: string; hash: string }[]> {
  return all<{ id: string; hash: string }>(
    db,
    `SELECT c.id, c.candidate_hash AS hash FROM template_releases r
    JOIN template_candidates c ON c.id = r.candidate_id
    JOIN orgs owner ON owner.id = r.org_id AND owner.status = 'active'
    JOIN wallet_provider_accounts account ON account.id = c.provider_account_id
      AND account.authority_epoch = c.provider_account_epoch AND ${hasCredentialSql('account')}
      AND account.revoked_at IS NULL
      AND (account.credential_source_id IS NULL OR EXISTS (SELECT 1 FROM wallet_credentials src
        WHERE src.id = account.credential_source_id AND src.revoked_at IS NULL))
    LEFT JOIN wallet_samsung_card_state st ON st.candidate_id = c.id
    WHERE r.provider = 'samsung' AND r.source = 'approved' AND r.action IN ('release', 'rollback')
      AND ${walletEnrolmentIssuesSql('r.org_id', 'r.mode', 'r.provider')}
      AND json_extract(c.projection_json, '$.schema') = 2
      AND (st.candidate_id IS NULL OR st.expires_at <= ?)
      AND NOT EXISTS (SELECT 1 FROM template_releases newer WHERE newer.template_id = r.template_id
        AND newer.org_id = r.org_id AND newer.mode = r.mode AND newer.provider = r.provider
        AND newer.generation > r.generation)
    ORDER BY COALESCE(st.expires_at, 0) LIMIT ?`,
    [now + ahead, limit],
  );
}

/** The sync job's work: compiled cards whose row is missing or lapses within a minute. */
export const CARD_STATE_AHEAD_MS = 60_000;
