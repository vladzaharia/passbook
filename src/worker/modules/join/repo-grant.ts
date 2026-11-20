import type { Check } from '../../platform/authority-checks.ts';
import { tenantCheck } from '../../platform/authority-cond.ts';
import { withinLimit } from '../../platform/entitlements.ts';

const DAY = 24 * 60 * 60 * 1000;

export interface JoinCheckInput {
  linkId: string;
  orgId: string;
  templateId: string;
  orgDailyCap: number;
  holderEmail: string | null;
  now: number;
}

/**
 * The link, cap and duplicate checks of a join create, evaluated in the grant over the link's org and
 * mode. Each reads the link row through EXISTS or COALESCE, so a missing row refuses instead of passing NULL.
 */
export function joinChecks(input: JoinCheckInput): Check[] {
  const { linkId, templateId, now } = input;
  const checks: Check[] = [
    // The pass is built for the org the caller names: it must be the link's.
    { reason: 'org', ok: (b) => `a.org_id = ${b.bind(input.orgId)}` },
    tenantCheck(
      'config',
      `EXISTS (SELECT 1 FROM join_links jl
        WHERE jl.id = ? AND jl.org_id = {org} AND jl.mode = {mode} AND jl.template_id = ?)`,
      [linkId, templateId],
    ),
    tenantCheck(
      'config',
      `(SELECT COUNT(*) FROM join_issues ji WHERE ji.link_id = ? AND ji.org_id = {org}
          AND ji.mode = {mode} AND ji.created_at > ?)
        < COALESCE((SELECT jl.daily_limit FROM join_links jl WHERE jl.id = ?), 0)`,
      [linkId, now - DAY, linkId],
    ),
    tenantCheck(
      'config',
      `(SELECT COUNT(*) FROM join_issues ji
        WHERE ji.org_id = {org} AND ji.mode = {mode} AND ji.created_at > ?) < ?`,
      [now - DAY, input.orgDailyCap],
    ),
  ];
  // The plan's cap on cards a day, over the same rolling window as the platform's.
  checks.push(
    withinLimit(
      'join.perDay',
      'SELECT COUNT(*) FROM join_issues ji WHERE ji.org_id = {org} AND ji.mode = {mode} AND ji.created_at > ?',
      [now - DAY],
    ),
  );
  // An address is taken only when the link asks for one.
  if (input.holderEmail !== null)
    checks.push(
      tenantCheck(
        'config',
        'COALESCE((SELECT jl.ask_email FROM join_links jl WHERE jl.id = ?), 0) = 1',
        [linkId],
      ),
    );
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
