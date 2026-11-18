import type { Check } from '../../platform/authority-checks.ts';
import { tenantCheck } from '../../platform/authority-cond.ts';

const DAY = 24 * 60 * 60 * 1000;

export interface JoinCheckInput {
  linkId: string;
  templateId: string;
  orgDailyCap: number;
  holderEmail: string | null;
  now: number;
}

/** The link, cap and duplicate checks of a join create, evaluated in the grant over the link's org and mode. */
export function joinChecks(input: JoinCheckInput): Check[] {
  const { linkId, templateId, now } = input;
  const checks: Check[] = [
    tenantCheck(
      'config',
      `(SELECT jl.template_id FROM join_links jl
        WHERE jl.id = ? AND jl.org_id = {org} AND jl.mode = {mode}) = ?`,
      [linkId, templateId],
    ),
    tenantCheck(
      'config',
      `(SELECT COUNT(*) FROM join_issues ji WHERE ji.link_id = ? AND ji.org_id = {org}
          AND ji.mode = {mode} AND ji.created_at > ?)
        < (SELECT jl.daily_limit FROM join_links jl WHERE jl.id = ?)`,
      [linkId, now - DAY, linkId],
    ),
    tenantCheck(
      'config',
      `(SELECT COUNT(*) FROM join_issues ji
        WHERE ji.org_id = {org} AND ji.mode = {mode} AND ji.created_at > ?) < ?`,
      [now - DAY, input.orgDailyCap],
    ),
  ];
  if (input.holderEmail !== null)
    checks.push(
      tenantCheck(
        'lineage',
        `NOT EXISTS (SELECT 1 FROM passes p
          WHERE p.org_id = {org} AND p.mode = {mode} AND p.template_id = ? AND p.holder_email = ?
            AND p.status = 'active' AND p.removed_at IS NULL AND p.deleted_at IS NULL
            AND p.test_data_quarantined = 0)`,
        [templateId, input.holderEmail],
      ),
    );
  return checks;
}
