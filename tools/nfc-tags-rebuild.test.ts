// 0128 rebuilds nfc_tags, tag_bindings and tag_enrollments (kind -> system, type_id, expires_at, four end causes).
// D1 cannot rename the closure aside and dropping it cascades, so the block copies it, drops it leaf first and
// restores it. These tests hold the rebuild to its promise: the whole sqlite_master differs only in the listed
// objects, every row comes back (kind as system), and every foreign key still holds. Triggers: nfc-tag-types-triggers.test.ts.
import { describe, expect, it } from 'vitest';
import { seededBefore0128 } from './nfc-tags-fixtures.ts';
import { dump, migrationFile, read } from './wallet-instances-fixtures.ts';

const file = read(migrationFile('0128'));
const rebuild = /-- rebuild:begin\n([\s\S]*?)-- rebuild:end/.exec(file)?.[1] ?? '';
const key = (r: string) => r.split('|').slice(0, 2).join('|');
const rows = (db: ReturnType<typeof seededBefore0128>, t: string) =>
  db.prepare(`SELECT * FROM ${t} ORDER BY rowid`).all() as Record<string, unknown>[];
const TABLES = ['nfc_tags', 'tag_bindings', 'tag_enrollments'];

/** Replaced by the rebuild: the two tables with new columns, and the two nfc_tags triggers it rewrites. */
const REPLACED = [
  'table|nfc_tags',
  'table|tag_bindings',
  'trigger|nfc_tags_fixed',
  'trigger|nfc_tags_kind_insert',
];
/** What 0128 adds or writes anew, beside the rebuilt objects. */
const ADDED = [
  'index|nfc_tag_type_templates_template',
  'index|nfc_tag_types_name',
  'index|nfc_tag_types_org',
  'index|nfc_tag_types_system',
  'index|nfc_tags_system',
  'index|nfc_tags_type',
  'index|sqlite_autoindex_nfc_tag_systems_1',
  'index|sqlite_autoindex_nfc_tag_type_templates_1',
  'index|sqlite_autoindex_nfc_tag_types_1',
  'index|tag_bindings_expiry',
  'table|nfc_tag_systems',
  'table|nfc_tag_type_templates',
  'table|nfc_tag_types',
  'trigger|nfc_tag_systems_fixed',
  'trigger|nfc_tag_systems_no_delete',
  'trigger|nfc_tag_systems_no_insert',
  'trigger|nfc_tag_type_templates_fixed',
  'trigger|nfc_tag_type_templates_tenant',
  'trigger|nfc_tag_types_fixed',
  'trigger|nfc_tag_types_insert',
  'trigger|nfc_tag_types_version',
  'trigger|nfc_tags_system_insert',
  'trigger|nfc_tags_type_insert',
  'trigger|nfc_tags_type_update',
  'trigger|tag_bindings_expiry_fixed',
  'trigger|tag_bindings_type_check',
];

