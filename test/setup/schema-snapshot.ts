import snapshot from './schema-snapshot.generated.json';

/**
 * Brings an empty D1 to the fully migrated state in one batch (tools/build-test-schema.ts).
 * test/schema-snapshot.test.ts proves it equals what the real migrations produce.
 */
export async function applySchemaSnapshot(db: D1Database): Promise<void> {
  await db.batch([
    db.prepare('PRAGMA defer_foreign_keys = ON'),
    ...(snapshot as string[]).map((sql) => db.prepare(sql)),
  ]);
}
