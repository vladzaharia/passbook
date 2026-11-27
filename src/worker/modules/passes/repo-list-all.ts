import { all, batch, stmt } from '../../platform/db.ts';
import { listPassesSql, type PassListFilter } from './repo-list.ts';
import { mapPass, type Pass, type PassDbRow } from './repo-map.ts';

/**
 * Newest first across organizations: one indexed branch per organization (`passes_org_mode`, no sort),
 * read in one round trip and merged here. Each branch holds its own newest `limit + 1` below the cursor,
 * so the newest `limit + 1` overall lie in their union.
 */
export async function listPassBranches(
  db: D1Database,
  orgIds: readonly string[],
  filter: PassListFilter,
): Promise<{ items: Pass[]; nextCursor: string | null }> {
  const results = await batch(
    db,
    orgIds.map((orgId) => {
      const { sql, params } = listPassesSql({ ...filter, orgId });
      return stmt(db, sql, params);
    }),
  );
  const rows = results
    .flatMap((r) => r.results as PassDbRow[])
    .sort((a, b) => (a.id < b.id ? 1 : a.id > b.id ? -1 : 0));
  const page = rows.slice(0, filter.limit).map(mapPass);
  const last = page.at(-1);
  return { items: page, nextCursor: rows.length > filter.limit && last ? last.id : null };
}

export interface OrgLabel {
  id: string;
  name: string;
  personal_user_id: string | null;
  time_zone: string | null;
}

/** Name, personal owner and time zone of the page's organizations, and its templates' names. */
export async function pageLabels(
  db: D1Database,
  orgIds: readonly string[],
  templateIds: readonly string[],
): Promise<{ orgs: OrgLabel[]; templates: { id: string; name: string }[] }> {
  const [orgs, templates] = await Promise.all([
    all<OrgLabel>(
      db,
      `SELECT o.id, o.name, o.personal_user_id,
              (SELECT json_extract(s.value, '$') FROM settings s
                WHERE s.scope = 'org:' || o.id AND s.key = 'org.timeZone') AS time_zone
       FROM orgs o WHERE o.id IN (SELECT value FROM json_each(?))`,
      [JSON.stringify(orgIds)],
    ),
    all<{ id: string; name: string }>(
      db,
      'SELECT id, name FROM templates WHERE id IN (SELECT value FROM json_each(?))',
      [JSON.stringify(templateIds)],
    ),
  ]);
  return { orgs, templates };
}
