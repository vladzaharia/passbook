// 0070 refuses to run while a plain token is left, and a refused migration leaves nothing behind.

import { env as bindings } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import { all, first } from '../../src/worker/platform/db.ts';
import { legacyDatabase, migrateUnsealed, seedLegacy } from './legacy-seed.ts';

describe('0070 on an unsealed database', () => {
  it('stops the chain, is not recorded and rolls back', async () => {
    const db = await legacyDatabase(26);
    await seedLegacy(db, bindings.BUCKET);
    await expect(migrateUnsealed(db)).rejects.toThrow();
    const recorded = (await all<{ name: string }>(db, 'SELECT name FROM d1_migrations')).map(
      (r) => r.name,
    );
    expect(recorded).toContain('0069_token_remac.sql');
    expect(recorded).not.toContain('0070_post_cutover.sql');
    const tables = (
      await all<{ name: string }>(db, "SELECT name FROM sqlite_master WHERE type = 'table'")
    ).map((r) => r.name);
    expect(tables).toContain('scanning_config_revisions');
    expect(tables).not.toContain('post_cutover_guard');
    expect(
      await first(db, "SELECT 1 AS n FROM sqlite_master WHERE name = 'passes_token_plain'"),
    ).toEqual({ n: 1 });
  });
});
