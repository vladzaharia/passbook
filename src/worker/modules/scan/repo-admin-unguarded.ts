import type { Grant, GrantedStatement } from '../../platform/authority.ts';
import { writePart } from '../../platform/authority-include.ts';
import type { SqlValue } from '../../platform/db.ts';

/**
 * A write to a table the builder does not guard (`scanner_templates`, `scanner_setups`) that still
 * commits only in its grant's batch. `{grant}` is the grant-row predicate, `{org}` and `{mode}` the grant's
 * tenant. Every part ties its rows to the tenant itself; the grants are `org_mode`.
 */
function grantedSql(g: Grant, sql: string, params: SqlValue[] = []): GrantedStatement {
  const [statement] = g.include(writePart(sql, params));
  if (!statement) throw new Error('A part adds one statement.');
  return statement;
}

/** The scanner is in the grant's org and mode, so its template links may follow (an `org_mode` grant). */
export function addScannerTemplates(
  g: Grant,
  scannerId: string,
  templateIds: readonly string[],
): GrantedStatement[] {
  if (templateIds.length === 0) return [];
  return [
    grantedSql(
      g,
      `INSERT INTO scanner_templates (scanner_id, template_id)
       SELECT s.id, j.value FROM scanners s, json_each(?) j
       WHERE s.id = ? AND s.org_id = {org} AND s.mode = {mode} AND {grant}`,
      [JSON.stringify(templateIds), scannerId],
    ),
  ];
}

export const replaceScannerTemplates = (
  g: Grant,
  scannerId: string,
  templateIds: readonly string[],
): GrantedStatement[] => [
  grantedSql(
    g,
    `DELETE FROM scanner_templates WHERE scanner_id IN
       (SELECT s.id FROM scanners s WHERE s.id = ? AND s.org_id = {org} AND s.mode = {mode})
     AND {grant}`,
    [scannerId],
  ),
  ...addScannerTemplates(g, scannerId, templateIds),
];

/** An archive ends the template lists of the scanners that were on the event. */
export const clearTemplatesOfEventScanners = (g: Grant, eventId: string): GrantedStatement =>
  grantedSql(
    g,
    `DELETE FROM scanner_templates WHERE scanner_id IN
       (SELECT s.id FROM scanners s WHERE s.event_id = ? AND s.org_id = {org} AND s.mode = {mode})
     AND {grant}`,
    [eventId],
  );

/** Scanners of the grant's org and mode moved onto an event drop their own template lists. */
export const clearTemplatesOfScanners = (g: Grant, ids: readonly string[]): GrantedStatement =>
  grantedSql(
    g,
    `DELETE FROM scanner_templates WHERE scanner_id IN
       (SELECT s.id FROM scanners s WHERE s.org_id = {org} AND s.mode = {mode}
          AND s.id IN (SELECT value FROM json_each(?)))
     AND {grant}`,
    [JSON.stringify(ids)],
  );

/** The template lists of a session's devices follow the session's scope. */
export function setSessionDeviceTemplates(
  g: Grant,
  sessionId: string,
  templateIds: readonly string[],
): GrantedStatement[] {
  return [
    grantedSql(
      g,
      `DELETE FROM scanner_templates WHERE scanner_id IN
         (SELECT d.scanner_id FROM scanning_devices d
          WHERE d.session_id = ? AND d.org_id = {org} AND d.mode = {mode})
       AND {grant}`,
      [sessionId],
    ),
    grantedSql(
      g,
      `INSERT INTO scanner_templates (scanner_id, template_id)
       SELECT d.scanner_id, t.value FROM scanning_devices d, json_each(?) t
       WHERE d.session_id = ? AND d.org_id = {org} AND d.mode = {mode} AND {grant}`,
      [JSON.stringify(templateIds), sessionId],
    ),
  ];
}

export const addSetupInsert = (
  g: Grant,
  scannerId: string,
  _mode: string,
  userId: string | null,
  watch: unknown,
): GrantedStatement =>
  grantedSql(
    g,
    `INSERT INTO scanner_setups(scanner_id, org_id, mode, admin_session, admin_user_id, watch)
     SELECT ?, {org}, {mode}, ?, ?, ? WHERE {grant}`,
    [scannerId, userId ? 1 : 0, userId, watch ? JSON.stringify(watch) : null],
  );

export const addSetupWatch = (g: Grant, scannerId: string, watch: unknown): GrantedStatement =>
  grantedSql(
    g,
    `INSERT INTO scanner_setups(scanner_id, org_id, mode, watch)
     SELECT id, {org}, {mode}, ? FROM scanners WHERE org_id = {org} AND mode = {mode} AND id = ? AND {grant}
     ON CONFLICT(scanner_id) DO UPDATE SET watch = excluded.watch`,
    [watch ? JSON.stringify(watch) : null, scannerId],
  );
