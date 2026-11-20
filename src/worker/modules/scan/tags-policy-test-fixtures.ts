import { run } from '../../platform/db.ts';
import { clearSettingsCache } from '../settings/service.ts';
import type { TagScanFixture } from './tags-scan-test-fixtures.ts';
import { key } from './test-kit.ts';

export interface TypeSpec {
  name?: string;
  system?: 'uid' | 'sun';
  use?: 'member' | 'staff' | 'visitor';
  scopes?: 'pass' | 'user' | 'both';
  perPass?: number;
  bindingDays?: number | null;
  confirm?: 'none' | 'staff' | 'manager';
  typed?: boolean;
  templateIds?: string[];
}

let sequence = 0;

type Kit = Pick<TagScanFixture['kit'], 'env' | 'fx' | 'clock'>;

/** A tag type row in an org, as the console would make it. */
export async function insertType(kit: Kit, orgId: string, spec: TypeSpec = {}): Promise<string> {
  const db = kit.env.DB;
  const id = kit.fx.ids.id();
  const now = kit.clock.now();
  await run(
    db,
    `INSERT INTO nfc_tag_types (id, org_id, name, system, use, scopes, per_pass, binding_days, confirm, typed,
       created_at, created_by, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'test', ?)`,
    [
      id,
      orgId,
      spec.name ?? `Type ${++sequence}`,
      spec.system ?? 'uid',
      spec.use ?? 'member',
      spec.scopes ?? 'both',
      spec.perPass ?? 1,
      spec.bindingDays ?? null,
      spec.confirm ?? 'none',
      spec.typed === false ? 0 : 1,
      now,
      now,
    ],
  );
  for (const templateId of spec.templateIds ?? [])
    await run(db, 'INSERT INTO nfc_tag_type_templates (type_id, template_id) VALUES (?, ?)', [
      id,
      templateId,
    ]);
  return id;
}

/** A tag type in the fixture's org. */
export const addType = (f: TagScanFixture, spec: TypeSpec = {}) =>
  insertType(f.kit, f.kit.org.id, spec);

/** Archives every type, so the next test starts with none to choose from. */
export const clearTypes = (f: TagScanFixture) =>
  run(
    f.kit.env.DB,
    'UPDATE nfc_tag_types SET archived_at = 1, version = version + 1 WHERE archived_at IS NULL',
  );

/** The org's default tag type, or none. */
export async function setDefaultType(f: TagScanFixture, defaultType: string | null) {
  await run(f.kit.env.DB, "UPDATE settings SET value = ? WHERE scope = ? AND key = 'nfc.tags'", [
    JSON.stringify({ enabled: true, defaultType }),
    `org:${f.kit.org.id}`,
  ]);
  clearSettingsCache(f.kit.env.DB);
}

export const typeOf = async (f: TagScanFixture, tagId: string) =>
  (
    await f.kit.env.DB.prepare('SELECT type_id FROM nfc_tags WHERE id = ?')
      .bind(tagId)
      .first<{ type_id: string | null }>()
  )?.type_id ?? null;

export const json = async (res: Response) => (await res.json()) as Record<string, unknown>;

/** The door calls: a tag read to `/resolve` or `/actions`. */
export function doorCalls(f: TagScanFixture) {
  const input = (tag: unknown, extra: Record<string, unknown> = {}) => ({
    tag,
    method: 'nfc',
    ...extra,
  });
  const post = (
    s: { headers: Record<string, string> },
    path: '/resolve' | '/actions',
    tag: unknown,
    extra: Record<string, unknown> = {},
    body: Record<string, unknown> = {},
  ) =>
    f.kit
      .post(s.headers, path, {
        idempotencyKey: key(),
        input: input(tag, extra),
        clientTs: f.kit.clock.now(),
        ...(path === '/actions' ? { actionId: 'auto' } : {}),
        ...body,
      })
      .then(json);
  return { post };
}
