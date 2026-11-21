import { all, chunk, placeholders } from '../../platform/db.ts';

export interface ExistingPass {
  id: string;
  template_id: string;
  external_id: string | null;
  holder_email: string | null;
  connection_id: string | null;
  version: number;
  status: 'active' | 'voided';
  personalization: string;
  field_sources: string;
}

const COLUMNS = `id, template_id, external_id, holder_email, connection_id, version, status,
  personalization, field_sources`;
/** `IN` lists stay at 80 values: D1 binds at most 100 a statement. */
const LOOKUP = 80;

/** Live passes of this org and mode with one of these keys. Removed and deleted passes never match. */
export async function livePassesBy(
  db: D1Database,
  orgId: string,
  mode: string,
  column: 'external_id' | 'holder_email',
  keys: readonly string[],
): Promise<ExistingPass[]> {
  const found: ExistingPass[] = [];
  for (const part of chunk([...new Set(keys)], LOOKUP))
    found.push(
      ...(await all<ExistingPass>(
        db,
        `SELECT ${COLUMNS} FROM passes
         WHERE org_id = ? AND mode = ? AND ${column} IN (${placeholders(part.length)})
           AND removed_at IS NULL AND deleted_at IS NULL AND test_data_quarantined = 0`,
        [orgId, mode, ...part],
      )),
    );
  return found;
}

export async function connectionNames(
  db: D1Database,
  orgId: string,
  ids: readonly string[],
): Promise<Map<string, string>> {
  const names = new Map<string, string>();
  for (const part of chunk([...new Set(ids)], LOOKUP))
    for (const c of await all<{ id: string; name: string }>(
      db,
      `SELECT id, name FROM connections WHERE org_id = ? AND id IN (${placeholders(part.length)})`,
      [orgId, ...part],
    ))
      names.set(c.id, c.name);
  return names;
}

/** The inputs of these passes of the org, by id. */
export async function personalizationsOf(
  db: D1Database,
  orgId: string,
  ids: readonly string[],
): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  for (const part of chunk([...new Set(ids)], LOOKUP))
    for (const p of await all<{ id: string; personalization: string }>(
      db,
      `SELECT id, personalization FROM passes WHERE org_id = ? AND id IN (${placeholders(part.length)})`,
      [orgId, ...part],
    ))
      out.set(p.id, p.personalization);
  return out;
}
