import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import { all } from '../../platform/db.ts';
import { EXPORT_ENTITIES, exportPage } from './repo-export.ts';
import { EXPORT_EXCLUDED } from './repo-export-excluded.ts';
import { PURGE_NOT_TENANT } from './repo-plan.ts';

const tablesOf = (select: string) =>
  [...select.matchAll(/\b(?:FROM|JOIN)\s+([a-z_0-9]+)/g)].map((m) => m[1] ?? '');

async function schemaTables(): Promise<string[]> {
  const rows = await all<{ name: string }>(
    env.DB,
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' AND name != 'd1_migrations'",
  );
  return rows.map((r) => r.name);
}

describe('the export against the migrated schema', () => {
  it('covers every table: an entity, excluded with a reason, or not tenant data', async () => {
    const tables = await schemaTables();
    const exported = new Set(EXPORT_ENTITIES.flatMap((e) => tablesOf(e.select)));
    const unaccounted = tables.filter(
      (t) => !exported.has(t) && !(t in EXPORT_EXCLUDED) && !(t in PURGE_NOT_TENANT),
    );
    expect(
      unaccounted,
      'Add each to EXPORT_ENTITIES (repo-export.ts) or EXPORT_EXCLUDED with a reason',
    ).toEqual([]);
    for (const t of Object.keys(EXPORT_EXCLUDED)) {
      expect(tables, t).toContain(t);
      expect(exported.has(t), `${t} is both exported and excluded`).toBe(false);
      expect(EXPORT_EXCLUDED[t]?.length, t).toBeGreaterThan(10);
    }
  });

  it('every entity is valid SQL against the schema', async () => {
    const broken: string[] = [];
    for (const entity of EXPORT_ENTITIES)
      await exportPage(env.DB, entity, 'no-such-org', 0, 1).catch((e: Error) =>
        broken.push(`${entity.name}: ${e.message}`),
      );
    expect(broken).toEqual([]);
  });

  it('never selects a secret, a hash or key material', () => {
    const secret =
      /ciphertext|wrapped_dek|kek_version|(^|[\s,.])iv\b|_hash\b|token|secret|pin\b|tag_ref/i;
    const leaks = EXPORT_ENTITIES.filter((e) =>
      secret.test(e.select.slice(0, e.select.indexOf(' FROM '))),
    ).map((e) => e.name);
    expect(leaks).toEqual([]);
  });
});
