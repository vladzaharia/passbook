import type { SqlValue } from '../../platform/db.ts';
import { issuedReleasePredicateSql } from '../templates/repo-releases.ts';
import { HEADS_UP_SQL, REFUSED_SQL } from './outcome-bucket.ts';
import type { ScanLogFilter } from './repo-feed.ts';
import { scanPasslessCandidateSql } from './repo-scan-passless.ts';
import { scanRetentionCandidateSql, scanRetentionExcludedSql } from './repo-scan-retention.ts';

// Historical rows may outlive the pass or its current policy. Foreign or quarantined passes
// and invalid non-null issuance pins are never ledger-visible.
function availablePass(scan: string): string {
  const pass = `${scan}_ledger_pass`;
  return `EXISTS (
    SELECT 1 FROM passes ${pass} WHERE (
      ${pass}.id = ${scan}.pass_id AND ${pass}.org_id = ${scan}.org_id AND ${pass}.mode = ${scan}.mode
      AND (${scan}.template_id IS NULL OR ${scan}.template_id = ${pass}.template_id)
    ) AND (
      NOT EXISTS (SELECT 1 FROM templates ledger_template
        WHERE ledger_template.id = ${pass}.template_id AND ledger_template.org_id IS NOT NULL
          AND ledger_template.org_id != ${pass}.org_id)
      AND NOT EXISTS (SELECT 1 FROM connections ledger_connection
        WHERE ledger_connection.id = ${pass}.connection_id AND ledger_connection.org_id != ${pass}.org_id)
      AND NOT EXISTS (SELECT 1 FROM signing_identities ledger_identity
        WHERE ledger_identity.id = ${pass}.identity_id AND ledger_identity.org_id IS NOT NULL
          AND ledger_identity.org_id != ${pass}.org_id)
    ) AND ${pass}.test_data_quarantined = 0
      AND (${pass}.release_id IS NULL OR ${issuedReleasePredicateSql(
        {
          releaseIdSql: `${pass}.release_id`,
          versionSql: `${pass}.template_version`,
        },
        {
          templateIdSql: `${pass}.template_id`,
          orgIdSql: `${pass}.org_id`,
          modeSql: `${pass}.mode`,
          providerSql: "'apple'",
        },
      )})
  )`;
}

// A missing scanner remains ledger history, but an existing foreign scanner must not leak
// through the mandatory actor id in any list, detail, cursor or export count.
function availableActor(scan: string): string {
  const actor = `${scan}_ledger_actor`;
  return `(${scan}.actor_type != 'scanner' OR NOT EXISTS (
    SELECT 1 FROM scanners ${actor} WHERE ${actor}.id = ${scan}.actor_id
      AND (${actor}.org_id != ${scan}.org_id OR ${actor}.mode != ${scan}.mode)
  ))`;
}

// Missing references retain history; existing foreign or cross-pass links cannot authorize it.
function availableReferences(scan: string): string {
  const ref = `${scan}_ledger_ref`;
  return `(
    NOT EXISTS (SELECT 1 FROM templates ${ref} WHERE ${ref}.id = ${scan}.template_id
      AND ${ref}.org_id IS NOT NULL AND ${ref}.org_id != ${scan}.org_id)
    AND NOT EXISTS (SELECT 1 FROM scan_events ${ref} WHERE ${ref}.id = ${scan}.event_id
      AND (${ref}.org_id != ${scan}.org_id OR ${ref}.mode != ${scan}.mode))
    AND NOT EXISTS (SELECT 1 FROM scanners ${ref} WHERE ${ref}.id = ${scan}.scanner_id
      AND (${ref}.org_id != ${scan}.org_id OR ${ref}.mode != ${scan}.mode))
    AND NOT EXISTS (SELECT 1 FROM scan_staff ${ref}
      WHERE (${ref}.id = ${scan}.staff_id OR ${ref}.id = ${scan}.approved_by)
        AND ${ref}.org_id != ${scan}.org_id)
    AND NOT EXISTS (SELECT 1 FROM scans ${ref}
      WHERE (${ref}.id = ${scan}.undoes OR ${ref}.id = ${scan}.undone_by OR ${ref}.id = ${scan}.override_of)
        AND (${ref}.org_id != ${scan}.org_id OR ${ref}.mode != ${scan}.mode
          OR ${ref}.pass_id IS NOT ${scan}.pass_id))
  )`;
}

// Keep these shared between the full ledger scope and staged success counts.
function ledgerScopeStart(scan: string): string {
  return `${scan}.state = 'done' AND NOT (${scanRetentionExcludedSql(scan)})`;
}

