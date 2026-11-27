import { all, batch, stmt } from '../../platform/db.ts';
import { listPassesSql, type PassListFilter } from './repo-list.ts';
import { mapPass, PASS_SELECT, type Pass, type PassDbRow } from './repo-map.ts';

/**
 * Newest first across organizations: one indexed branch per organization (`passes_org_mode`, no sort),
 * read in one round trip and merged here. Each branch holds its own newest `limit + 1` ids below the cursor,
 * so the newest `limit + 1` overall lie in their union. Only ids come from the branches; the page's rows are
 * read in a second query, so a wide list never pulls orgs x (limit + 1) full rows.
 */
export async function listPassBranches(
  db: D1Database,
  orgIds: readonly string[],
  filter: PassListFilter,
): Promise<{ items: Pass[]; nextCursor: string | null }> {
  const results = await batch(
    db,
    orgIds.map((orgId) => {
      const { sql, params } = listPassesSql({ ...filter, orgId }, true);
      return stmt(db, sql, params);
    }),
  );
  const ids = results
    .flatMap((r) => (r.results as { id: string }[]).map((row) => row.id))
    .sort((a, b) => (a < b ? 1 : a > b ? -1 : 0));
  const pageIds = ids.slice(0, filter.limit);
  const last = pageIds.at(-1);
  const nextCursor = ids.length > filter.limit && last ? last : null;
  if (pageIds.length === 0) return { items: [], nextCursor };
  const rows = await passesByIds(db, orgIds, pageIds);
  return { items: rows.map(mapPass), nextCursor };
}

/** The rows of these pass ids, newest first, and only those in `orgIds`: the second read keeps the first's tenant bound. */
export function passesByIds(
  db: D1Database,
  orgIds: readonly string[],
  ids: readonly string[],
): Promise<PassDbRow[]> {
  return all<PassDbRow>(
    db,
    `${PASS_SELECT} WHERE id IN (SELECT value FROM json_each(?))
       AND org_id IN (SELECT value FROM json_each(?)) ORDER BY id DESC`,
    [JSON.stringify(ids), JSON.stringify(orgIds)],
  );
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
