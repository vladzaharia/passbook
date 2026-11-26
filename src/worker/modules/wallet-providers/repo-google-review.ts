import { all } from '../../platform/db.ts';
import { walletEnrolmentIssuesSql, walletProviderEnabledSql } from './provider-policy.ts';
import { REVIEW_BACKOFF_SQL } from './repo-google-class-write.ts';

export interface DueGoogleClassReview {
  classIdHash: string;
  passId: string;
  orgId: string;
  mode: 'live' | 'test';
  classType: string | null;
  classKey: string | null;
}

/**
 * Classes whose review is unknown, draft or under review and whose backoff has passed, oldest check first,
 * with one active instance each to read under. Only a provider and mode the platform has released and an
 * org whose enrolment is on, entitled and not preview-only: a dark provider is never read.
 */
export function listDueGoogleClassReviews(
  db: D1Database,
  now: number,
  limit: number,
): Promise<DueGoogleClassReview[]> {
  return all<DueGoogleClassReview>(
    db,
    `SELECT c.class_id_hash AS classIdHash, MIN(i.pass_id) AS passId, i.org_id AS orgId, i.mode AS mode,
      b.class_type AS classType, b.class_key AS classKey
    FROM wallet_google_classes c
    JOIN wallet_google_callback_bindings b ON b.class_id_hash = c.class_id_hash
    JOIN wallet_provider_instances i ON i.id = b.instance_id AND i.provider = 'google'
      AND i.lifecycle = 'active' AND i.retirement_requested_at IS NULL AND i.account_id IS NOT NULL
    WHERE (c.review_status IS NULL OR c.review_status IN ('DRAFT', 'UNDER_REVIEW'))
      AND c.pending_generation IS NULL
      AND (c.review_checked_at IS NULL OR c.review_checked_at +
        ${REVIEW_BACKOFF_SQL.replaceAll('review_failures', 'c.review_failures')} <= ?)
      AND ${walletProviderEnabledSql('i.provider', 'i.mode')}
      AND ${walletEnrolmentIssuesSql('i.org_id', 'i.mode', 'i.provider')}
    GROUP BY c.class_id_hash ORDER BY COALESCE(c.review_checked_at, 0), c.class_id_hash LIMIT ?`,
    [now, limit],
  );
}
