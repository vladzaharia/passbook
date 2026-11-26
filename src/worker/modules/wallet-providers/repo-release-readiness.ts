// Reads for the release readiness report (release-readiness.ts): enrolments, template releases and provider copies
// of one provider in one mode, across every org that is not deleted. Platform admins only.
import { all, first } from '../../platform/db.ts';
import { notPreviewOnlySql } from '../developer/repo-fence.ts';
import type { WalletProvider } from './instance-types.ts';

type Mode = 'live' | 'test';

export interface ReleaseEnrolmentRow {
  org_id: string;
  org_name: string;
  org_status: 'active' | 'suspended';
  entitled: number;
  credential_id: string | null;
  credential_source_id: string | null;
  enabled_at: number | null;
  enrolment_revision: number;
  platform_hold_at: number | null;
  revoked_at: number | null;
  /** An enable event exists: the enrolment was On once. */
  was_on: number;
  /** The newest event since the last enable that turned it Off (disable, source, hold, release), if any. */
  off_kind: 'disable' | 'source' | 'hold' | 'release' | null;
}

/** Every enrolment row of the provider and mode; `entitled` is the plan layer (developer and preview-only orgs never). */
export function listReleaseEnrolments(
  db: D1Database,
  provider: WalletProvider,
  mode: Mode,
): Promise<ReleaseEnrolmentRow[]> {
  return all<ReleaseEnrolmentRow>(
    db,
    `SELECT a.org_id, o.name AS org_name, o.status AS org_status,
       (o.kind != 'developer' AND ${notPreviewOnlySql('a.org_id')} AND EXISTS (SELECT 1 FROM org_entitlement_values v
         WHERE v.org_id = a.org_id AND v.key = 'wallet.' || a.provider AND v.value = '1')) AS entitled,
       a.credential_id, a.credential_source_id, a.enabled_at, a.enrolment_revision, a.platform_hold_at,
       a.revoked_at,
       EXISTS (SELECT 1 FROM wallet_enrolment_events e WHERE e.account_id = a.id AND e.kind = 'enable') AS was_on,
       (SELECT e.kind FROM wallet_enrolment_events e WHERE e.account_id = a.id
         AND e.kind IN ('disable', 'source', 'hold', 'release')
         AND e.enrolment_revision > COALESCE((SELECT MAX(x.enrolment_revision) FROM wallet_enrolment_events x
           WHERE x.account_id = a.id AND x.kind = 'enable'), 0)
         ORDER BY e.enrolment_revision DESC LIMIT 1) AS off_kind
     FROM wallet_provider_accounts a JOIN orgs o ON o.id = a.org_id AND o.status != 'deleted'
     WHERE a.provider = ? AND a.mode = ?
     ORDER BY o.name, a.org_id`,
    [provider, mode],
  );
}

/** A copy that can still be in a wallet (0226 `wallet_provider_releases_dark_retired`). */
const OPEN_COPY = `(lifecycle IN ('active', 'revoking', 'revoked') OR (account_id IS NOT NULL AND lifecycle != 'retired'))`;

export interface ReleaseTemplateCounts {
  ready: number;
  withOmissions: number;
  awaitingReview: number;
  none: number;
}

/**
 * Org templates with an Apple release in the mode, by their newest provider release: ready (no approved
 * omission), with omissions, awaiting review (a candidate, no release yet) or none.
 */
export async function countReleaseTemplates(
  db: D1Database,
  provider: WalletProvider,
  mode: Mode,
): Promise<ReleaseTemplateCounts> {
  const row = await first<Record<keyof ReleaseTemplateCounts, number | null>>(
    db,
    `WITH apple AS (
       SELECT DISTINCT r.template_id, r.org_id FROM template_releases r JOIN orgs o ON o.id = r.org_id
       WHERE r.provider = 'apple' AND r.mode = ?1 AND o.status != 'deleted'),
     latest AS (
       SELECT a.template_id, a.org_id,
         (SELECT pr.id FROM template_releases pr WHERE pr.template_id = a.template_id AND pr.org_id = a.org_id
           AND pr.mode = ?1 AND pr.provider = ?2 ORDER BY pr.generation DESC LIMIT 1) AS release_id,
         EXISTS (SELECT 1 FROM template_candidates c WHERE c.template_id = a.template_id AND c.org_id = a.org_id
           AND c.mode = ?1 AND c.provider = ?2) AS has_candidate
       FROM apple a),
     graded AS (
       SELECT l.release_id, l.has_candidate,
         COALESCE(json_array_length(json_extract(c.projection_json, '$.approvedOmissions')), 0) AS omissions
       FROM latest l LEFT JOIN template_releases r ON r.id = l.release_id
       LEFT JOIN template_candidates c ON c.id = r.candidate_id)
     SELECT
       SUM(release_id IS NOT NULL AND omissions = 0) AS ready,
       SUM(release_id IS NOT NULL AND omissions > 0) AS withOmissions,
       SUM(release_id IS NULL AND has_candidate) AS awaitingReview,
       SUM(release_id IS NULL AND NOT has_candidate) AS none
     FROM graded`,
    [mode, provider],
  );
  return {
    ready: row?.ready ?? 0,
    withOmissions: row?.withOmissions ?? 0,
    awaitingReview: row?.awaitingReview ?? 0,
    none: row?.none ?? 0,
  };
}

/**
 * Provider copies of the provider and mode: open (one that can be in a wallet: it reached active, or it has an account
 * and is not retired; the same rule as 0226's dark check) and retired.
 */
export async function countReleaseInstances(
  db: D1Database,
  provider: WalletProvider,
  mode: Mode,
): Promise<{ open: number; retired: number }> {
  const row = await first<{ open: number | null; retired: number | null }>(
    db,
    `SELECT SUM(${OPEN_COPY}) AS open, SUM(lifecycle = 'retired') AS retired
     FROM wallet_provider_instances WHERE provider = ? AND mode = ?`,
    [provider, mode],
  );
  return { open: row?.open ?? 0, retired: row?.retired ?? 0 };
}
