import { type Check, rawCheck } from '../../platform/authority-checks.ts';
import { tenantCheck } from '../../platform/authority-cond.ts';
import { type GrantPart, readPart } from '../../platform/authority-include.ts';
import { DEVICE_IDLE_MS } from './auth-store.ts';
import { STAFF_IDLE_MS, STAFF_MAX_MS } from './staff-binding.ts';

/** The SQL behind the scan grant checks (`authority-checks.ts`, `scan-pass-checks.ts`, `scan-write-grant.ts`). */

/** A paired device must have been seen within the idle window. */
export const deviceAwakeCheck = (scannerId: string, now: number): Check =>
  rawCheck(
    'actor',
    `EXISTS (SELECT 1 FROM scanners s WHERE s.id = ? AND COALESCE(s.last_seen_at, s.paired_at, ?) + ? > ?)`,
    [scannerId, now, DEVICE_IDLE_MS, now],
  );

/** No staff was derived: the device must still have no valid binding (none, expired or disabled). */
export const noStaffBindingCheck = (scannerId: string, now: number): Check =>
  rawCheck(
    'staff',
    `NOT EXISTS (SELECT 1 FROM scanners s WHERE s.id = ? AND s.staff_id IS NOT NULL
              AND COALESCE(s.staff_seen_at >= ?, 0) AND COALESCE(s.staff_since >= ?, 0)
              AND EXISTS (SELECT 1 FROM scan_staff st WHERE st.id = s.staff_id AND st.disabled_at IS NULL))`,
    [scannerId, now - STAFF_IDLE_MS, now - STAFF_MAX_MS],
  );

export const sessionAcceptsTemplateCheck = (sessionId: string, templateId: string): Check =>
  rawCheck(
    'config',
    `EXISTS (SELECT 1 FROM scanning_sessions ss, json_each(ss.accepts, '$.templateIds') j
            WHERE ss.id = ? AND j.value = ?)`,
    [sessionId, templateId],
  );

export const scannerTemplateCheck = (scannerId: string, templateId: string): Check =>
  rawCheck(
    'config',
    `EXISTS (SELECT 1 FROM scanner_templates st WHERE st.scanner_id = ? AND st.template_id = ?)`,
    [scannerId, templateId],
  );

export const noScannerTemplatesCheck = (scannerId: string): Check =>
  rawCheck('config', `NOT EXISTS (SELECT 1 FROM scanner_templates st WHERE st.scanner_id = ?)`, [
    scannerId,
  ]);

export const noPendingTransferCheck = (passId: string): Check =>
  rawCheck(
    'lineage',
    `NOT EXISTS (SELECT 1 FROM pass_credential_transfers x WHERE x.pass_id = ? AND x.state = 'pending')`,
    [passId],
  );

/** The template must exist for the actor's org (archived is fine, use does not need the head); a reassignment is caught here. */
export const passTemplateUsableCheck = (passId: string): Check =>
  tenantCheck(
    'lineage',
    `EXISTS (SELECT 1 FROM passes p JOIN templates t ON t.id = p.template_id
        WHERE p.id = ? AND t.status != 'deleted' AND (t.org_id IS NULL OR t.org_id = {org}))`,
    [passId],
  );

/** None of the presented credential's references may be retired by a transfer, in this mode or the other. */
export function credentialRefChecks(refs?: {
  current: readonly string[];
  other: readonly string[];
}): Check[] {
  const sql = (mode: string) => `NOT EXISTS (SELECT 1 FROM pass_credential_tombstones x
    WHERE x.org_id = {org} AND x.mode = ${mode} AND x.credential_hash IN (SELECT value FROM json_each(?)))`;
  return [
    ...(refs?.current.length
      ? [tenantCheck('lineage', sql('{mode}'), [JSON.stringify(refs.current)])]
      : []),
    ...(refs?.other.length
      ? [
          tenantCheck('lineage', sql("(CASE {mode} WHEN 'live' THEN 'test' ELSE 'live' END)"), [
            JSON.stringify(refs.other),
          ]),
        ]
      : []),
  ];
}

/** The current holder of a gate, named for a heads-up that lost the race. */
export const holderPart = (gate: { passId: string; actionId: string; scope: string }): GrantPart =>
  readPart(
    `SELECT g.state AS gate_state, g.last_at, g.last_scan_id AS gate_scan_id, g.count AS gate_count,
       s.id AS scan_id, s.at, s.state AS scan_state, s.action_id, s.scanner_id, s.staff_id,
       s.override_of, s.undone_by, sc.name AS scanner_name, st.name AS staff_name
     FROM scan_gates g LEFT JOIN scans s ON s.id = g.last_scan_id AND s.org_id = {org}
     LEFT JOIN scanners sc ON sc.id = s.scanner_id AND sc.org_id = {org}
     LEFT JOIN scan_staff st ON st.id = s.staff_id AND st.org_id = {org}
     WHERE g.pass_id = ? AND g.action_id = ? AND g.scope = ? AND g.org_id = {org}`,
    [gate.passId, gate.actionId, gate.scope],
  );

/** The scan closed (any outcome): what post-commit work for a heads-up is gated on. */
export const doneScanPredicate = (scanId: string) => ({
  sql: `EXISTS (SELECT 1 FROM scans q WHERE q.id = ? AND q.state = 'done')`,
  params: [scanId],
});

/** A scan row is closed with this outcome: what the post-commit work (counts, display, photo) is gated on. */
export const doneOkPredicate = (scanId: string) => ({
  sql: `EXISTS (SELECT 1 FROM scans q WHERE q.id = ? AND q.state = 'done' AND q.outcome = 'ok')`,
  params: [scanId],
});