function ledgerScopeEnd(scan: string): string {
  return `${availableActor(scan)} AND ${availableReferences(scan)}`;
}

/** Common ledger guards; must be paired with an appropriate candidate predicate. */
export function scanLedgerCommonScopeSql(scan: string): string {
  return `(${ledgerScopeStart(scan)} AND ${ledgerScopeEnd(scan)})`;
}

/** Pass-bound and retained ledger candidates, excluding passless refusals. */
export function scanLedgerPassOrRetentionCandidateSql(scan: string): string {
  return `(${availablePass(scan)} OR ${scanRetentionCandidateSql(scan)})`;
}

/** Use only for rows already restricted to outcome='ok'; passless candidates are refused. */
export function scanLedgerSuccessfulCandidateSql(scan: string): string {
  return scanLedgerPassOrRetentionCandidateSql(scan);
}

/** Parameter-free ledger scope for a trusted static scan alias. */
export function scanLedgerScopeSql(scan: string): string {
  return `(${ledgerScopeStart(scan)} AND
    (${availablePass(scan)} OR ${scanPasslessCandidateSql(scan)} OR ${scanRetentionCandidateSql(scan)})
    AND ${ledgerScopeEnd(scan)})`;
}

type ScopedReference = {
  table: 'scanners' | 'scan_staff' | 'scan_events';
  field: 'scanner_id' | 'staff_id' | 'event_id';
  mode: boolean;
};

/** A filtered optional reference must be one the response can actually expose. */
const scopedReferenceSql = (scan: 's' | 'cs', ref: ScopedReference) => `EXISTS (
  SELECT 1 FROM ${ref.table} x WHERE x.id = ${scan}.${ref.field} AND x.org_id = ${scan}.org_id
    ${ref.mode ? `AND x.mode = ${scan}.mode` : ''}
    ${ref.table === 'scan_events' ? `AND (${scan}.pass_id IS NOT NULL OR x.archived_at IS NULL)` : ''}
)`;
/**
 * The filter conditions over `s`, without the tenant: the org and mode come from the fence of the
 * statement (`auth.tenantOnce`), never from the request. A scanner, staff, event or pass filter rides
 * its own index; callers without an org narrow the mode with `+s.mode` so the planner keeps it.
 * Position continuation is the decoded `(at, id)` of a row of the same snapshot.
 */
export function where(f: ScanLogFilter): { sql: string; params: SqlValue[] } {
  const clauses = [scanLedgerScopeSql('s')];
  const params: SqlValue[] = [];
  const eq = (column: string, value: string | undefined) => {
    if (value === undefined) return;
    clauses.push(`${column} = ?`);
    params.push(value);
  };
  const references = [
    { table: 'scanners', field: 'scanner_id', mode: true, value: f.scannerId },
    { table: 'scan_staff', field: 'staff_id', mode: false, value: f.staffId },
    { table: 'scan_events', field: 'event_id', mode: true, value: f.eventId },
  ] as const;
  for (const ref of references) {
    if (ref.value === undefined) continue;
    clauses.push(`s.${ref.field} = ? AND ${scopedReferenceSql('s', ref)}`);
    params.push(ref.value);
  }
  // A pass type of this org (or a baked one): another org's template id matches no row.
  if (f.templateId !== undefined) {
    clauses.push(`s.template_id = ? AND EXISTS (
      SELECT 1 FROM templates ft WHERE ft.id = s.template_id AND (ft.org_id IS NULL OR ft.org_id = s.org_id))`);
    params.push(f.templateId);
  }
  eq('s.pass_id', f.passId);
  if (f.outcome === 'undone') clauses.push('s.undone_at IS NOT NULL');
  else if (f.outcome === 'refused') clauses.push(REFUSED_SQL);
  else if (f.outcome === 'heads_up') clauses.push(HEADS_UP_SQL);
  else eq('s.outcome', f.outcome);
  // Name searches are projected in the service before pagination; repository callers may still
  // select an exact pass id without consulting the untrusted cached display title.
  if (f.q) eq('s.pass_id', f.q);
  eq('s.reason', f.reason);
  if (f.from !== undefined) {
    clauses.push('s.at >= ?');
    params.push(f.from);
  }
  if (f.to !== undefined) {
    clauses.push('s.at <= ?');
    params.push(f.to);
  }
  if (f.internalCursor) {
    clauses.push('(s.at, s.id) < (?, ?)');
    params.push(f.internalCursor.at, f.internalCursor.id);
  }
  return { sql: clauses.join(' AND '), params };
}
