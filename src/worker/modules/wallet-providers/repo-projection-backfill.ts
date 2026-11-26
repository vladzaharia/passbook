import { all, run } from '../../platform/db.ts';
import { SYSTEM_AUTHOR } from './projection-system-authority.ts';
import { walletEnrolmentIssuesSql } from './repo-enrolment-gate.ts';

type Mode = 'live' | 'test';
type Provider = 'google' | 'samsung';

export interface BackfillEnrolment {
  id: string;
  orgId: string;
  mode: Mode;
  provider: Provider;
}

export interface BackfillSource {
  releaseId: string;
  templateId: string;
  version: string;
}

/** Re-drive back-off of a stranded platform candidate: half its age, from 15 minutes up to 6 hours (so it doubles). */
export const REDRIVE_MIN_MS = 15 * 60_000;
export const REDRIVE_MAX_MS = 6 * 3_600_000;

/**
 * Enrolments that may issue (On, not held or revoked, plan includes the wallet, org active) and are pending: never
 * swept, or last swept before the enrolment was turned On, before the pair's release last changed (a rollback to
 * draining and back), or before the org's plan or overrides last changed; or holding a stranded platform candidate
 * (no release, no omissions, newest of its source, source still the Apple head) whose back-off has passed. A
 * candidate's back-off is half its age, so re-drives double apart and a released or replaced candidate resets it.
 * `pairs` are the released (provider, mode) pairs; the caller never passes an empty list. Never-swept first, then
 * the oldest sweep, so failing enrolments cannot starve the rest.
 */
export async function listBackfillEnrolments(
  db: D1Database,
  pairs: readonly { provider: Provider; mode: Mode }[],
  now: number,
  limit: number,
): Promise<BackfillEnrolment[]> {
  const rows = await all<{ id: string; org_id: string; mode: Mode; provider: Provider }>(
    db,
    `SELECT a.id, a.org_id, a.mode, a.provider FROM wallet_provider_accounts a
     JOIN wallet_provider_releases rel ON rel.provider = a.provider AND rel.mode = a.mode
     WHERE (${pairs.map(() => '(a.provider = ? AND a.mode = ?)').join(' OR ')})
       AND ${walletEnrolmentIssuesSql('a.org_id', 'a.mode', 'a.provider')}
       AND EXISTS (SELECT 1 FROM orgs o WHERE o.id = a.org_id AND o.status = 'active')
       AND (a.projection_backfilled_at IS NULL
         OR a.projection_backfilled_at < COALESCE(a.enabled_at, 0)
         OR a.projection_backfilled_at < rel.changed_at
         OR a.projection_backfilled_at < COALESCE((SELECT e.updated_at FROM org_entitlements e
           WHERE e.org_id = a.org_id), 0)
         OR a.projection_backfilled_at < COALESCE((SELECT max(x.updated_at) FROM org_entitlement_overrides x
           WHERE x.org_id = a.org_id), 0)
         OR EXISTS (SELECT 1 FROM template_candidates c
           JOIN template_releases src ON src.id = c.source_release_id
           WHERE c.provider_account_id = a.id AND c.author_id = ?
             AND json_array_length(json_extract(c.projection_json, '$.approvedOmissions')) = 0
             AND a.projection_backfilled_at <= ? - min(max(?, (? - c.created_at) / 2), ?)
             AND NOT EXISTS (SELECT 1 FROM template_releases pr WHERE pr.candidate_id = c.id)
             AND NOT EXISTS (SELECT 1 FROM template_candidates n
               WHERE n.org_id = c.org_id AND n.mode = c.mode AND n.provider = c.provider
                 AND n.source_release_id = c.source_release_id AND n.author_id = c.author_id
                 AND n.rowid > c.rowid)
             AND NOT EXISTS (SELECT 1 FROM template_releases newer
               WHERE newer.template_id = src.template_id AND newer.org_id IS src.org_id
                 AND newer.mode = src.mode AND newer.provider = 'apple'
                 AND newer.generation > src.generation)))
     ORDER BY a.projection_backfilled_at IS NOT NULL, a.projection_backfilled_at, a.id LIMIT ?`,
    [
      ...pairs.flatMap((p) => [p.provider, p.mode]),
      SYSTEM_AUTHOR,
      now,
      REDRIVE_MIN_MS,
      now,
      REDRIVE_MAX_MS,
      limit,
    ],
  );
  return rows.map((r) => ({ id: r.id, orgId: r.org_id, mode: r.mode, provider: r.provider }));
}

/**
 * The org's current Apple release of each active template in the mode that no provider release has been built
 * from yet, after `after` (a release id; '' for the first page). A source is covered by a provider release, by a
 * person's candidate, or by a platform candidate that waits for a person (it has omissions). A platform
 * candidate with none of those is stranded (written, not released) and is driven again; the job resumes it.
 * Org-scoped releases only, as `queueSystemProjections` queues.
 */
export async function listUncoveredAppleSources(
  db: D1Database,
  e: BackfillEnrolment,
  after: string,
  limit: number,
): Promise<BackfillSource[]> {
  const rows = await all<{ id: string; template_id: string; version: string }>(
    db,
    `SELECT r.id, r.template_id, r.version FROM template_releases r
     JOIN templates t ON t.id = r.template_id
     WHERE r.org_id = ? AND r.mode = ? AND r.provider = 'apple' AND r.source IN ('approved', 'system')
       AND t.status = 'active' AND r.id > ?
       AND NOT EXISTS (SELECT 1 FROM template_releases newer
         WHERE newer.template_id = r.template_id AND newer.org_id = r.org_id
           AND newer.mode = r.mode AND newer.provider = 'apple' AND newer.generation > r.generation)
       AND NOT EXISTS (SELECT 1 FROM template_candidates c
         WHERE c.template_id = r.template_id AND c.org_id = r.org_id AND c.mode = r.mode
           AND c.provider = ? AND c.source_release_id = r.id
           AND (c.author_id != ?
             OR EXISTS (SELECT 1 FROM template_releases pr WHERE pr.candidate_id = c.id)
             OR (json_array_length(json_extract(c.projection_json, '$.approvedOmissions')) > 0
               AND NOT EXISTS (SELECT 1 FROM template_candidates n
                 WHERE n.org_id = c.org_id AND n.mode = c.mode AND n.provider = c.provider
                   AND n.source_release_id = c.source_release_id AND n.author_id = c.author_id
                   AND n.rowid > c.rowid))))
     ORDER BY r.id LIMIT ?`,
    [e.orgId, e.mode, after, e.provider, SYSTEM_AUTHOR, limit],
  );
  return rows.map((r) => ({ releaseId: r.id, templateId: r.template_id, version: r.version }));
}

/** Stamps with the time the sweep started: an enrolment turned On since then stays pending. */
export async function stampBackfilled(db: D1Database, id: string, at: number): Promise<void> {
  await run(db, 'UPDATE wallet_provider_accounts SET projection_backfilled_at = ? WHERE id = ?', [
    at,
    id,
  ]);
}
