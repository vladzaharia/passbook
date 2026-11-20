import type { z } from 'zod';
import type { HoldSchema } from '../../../shared/contracts/retention.ts';
import { all } from '../../platform/db.ts';
import { userLabelSql } from '../orgs/repo-user-label.ts';

type HoldView = z.infer<typeof HoldSchema>;

interface Raw {
  id: string;
  pass_id: string | null;
  pass_serial: string | null;
  placed_by_kind: 'org' | 'platform';
  placed_label: string | null;
  reason: string;
  created_at: number;
  released_at: number | null;
  released_label: string | null;
}

const PLACER = userLabelSql('h.placed_by', 'h.org_id', false);
const RELEASER = userLabelSql('h.released_by', 'h.org_id', false);

/**
 * Holds of one org for the console, active first. A platform administrator is never named to an org: the
 * label is "PassBook"; only a platform administrator releases a platform hold.
 */
export async function listHoldViews(
  db: D1Database,
  orgId: string,
  viewer: 'org' | 'platform',
): Promise<HoldView[]> {
  const rows = await all<Raw>(
    db,
    `SELECT h.id, h.pass_id, p.serial AS pass_serial, h.placed_by_kind,
        CASE WHEN h.placed_by_kind = 'org' THEN ${PLACER} END AS placed_label,
        h.reason, h.created_at, h.released_at,
        CASE WHEN h.placed_by_kind = 'org' AND h.released_by IS NOT NULL THEN ${RELEASER} END AS released_label
     FROM retention_holds h LEFT JOIN passes p ON p.id = h.pass_id
     WHERE h.org_id = ?
     ORDER BY (h.released_at IS NOT NULL), h.created_at DESC, h.id DESC LIMIT 200`,
    [orgId],
  );
  return rows.map((r) => ({
    id: r.id,
    passId: r.pass_id,
    passLabel: r.pass_id ? `Pass ${r.pass_serial ?? r.pass_id.slice(0, 8)}` : null,
    placedByKind: r.placed_by_kind,
    placedByLabel: r.placed_by_kind === 'platform' ? 'PassBook' : (r.placed_label ?? 'Account'),
    reason: r.reason,
    createdAt: r.created_at,
    releasedAt: r.released_at,
    releasedByLabel:
      r.released_at === null
        ? null
        : r.placed_by_kind === 'platform'
          ? 'PassBook'
          : (r.released_label ?? 'Account'),
    canRelease: r.released_at === null && (viewer === 'platform' || r.placed_by_kind === 'org'),
  }));
}
