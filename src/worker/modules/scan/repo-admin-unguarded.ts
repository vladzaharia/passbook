import type { Grant, GrantedStatement } from '../../platform/authority.ts';
import { inList } from '../../platform/authority-expr.ts';
import { writePart } from '../../platform/authority-include.ts';
import type { SqlValue } from '../../platform/db.ts';

/**
 * A write to a table the builder does not guard (`scanner_setups`) that still commits only in its
 * grant's batch. `{grant}` is the grant-row predicate, `{org}` and `{mode}` the grant's tenant. Every part
 * ties its rows to the tenant itself; the grants are `org_mode`.
 */
function grantedSql(g: Grant, sql: string, params: SqlValue[] = []): GrantedStatement {
  const [statement] = g.include(writePart(sql, params));
  if (!statement) throw new Error('A part adds one statement.');
  return statement;
}

/**
 * Template links are a guarded child of `scanners` (their triggers move the scanner's config epoch):
 * each write reaches the link through a scanner in the grant's org and mode.
 */
export const addScannerTemplates = (
  g: Grant,
  scannerId: string,
  templateIds: readonly string[],
): GrantedStatement[] =>
  templateIds.map((templateId) =>
    g.insertJoined('scanner_templates', {
      parents: { scanner_id: scannerId },
      columns: ['template_id'],
      values: [templateId],
    }),
  );

export const replaceScannerTemplates = (
  g: Grant,
  scannerId: string,
  templateIds: readonly string[],
): GrantedStatement[] => [
  g.joined('scanner_templates', { where: { scanner_id: scannerId }, delete: true }),
  ...addScannerTemplates(g, scannerId, templateIds),
];

/** These scanners drop their own template lists (an archive, a move onto an event). `in` takes 20 at a time. */
export function clearTemplatesOfScanners(g: Grant, ids: readonly string[]): GrantedStatement[] {
  const out: GrantedStatement[] = [];
  for (let at = 0; at < ids.length; at += 20)
    out.push(
      g.joined('scanner_templates', {
        where: { scanner_id: inList(ids.slice(at, at + 20)) },
        delete: true,
      }),
    );
  return out;
}

/** The template lists of a session's devices (the set the grant checks) follow the session's scope. */
export const setSessionDeviceTemplates = (
  g: Grant,
  scannerIds: readonly string[],
  templateIds: readonly string[],
): GrantedStatement[] => [
  ...clearTemplatesOfScanners(g, scannerIds),
  ...scannerIds.flatMap((id) => addScannerTemplates(g, id, templateIds)),
];

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
