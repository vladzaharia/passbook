import type { TagType } from '../../../shared/contracts/nfc-tag-admin.ts';
import type { Grant } from '../../platform/authority.ts';
import { all, first } from '../../platform/db.ts';

type Db = D1Database;

interface Raw {
  id: string;
  system: TagType['system'];
  name: string;
  use: TagType['use'];
  scopes: TagType['scopes'];
  per_pass: number;
  binding_days: number | null;
  confirm: TagType['confirm'];
  typed: number;
  version: number;
  tag_count: number;
  created_at: number;
  updated_at: number;
  archived_at: number | null;
}

const SELECT = `SELECT y.id, y.system, y.name, y.use, y.scopes, y.per_pass, y.binding_days, y.confirm, y.typed,
    y.version, y.created_at, y.updated_at, y.archived_at,
    (SELECT COUNT(*) FROM nfc_tags t WHERE t.type_id = y.id AND t.status = 'active') AS tag_count
  FROM nfc_tag_types y`;

function view(r: Raw, templateIds: string[]): TagType {
  return {
    id: r.id,
    system: r.system,
    name: r.name,
    use: r.use,
    scopes: r.scopes,
    perPass: r.per_pass,
    bindingDays: r.binding_days,
    confirm: r.confirm,
    typed: r.typed === 1,
    templateIds,
    version: r.version,
    tagCount: r.tag_count,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    archivedAt: r.archived_at,
  };
}

/** One page of the org's types, oldest first (ids are time-ordered). */
export async function listTagTypes(
  db: Db,
  orgId: string,
  page: { cursor?: string | undefined; limit: number },
): Promise<{ items: TagType[]; nextCursor: string | null }> {
  const rows = await all<Raw>(
    db,
    `${SELECT} WHERE y.org_id = ? AND y.id > ? ORDER BY y.id LIMIT ?`,
    [orgId, page.cursor ?? '', page.limit + 1],
  );
  const more = rows.length > page.limit;
  const slice = rows.slice(0, page.limit);
  return {
    items: await withTemplates(db, slice),
    nextCursor: more ? (slice[slice.length - 1]?.id ?? null) : null,
  };
}

async function withTemplates(db: Db, rows: Raw[]): Promise<TagType[]> {
  if (rows.length === 0) return [];
  const links = await all<{ type_id: string; template_id: string }>(
    db,
    `SELECT type_id, template_id FROM nfc_tag_type_templates
     WHERE type_id IN (${rows.map(() => '?').join(', ')}) ORDER BY template_id`,
    rows.map((r) => r.id),
  );
  return rows.map((r) =>
    view(
      r,
      links.filter((l) => l.type_id === r.id).map((l) => l.template_id),
    ),
  );
}

/** The org's types of one system that take new tags (not archived). An org has a handful. */
export const activeTypesOfSystem = (db: Db, orgId: string, system: string): Promise<TagType[]> =>
  all<Raw>(
    db,
    `${SELECT} WHERE y.org_id = ? AND y.system = ? AND y.archived_at IS NULL ORDER BY y.id LIMIT 200`,
    [orgId, system],
  ).then((rows) => withTemplates(db, rows));

/** Active pass-scope bindings on the pass whose tag has this type, not counting the binding a bind ends. */
export async function passTypeCount(
  db: Db,
  passId: string,
  typeId: string,
  ending: string | null,
): Promise<number> {
  return (
    (
      await first<{ n: number }>(
        db,
        `SELECT count(*) AS n FROM tag_bindings b JOIN nfc_tags t ON t.id = b.tag_id
         WHERE b.pass_id = ? AND b.scope = 'pass' AND b.ended_at IS NULL AND t.type_id = ? AND b.id IS NOT ?`,
        [passId, typeId, ending],
      )
    )?.n ?? 0
  );
}

