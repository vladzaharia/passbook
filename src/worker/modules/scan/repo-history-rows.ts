import type { SqlValue } from '../../platform/db.ts';
import { UnavailableError } from '../../platform/errors.ts';
import type { HistoryRaw, HistoryRow } from './history-row.ts';
import { toHistoryRow } from './history-row.ts';
import { uniqueScanEventIdSql } from './repo-history-provenance.ts';
import {
  EVENT_PINNED_KEY,
  HISTORY_FLAG_COLUMNS,
  HISTORY_SOURCE_COLUMNS,
} from './repo-history-row-flags.ts';
import { usedReleaseIdSql } from './repo-pass-release-sql.ts';
import { type ScanReadAuthority, scanAuthorizedStmt, scanRead } from './repo-read-authority.ts';

/** Scan, names and the unavailable-pass facts of one history row; `page.scan_id` names the scan. */
export const HISTORY_COLUMNS = `s.id, s.org_id, s.mode, s.at, s.outcome, s.reason, s.action_id,
    s.action_kind, s.direction, s.pass_id, s.template_id, t.name AS template_name,
    s.actor_key, s.state AS scan_state, s.scanner_id AS raw_scanner_id, s.event_id AS raw_event_id,
    s.staff_id AS raw_staff_id, s.api_key_id, s.undone_by AS raw_undone_by, s.presence_scope, s.pass_version,
    e.id AS event_id, e.name AS event_name, sc.id AS scanner_id, sc.name AS scanner_name,
    st.id AS staff_id, st.name AS staff_name, ap.name AS approver_name, s.method, s.amount,
    s.before_value, s.after_value, s.override_of, s.offline, s.pass_state,
    EXISTS (SELECT 1 FROM scan_offline_reads r WHERE r.scan_id = s.id AND r.org_id = s.org_id AND r.late = 1) AS late,
    s.actor_type, s.actor_id, s.undone_at,
    u.id AS undone_by, undo_target.id AS undoes,
    (SELECT COUNT(*) FROM scan_group_members g WHERE g.group_scan_id = s.id AND g.org_id = s.org_id) AS group_size,
    coalesce(ust.name, usc.name, CASE WHEN u.actor_type = 'user' THEN 'Admin console' END) AS undone_by_name,
    ${HISTORY_FLAG_COLUMNS},
    ${HISTORY_SOURCE_COLUMNS}`;

/** Primary-key joins: the cardinality of the page never changes. `page` names the scans. */
export const HISTORY_JOINS = `LEFT JOIN scans s ON s.id = page.scan_id
  LEFT JOIN pass_events l ON l.id = (${uniqueScanEventIdSql('s')})
  LEFT JOIN pass_versions recorded ON recorded.pass_id = s.pass_id
    AND CASE WHEN json_valid(l.data) THEN
      json_type(l.data, '$.authority.walletVersion') = 'integer'
      AND recorded.version = json_extract(l.data, '$.authority.walletVersion')
      AND json_type(l.data, '$.authority.walletTemplateVersion') IN ('null', 'text')
      AND recorded.template_version IS json_extract(l.data, '$.authority.walletTemplateVersion')
      ELSE 0 END
    AND recorded.version > 0 AND recorded.version <= s.pass_version
  LEFT JOIN template_versions rtv ON rtv.template_id = s.template_id
    AND rtv.version = (${EVENT_PINNED_KEY})
  LEFT JOIN passes p ON p.id = s.pass_id AND p.org_id = s.org_id AND p.mode = s.mode
    AND p.template_id = s.template_id
  LEFT JOIN templates t ON t.id = s.template_id AND (t.org_id IS NULL OR t.org_id = s.org_id)
  LEFT JOIN template_versions cpv ON cpv.template_id = p.template_id AND cpv.version = p.template_version
  LEFT JOIN template_releases ar ON ar.id = (${usedReleaseIdSql('p')})
  LEFT JOIN pass_versions cw ON cw.pass_id = p.id AND cw.version = (SELECT v.version FROM pass_versions v
    WHERE v.pass_id = p.id AND v.version <= p.version ORDER BY v.version DESC LIMIT 1)
  LEFT JOIN connections conn ON conn.id = p.connection_id AND conn.org_id = p.org_id AND conn.enabled = 1
  LEFT JOIN orgs o ON o.id = p.org_id
  LEFT JOIN scan_events e ON e.id = s.event_id AND e.org_id = s.org_id AND e.mode = s.mode
    AND (s.pass_id IS NOT NULL OR e.archived_at IS NULL)
  LEFT JOIN scanners sc ON sc.id = s.scanner_id AND sc.org_id = s.org_id AND sc.mode = s.mode
  LEFT JOIN scan_staff st ON st.id = s.staff_id AND st.org_id = s.org_id
  LEFT JOIN scan_staff ap ON ap.id = s.approved_by AND ap.org_id = s.org_id
  LEFT JOIN scans u ON u.id = s.undone_by AND u.org_id = s.org_id AND u.mode = s.mode
  LEFT JOIN scans undo_target
    ON undo_target.id = s.undoes AND undo_target.org_id = s.org_id AND undo_target.mode = s.mode
  LEFT JOIN scan_staff ust ON ust.id = u.staff_id AND ust.org_id = s.org_id
  LEFT JOIN scanners usc ON usc.id = u.scanner_id AND usc.org_id = s.org_id AND usc.mode = s.mode`;

