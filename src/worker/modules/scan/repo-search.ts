import { all, likeEscape, placeholders, type SqlValue } from '../../platform/db.ts';
import type { ScanActor } from './actor.ts';

interface SearchRow {
  id: string;
  title: string | null;
  subtitle: string | null;
  status: string;
  removed_at: number | null;
  holder_email: string | null;
  template_name: string;
  pass_json: string | null;
  last_scan_at: number | null;
}

/** Scope is applied in SQL before the eleven-row cap. Search strings never leave the body. */
export function searchPasses(
  db: D1Database,
  actor: ScanActor,
  q: string,
  email: boolean,
  keys?: { scanCode: string | null; barcodeHash: string; lookupHash: string },
): Promise<SearchRow[]> {
  if (
    actor.scanner?.deviceRole === 'scan' &&
    !actor.templateIds.length &&
    !actor.settings.acceptAllTemplates
  )
    return Promise.resolve([]);
  const where = ['p.org_id = ?', 'p.mode = ?', 'p.deleted_at IS NULL'];
  const params: SqlValue[] = [actor.orgId, actor.mode];
  if (actor.templateIds.length) {
    where.push(`p.template_id IN (${placeholders(actor.templateIds.length)})`);
    params.push(...actor.templateIds);
  }
  if (actor.event?.matchInput && actor.event.matchValues) {
    const values = JSON.parse(actor.event.matchValues) as string[];
    where.push(
      `CAST(json_extract(p.personalization, ?) AS TEXT) IN (${placeholders(values.length)})`,
    );
    params.push(`$.${actor.event.matchInput}`, ...values);
  }
  if (email) {
    where.push('p.holder_email = ?');
    params.push(q);
  } else {
    const matches = [
      "SELECT id FROM passes WHERE org_id = ? AND display_title LIKE ? ESCAPE '\\' COLLATE NOCASE",
      "SELECT id FROM passes WHERE org_id = ? AND display_subtitle LIKE ? ESCAPE '\\' COLLATE NOCASE",
    ];
    params.push(actor.orgId, `${likeEscape(q)}%`, actor.orgId, `${likeEscape(q)}%`);
    if (keys) {
      matches.push(
        'SELECT id FROM passes WHERE org_id = ? AND (scan_code = ? OR barcode_hash = ? OR lookup_hash = ?)',
      );
      params.push(actor.orgId, keys.scanCode, keys.barcodeHash, keys.lookupHash);
    }
    where.push(`p.id IN (${matches.join(' UNION ')})`);
  }

  return all<SearchRow>(
    db,
    `SELECT p.id, p.display_title AS title, p.display_subtitle AS subtitle, p.status,
    p.removed_at, p.holder_email, t.name AS template_name,
    (SELECT pass_json FROM pass_versions v WHERE v.pass_id = p.id ORDER BY version DESC LIMIT 1) AS pass_json,
    (SELECT max(at) FROM scans s WHERE s.pass_id = p.id AND s.org_id = p.org_id AND s.mode = p.mode AND s.state = 'done') AS last_scan_at
    FROM passes p JOIN templates t ON t.id = p.template_id
    WHERE ${where.join(' AND ')} ORDER BY p.display_title COLLATE NOCASE, p.id LIMIT 11`,
    params,
  );
}
