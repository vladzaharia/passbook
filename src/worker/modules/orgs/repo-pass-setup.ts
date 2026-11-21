import type { Mode } from '../../../shared/contracts/common.ts';
import { all, first } from '../../platform/db.ts';
import { COUNT_CAP } from './repo.ts';

export const TEMPLATE_CAP = 200;

export interface SetupTemplateRow {
  id: string;
  name: string;
  active_version: string | null;
  /** The active version's stored asset list (JSON), when it has one. */
  assets: string | null;
  /** The active version's manifest `brand` block (JSON object text), when it has one. */
  brand: string | null;
}

/** The org's own live templates for the page: no blueprints, archived or deleted ones. */
export function setupTemplateRows(db: D1Database, orgId: string): Promise<SetupTemplateRow[]> {
  return all<SetupTemplateRow>(
    db,
    `SELECT t.id, t.name, t.active_version, v.assets,
       CASE WHEN json_type(v.manifest, '$.brand') = 'object'
         THEN json_extract(v.manifest, '$.brand') END AS brand
     FROM templates t LEFT JOIN template_versions v
       ON v.template_id = t.id AND v.version = t.active_version
     WHERE t.org_id = ? AND t.status = 'active' AND t.blueprint = 0
     ORDER BY t.name, t.id LIMIT ?`,
    [orgId, TEMPLATE_CAP],
  );
}

/** Every template policy of the org in `mode`, by template id. */
export async function policiesOf(
  db: D1Database,
  orgId: string,
  mode: Mode,
): Promise<Map<string, string>> {
  const rows = await all<{ template_id: string; channels: string }>(
    db,
    'SELECT template_id, channels FROM template_channel_policies WHERE org_id = ? AND mode = ?',
    [orgId, mode],
  );
  return new Map(rows.map((r) => [r.template_id, r.channels]));
}

/** The mode's passes, counted up to the cap. */
export async function passCountOf(db: D1Database, orgId: string, mode: Mode): Promise<number> {
  const row = await first<{ n: number }>(
    db,
    `SELECT count(*) AS n FROM
       (SELECT 1 FROM passes WHERE org_id = ? AND mode = ? AND deleted_at IS NULL LIMIT ${COUNT_CAP})`,
    [orgId, mode],
  );
  return row?.n ?? 0;
}

/** Passes of the mode signed with PassBook's shared identity, counted up to the cap. */
export async function sharedPassCountOf(
  db: D1Database,
  orgId: string,
  mode: Mode,
): Promise<number> {
  const row = await first<{ n: number }>(
    db,
    `SELECT count(*) AS n FROM
       (SELECT 1 FROM passes p JOIN signing_identities i ON i.id = p.identity_id
        WHERE p.org_id = ? AND p.mode = ? AND p.deleted_at IS NULL AND i.provenance = 'platform'
        LIMIT ${COUNT_CAP})`,
    [orgId, mode],
  );
  return row?.n ?? 0;
}

export async function apnsHealthOf(
  db: D1Database,
  identityId: string,
): Promise<'unknown' | 'healthy' | 'failing'> {
  const row = await first<{ apns_health: 'unknown' | 'healthy' | 'failing' }>(
    db,
    'SELECT apns_health FROM signing_identities WHERE id = ?',
    [identityId],
  );
  return row?.apns_health ?? 'unknown';
}

/** The mode's passes issued from these templates, counted up to the cap. */
export async function passesOnTemplates(
  db: D1Database,
  orgId: string,
  mode: Mode,
  templateIds: readonly string[],
): Promise<number> {
  const row = await first<{ n: number }>(
    db,
    `SELECT count(*) AS n FROM
       (SELECT 1 FROM passes WHERE org_id = ? AND mode = ? AND deleted_at IS NULL
          AND template_id IN (SELECT value FROM json_each(?)) LIMIT ${COUNT_CAP})`,
    [orgId, mode, JSON.stringify(templateIds)],
  );
  return row?.n ?? 0;
}
