import { all, run } from '../../platform/db.ts';
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

/**
 * Enrolments that may issue (On, not held or revoked, plan includes the wallet) and whose Apple releases have not been
 * projected since they were last turned On. `pairs` are the released (provider, mode) pairs; the caller never passes
 * an empty list.
 */
export async function listBackfillEnrolments(
  db: D1Database,
  pairs: readonly { provider: Provider; mode: Mode }[],
  limit: number,
): Promise<BackfillEnrolment[]> {
  const rows = await all<{ id: string; org_id: string; mode: Mode; provider: Provider }>(
    db,
    `SELECT a.id, a.org_id, a.mode, a.provider FROM wallet_provider_accounts a
     WHERE (${pairs.map(() => '(a.provider = ? AND a.mode = ?)').join(' OR ')})
       AND ${walletEnrolmentIssuesSql('a.org_id', 'a.mode', 'a.provider')}
       AND (a.projection_backfilled_at IS NULL
         OR a.projection_backfilled_at < COALESCE(a.enabled_at, 0))
     ORDER BY a.id LIMIT ?`,
    [...pairs.flatMap((p) => [p.provider, p.mode]), limit],
  );
  return rows.map((r) => ({ id: r.id, orgId: r.org_id, mode: r.mode, provider: r.provider }));
}

/**
 * The org's current Apple release of each active template in the mode that has no candidate for this provider yet.
 * Org-scoped releases only, as `queueSystemProjections` queues.
 */
export async function listUncoveredAppleSources(
  db: D1Database,
  e: BackfillEnrolment,
  limit: number,
): Promise<BackfillSource[]> {
  const rows = await all<{ id: string; template_id: string; version: string }>(
    db,
    `SELECT r.id, r.template_id, r.version FROM template_releases r
     JOIN templates t ON t.id = r.template_id
     WHERE r.org_id = ? AND r.mode = ? AND r.provider = 'apple' AND r.source IN ('approved', 'system')
       AND t.status = 'active'
       AND NOT EXISTS (SELECT 1 FROM template_releases newer
         WHERE newer.template_id = r.template_id AND newer.org_id = r.org_id
           AND newer.mode = r.mode AND newer.provider = 'apple' AND newer.generation > r.generation)
       AND NOT EXISTS (SELECT 1 FROM template_candidates c
         WHERE c.template_id = r.template_id AND c.org_id = r.org_id AND c.mode = r.mode
           AND c.provider = ? AND c.source_release_id = r.id)
     ORDER BY r.id LIMIT ?`,
    [e.orgId, e.mode, e.provider, limit],
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
