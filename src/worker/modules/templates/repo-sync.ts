import { placeholders, stmt } from '../../platform/db.ts';

export interface BakedTemplateRow {
  id: string;
  orgSlug: string | null;
  slug: string;
  name: string;
  description: string | null;
  version: string;
  styles: unknown;
  now: number;
}

export function upsertBakedTemplateStmt(db: D1Database, t: BakedTemplateRow): D1PreparedStatement {
  return stmt(
    db,
    `INSERT INTO templates (id, org_id, slug, name, description, origin, active_version, status, styles, created_at, updated_at)
     VALUES (?, (SELECT id FROM orgs WHERE slug = ?), ?, ?, ?, 'baked', ?, 'active', ?, ?, ?)
     ON CONFLICT (id) DO UPDATE SET name = excluded.name,
       description = excluded.description, active_version = excluded.active_version,
       status = 'active', styles = excluded.styles, updated_at = excluded.updated_at`,
    [
      t.id,
      t.orgSlug,
      t.slug,
      t.name,
      t.description,
      t.version,
      JSON.stringify(t.styles),
      t.now,
      t.now,
    ],
  );
}

/** Baked templates that left the build are archived, not deleted. */
export function archiveStaleBakedStmt(
  db: D1Database,
  keepIds: readonly string[],
  now: number,
): D1PreparedStatement {
  return stmt(
    db,
    `UPDATE templates SET status = 'archived', updated_at = ?
     WHERE origin = 'baked' AND status = 'active'${keepIds.length ? ` AND id NOT IN (${placeholders(keepIds.length)})` : ''}`,
    [now, ...keepIds],
  );
}