describe('0128 rebuild of the tag tables', () => {
  it('copies, drops leaf first and restores the three tables', () => {
    for (const t of TABLES) {
      expect(rebuild).toContain(`CREATE TABLE _keep_${t} AS SELECT * FROM ${t};`);
      expect(rebuild).toContain(`DROP TABLE _keep_${t};`);
    }
    expect(rebuild.indexOf('DROP TABLE tag_enrollments;')).toBeLessThan(
      rebuild.indexOf('DROP TABLE tag_bindings;'),
    );
    expect(rebuild.indexOf('DROP TABLE tag_bindings;')).toBeLessThan(
      rebuild.indexOf('DROP TABLE nfc_tags;'),
    );
  });

  it('changes the two tables and two triggers and adds the new objects; every other object is identical', () => {
    const db = seededBefore0128();
    const was = dump(db);
    db.exec('BEGIN');
    db.exec(file);
    expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
    db.exec('COMMIT');
    const now = dump(db);
    const gone = was.filter((r) => !now.includes(r)).map(key);
    const added = now.filter((r) => !was.includes(r)).map(key);
    expect(gone.sort()).toEqual([...REPLACED].sort());
    // The rebuilt objects come back under their own names; nothing else changed or vanished.
    expect(added.sort()).toEqual(
      [...REPLACED.filter((r) => r !== 'trigger|nfc_tags_kind_insert'), ...ADDED].sort(),
    );
    expect(now.length).toBe(was.length - 1 + ADDED.length);
    // The nfc_tags_kind_insert trigger is gone, not renamed in place.
    expect(now.some((r) => r.startsWith('trigger|nfc_tags_kind_insert|'))).toBe(false);
    // Every trigger and index of the three tables and the one on passes is back, word for word.
    for (const r of was.filter((x) => /^(trigger|index)\|/.test(x) && !REPLACED.includes(key(x))))
      expect(now, key(r)).toContain(r);
  });

  it('renames kind to system and adds type_id and expires_at, and nothing else', () => {
    const db = seededBefore0128();
    const cols = (t: string) =>
      (db.prepare(`SELECT name FROM pragma_table_info('${t}')`).all() as { name: string }[]).map(
        (c) => c.name,
      );
    const [tags, bindings, enrollments] = TABLES.map(cols);
    db.exec(file);
    expect(cols('nfc_tags').sort()).toEqual(
      [...(tags ?? []).map((c) => (c === 'kind' ? 'system' : c)), 'type_id'].sort(),
    );
    expect(cols('tag_bindings').sort()).toEqual([...(bindings ?? []), 'expires_at'].sort());
    expect(cols('tag_enrollments')).toEqual(enrollments);
    const fks = (t: string) =>
      (
        db
          .prepare(`SELECT "table", "from", on_delete FROM pragma_foreign_key_list('${t}')`)
          .all() as {
          table: string;
          from: string;
          on_delete: string;
        }[]
      )
        .map((f) => `${f.from}>${f.table}:${f.on_delete}`)
        .sort();
    expect(fks('nfc_tags')).toEqual([
      'org_id>orgs:CASCADE',
      'system>nfc_tag_systems:NO ACTION',
      'type_id>nfc_tag_types:NO ACTION',
    ]);
    expect(fks('tag_bindings')).toEqual([
      'pass_id>passes:CASCADE',
      'tag_id>nfc_tags:CASCADE',
      'user_id>users:CASCADE',
    ]);
    expect(fks('tag_enrollments')).toContain('binding_id>tag_bindings:SET NULL');
  });

  it('keeps every row, in order, with kind as system, and passes the foreign key check', () => {
    const db = seededBefore0128();
    expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
    const was = Object.fromEntries(TABLES.map((t) => [t, rows(db, t)]));
    expect(was.nfc_tags?.length).toBe(18);
    expect(was.tag_bindings?.length).toBe(14);
    expect(was.tag_enrollments?.length).toBe(3);
    // As D1 applies a migration: one transaction, foreign keys on.
    db.exec('BEGIN');
    db.exec(file);
    expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
    db.exec('COMMIT');
    const tags = (was.nfc_tags ?? []).map(({ kind, ...r }) => ({
      ...r,
      system: kind,
      type_id: null,
    }));
    expect(rows(db, 'nfc_tags')).toEqual(tags);
    expect(rows(db, 'tag_bindings')).toEqual(
      (was.tag_bindings ?? []).map((r) => ({ ...r, expires_at: null })),
    );
    expect(rows(db, 'tag_enrollments')).toEqual(was.tag_enrollments);
    expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
    // The restore went through no trigger: no binding was ended and no tag marked lost by it.
    expect(
      db.prepare('SELECT count(*) AS n FROM tag_bindings WHERE ended_at IS NULL').get(),
    ).toEqual({ n: 2 });
    expect(
      db.prepare('SELECT count(*) AS n FROM sqlite_master WHERE name LIKE ?').get('\\_keep\\_%'),
    ).toEqual({ n: 0 });
  });

  it('seeds the two systems: uid on, sun off until 0129', () => {
    const db = seededBefore0128();
    db.exec(file);
    expect(
      db.prepare('SELECT id, assurance, enabled FROM nfc_tag_systems ORDER BY id').all(),
    ).toEqual([
      { id: 'sun', assurance: 'secure', enabled: 0 },
      { id: 'uid', assurance: 'basic', enabled: 1 },
    ]);
  });
});