/** By id, fenced by the org: another org's type reads as absent. */
export async function getTagType(db: Db, orgId: string, id: string): Promise<TagType | null> {
  const row = await first<Raw>(db, `${SELECT} WHERE y.id = ? AND y.org_id = ?`, [id, orgId]);
  if (!row) return null;
  const links = await all<{ template_id: string }>(
    db,
    'SELECT template_id FROM nfc_tag_type_templates WHERE type_id = ? ORDER BY template_id',
    [id],
  );
  return view(
    row,
    links.map((l) => l.template_id),
  );
}

/** The org a type belongs to, before any authority exists for it. */
export async function tagTypeOrg(db: Db, id: string): Promise<string | null> {
  return (
    (await first<{ org_id: string }>(db, 'SELECT org_id FROM nfc_tag_types WHERE id = ?', [id]))
      ?.org_id ?? null
  );
}

/** How many of these templates are live templates of the org. */
export async function countOrgTemplates(
  db: Db,
  orgId: string,
  ids: readonly string[],
): Promise<number> {
  if (ids.length === 0) return 0;
  const marks = ids.map(() => '?').join(', ');
  return (
    (
      await first<{ n: number }>(
        db,
        `SELECT COUNT(*) AS n FROM templates WHERE org_id = ? AND status <> 'deleted' AND id IN (${marks})`,
        [orgId, ...ids],
      )
    )?.n ?? 0
  );
}

export async function systemEnabled(db: Db, system: string): Promise<boolean> {
  return (
    (
      await first<{ enabled: number }>(db, 'SELECT enabled FROM nfc_tag_systems WHERE id = ?', [
        system,
      ])
    )?.enabled === 1
  );
}

/** Whether a tag type names the template; `live` counts types that are not archived. */
export async function tagTypeNamesTemplate(
  db: Db,
  templateId: string,
  live: boolean,
): Promise<boolean> {
  return (
    (await first<{ one: number }>(
      db,
      `SELECT 1 AS one FROM nfc_tag_type_templates tt JOIN nfc_tag_types y ON y.id = tt.type_id
       WHERE tt.template_id = ?${live ? ' AND y.archived_at IS NULL' : ''} LIMIT 1`,
      [templateId],
    )) !== null
  );
}

export interface NewTagType {
  id: string;
  system: string;
  name: string;
  use: string;
  scopes: string;
  perPass: number;
  bindingDays: number | null;
  confirm: string;
  typed: boolean;
  createdBy: string;
  now: number;
}

export function insertTagType(g: Grant, t: NewTagType) {
  return g.insertSelect(
    'nfc_tag_types',
    [
      'id',
      'name',
      'system',
      'use',
      'scopes',
      'per_pass',
      'binding_days',
      'confirm',
      'typed',
      'created_at',
      'created_by',
      'updated_at',
    ],
    [
      t.id,
      t.name,
      t.system,
      t.use,
      t.scopes,
      t.perPass,
      t.bindingDays,
      t.confirm,
      t.typed ? 1 : 0,
      t.now,
      t.createdBy,
      t.now,
    ],
    { returning: ['id'] },
  );
}

/** Replaces the type's template rows: delete them all, insert the new set. Cross-org ids insert nothing. */
export function setTypeTemplates(g: Grant, typeId: string, templateIds: readonly string[]) {
  g.joined('nfc_tag_type_templates', { via: 'type_id', where: { type_id: typeId }, delete: true });
  for (const templateId of templateIds)
    g.insertJoined('nfc_tag_type_templates', {
      parents: { type_id: typeId, template_id: templateId },
      columns: [],
      values: [],
    });
}

/** `version` is the one the caller read: any other match aborts the batch with `lineage`. */
export function updateTagType(
  g: Grant,
  id: string,
  version: number,
  set: Record<string, string | number | null>,
) {
  return g.update('nfc_tag_types', {
    where: { id, version },
    set,
    inc: ['version'],
    require: 'one',
    returning: ['id'],
  });
}
