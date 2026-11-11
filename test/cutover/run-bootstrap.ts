import {
  type BootstrapSnapshot,
  buildBootstrap,
  snapshotSql,
} from '../../tools/lib/bootstrap-tenancy.ts';

/** Reads the snapshot the way the tool does, then applies the generated statements to `db`. */
export async function runBootstrap(db: D1Database, owner: string, now: number) {
  const row = await db.prepare(snapshotSql(owner)).first<{ snapshot: string }>();
  const raw = JSON.parse(row?.snapshot ?? '{}') as Partial<BootstrapSnapshot>;
  const result = await buildBootstrap(
    {
      owner: raw.owner ?? null,
      orgs: raw.orgs ?? [],
      templates: raw.templates ?? [],
      emails: raw.emails ?? [],
    },
    owner,
    now,
  );
  for (const sql of result.statements)
    await db.prepare(sql.replace(/\s*\n\s*/g, ' ').replace(/;$/, '')).run();
  return result;
}