/** The scans one page names: conditions over `s`, newest first. The tenant comes from the fence. */
export interface HistorySelector {
  /** Conditions over the scan alias `s`, after the tenant and ledger scope. */
  where: string;
  params: readonly SqlValue[];
  limit: number;
  /** The tenant predicate (`auth.tenantOnce`); defaults to the fence's own. */
  tenant?: string;
}

const PAGE_SCANS = (auth: ScanReadAuthority, sel: HistorySelector) => `page AS MATERIALIZED (
    SELECT s.id AS scan_id FROM ${auth.rows}scans s
    WHERE ${auth.present} AND ${sel.tenant ?? auth.tenantOnce('s', 'scans')} AND ${sel.where}
    ORDER BY s.at DESC, s.id DESC LIMIT ?)`;

/** The page statement: the scans, their ledger events, recorded and current pass state, names, flags. */
export function historyPageStmt(
  db: D1Database,
  auth: ScanReadAuthority,
  sel: HistorySelector,
  now: number,
): D1PreparedStatement {
  return scanRead(
    db,
    auth,
    `SELECT ${HISTORY_COLUMNS} FROM page ${HISTORY_JOINS}
     ORDER BY s.at DESC, s.id DESC`,
    [now],
    { ctes: PAGE_SCANS(auth, sel), params: [...sel.params, sel.limit] },
  );
}

/**
 * The authority and the page in one batch, so one snapshot answers both: unauthorized is told
 * apart from empty. Everything the rows say was read in this transaction.
 */
export async function readHistoryPage(
  db: D1Database,
  auth: ScanReadAuthority,
  sel: HistorySelector,
  now: number,
): Promise<{ authorized: boolean; rows: HistoryRow[] }> {
  const [authorized, page] = await db.batch([
    scanAuthorizedStmt(db, auth),
    historyPageStmt(db, auth, sel, now),
  ]);
  const ok = (authorized?.results[0] as { authorized: number } | undefined)?.authorized === 1;
  // An authorized page that did not come back is an outage, never an empty page.
  if (ok && !Array.isArray(page?.results))
    throw new UnavailableError(
      'Scan history is unavailable. Try again.',
      'SCAN_HISTORY_UNAVAILABLE',
    );
  return {
    authorized: ok,
    rows: ok ? (page?.results ?? []).map((r) => toHistoryRow(r as unknown as HistoryRaw)) : [],
  };
}
