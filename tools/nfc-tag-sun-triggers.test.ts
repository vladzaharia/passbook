// 0129: Secure tags on, and the keyset, key and counter tables with their triggers. Built on the 0128 world
// (tools/nfc-tags-fixtures.ts) with 0129 applied. Key material here is dummy sealed text: the database only
// checks its shape; sealing is tested in src/worker/modules/nfc/keysets.test.ts.
import { describe, expect, it } from 'vitest';
import { row, tagWorld } from './nfc-tags-fixtures.ts';
import { dump, migrationFile, read } from './wallet-instances-fixtures.ts';

const refuses = (fn: () => void, message: RegExp) => expect(fn).toThrow(message);
const sql0129 = read(migrationFile('0129'));

const before = tagWorld();
const beforeDump = dump(before.db);
const world = tagWorld();
world.db.exec(sql0129);
const { db, rolledBack, sql, tag } = world;
const afterDump = dump(db);

const SEALED = 'v1.1.aaaa.bbbb.cccc';
type V = string | number | null;
const keyset = (id: string, over: Record<string, V> = {}) =>
  row(db, 'nfc_tag_keysets', {
    id,
    org_id: 'o1',
    mode: 'live',
    name: id,
    slug: id.padEnd(8, 'x').slice(0, 8),
    diversify: 1,
    created_at: 1,
    created_by: 'adm',
    ...over,
  });
const key = (keysetId: string, version: number, over: Record<string, V> = {}) =>
  row(db, 'nfc_tag_keys', {
    keyset_id: keysetId,
    version,
    meta_key: SEALED,
    file_key: SEALED,
    state: 'active',
    created_at: 1,
    ...over,
  });
const side = (tagId: string, keysetId: string, over: Record<string, V> = {}) =>
  row(db, 'nfc_tag_sun', {
    tag_id: tagId,
    keyset_id: keysetId,
    key_version: 1,
    ctr: 0,
    ctr_at: 1,
    ...over,
  });
const WIPE = "state = 'retired', meta_key = '', file_key = ''";

describe('enabling Secure', () => {
  it('turns sun on, leaves uid on, and keeps nfc_tag_systems read-only with the 0128 trigger text', () => {
    expect(
      db.prepare('SELECT id, assurance, enabled FROM nfc_tag_systems ORDER BY id').all(),
    ).toEqual([
      { id: 'sun', assurance: 'secure', enabled: 1 },
      { id: 'uid', assurance: 'basic', enabled: 1 },
    ]);
    const text = (d: string[]) => d.find((l) => l.startsWith('trigger|nfc_tag_systems_fixed|'));
    expect(text(afterDump)).toBeDefined();
    expect(text(afterDump)).toBe(text(beforeDump));
    refuses(
      () => sql("UPDATE nfc_tag_systems SET enabled = 0 WHERE id = 'sun'"),
      /tag_system_fixed/,
    );
    refuses(
      () => sql("UPDATE nfc_tag_systems SET enabled = 1 WHERE id = 'uid'"),
      /tag_system_fixed/,
    );
    refuses(() => sql("DELETE FROM nfc_tag_systems WHERE id = 'sun'"), /tag_system_fixed/);
    refuses(
      () =>
        sql("INSERT INTO nfc_tag_systems (id, assurance, enabled) VALUES ('desfire', 'secure', 1)"),
      /tag_system_fixed/,
    );
  });

  it('changes nothing else that 0128 made', () => {
    const changed = beforeDump.filter((line) => !afterDump.includes(line));
    expect(changed).toEqual([]);
    const added = afterDump
      .filter((line) => !beforeDump.includes(line))
      .map((l) => l.split('|').slice(0, 2).join('|'));
    expect(added.filter((a) => !/nfc_tag_(keysets|keys|sun)/.test(a))).toEqual([]);
    expect(added.filter((a) => a.startsWith('table|')).sort()).toEqual([
      'table|nfc_tag_keys',
      'table|nfc_tag_keysets',
      'table|nfc_tag_sun',
    ]);
  });

  it('takes a sun tag, and still refuses a system that does not exist', () => {
    rolledBack(() => {
      tag('x', { system: 'sun' });
      refuses(() => tag('y', { system: 'desfire' }), /tag_system_disabled/);
    });
  });
});

describe('keysets', () => {
  it('allows four live ones per org and mode, a disabled one frees a slot, and org and mode are counted apart', () => {
    rolledBack(() => {
      for (const n of ['a', 'b', 'c', 'd']) keyset(`k${n}`);
      refuses(() => keyset('ke'), /keyset_limit/);
      keyset('kt', { mode: 'test' });
      keyset('ko', { org_id: 'o2' });
      sql("UPDATE nfc_tag_keysets SET disabled_at = 5 WHERE id = 'ka'");
      keyset('ke');
      refuses(() => keyset('kf'), /keyset_limit/);
    });
  });

  it('refuses a duplicate slug, a bad slug, an insert already disabled and another org’s type', () => {
    rolledBack(() => {
      keyset('ka', { slug: 'aaaaaaaa' });
      refuses(() => keyset('kb', { slug: 'aaaaaaaa' }), /UNIQUE/);
      refuses(() => keyset('kb', { slug: 'AAAAAAAA' }), /CHECK/);
      refuses(() => keyset('kb', { slug: 'short' }), /CHECK/);
      refuses(() => keyset('kb', { disabled_at: 3 }), /keyset_disabled/);
      world.type('y', { system: 'sun', use: 'staff' });
      world.type('yu', { system: 'uid' });
      world.type('y2', { system: 'sun', use: 'staff', org_id: 'o2' });
      keyset('kb', { type_id: 'y' });
      refuses(() => keyset('kc', { type_id: 'y2' }), /keyset_type_tenant/);
      refuses(() => keyset('kc', { type_id: 'yu' }), /keyset_type_tenant/);
    });
  });

  it('never changes its org, mode, slug, diversify or creation, and never comes back from disabled', () => {
    rolledBack(() => {
      keyset('ka');
      for (const set of [
        "org_id = 'o2'",
        "mode = 'test'",
        "slug = 'bbbbbbbb'",
        'diversify = 0',
        'created_at = 2',
        "created_by = 'x'",
        "id = 'kz'",
      ])
        refuses(() => sql(`UPDATE nfc_tag_keysets SET ${set} WHERE id = 'ka'`), /keyset_fixed/);
      sql("UPDATE nfc_tag_keysets SET name = 'New' WHERE id = 'ka'");
      sql("UPDATE nfc_tag_keysets SET disabled_at = 5 WHERE id = 'ka'");
      sql("UPDATE nfc_tag_keysets SET name = 'Again' WHERE id = 'ka'");
      refuses(
        () => sql("UPDATE nfc_tag_keysets SET disabled_at = NULL WHERE id = 'ka'"),
        /keyset_disabled/,
      );
      refuses(
        () => sql("UPDATE nfc_tag_keysets SET disabled_at = 9 WHERE id = 'ka'"),
        /keyset_disabled/,
      );
    });
  });
});

describe('keys', () => {
  it('counts versions up from 1, one at a time, one active and one retiring', () => {
    rolledBack(() => {
      keyset('ka');
      refuses(() => key('ka', 2), /tag_key_version/);
      key('ka', 1);
      refuses(() => key('ka', 1), /tag_key_version/);
      refuses(() => key('ka', 3), /tag_key_version/);
      // Version 1 is still active.
      refuses(() => key('ka', 2), /UNIQUE/);
      sql("UPDATE nfc_tag_keys SET state = 'retiring' WHERE keyset_id = 'ka' AND version = 1");
      key('ka', 2);
      // A second retiring key would be a third try on every read.
      refuses(
        () =>
          sql("UPDATE nfc_tag_keys SET state = 'retiring' WHERE keyset_id = 'ka' AND version = 2"),
        /UNIQUE/,
      );
      sql(`UPDATE nfc_tag_keys SET ${WIPE} WHERE keyset_id = 'ka' AND version = 1`);
      sql("UPDATE nfc_tag_keys SET state = 'retiring' WHERE keyset_id = 'ka' AND version = 2");
      key('ka', 3);
    });
  });

  it('is sealed text while live, and nothing but a wipe once retired', () => {
    rolledBack(() => {
      keyset('ka');
      const shapes: Record<string, V>[] = [
        { meta_key: 'plain' },
        { file_key: '' },
        { meta_key: '00112233445566778899aabbccddeeff' },
      ];
      for (const over of shapes) refuses(() => key('ka', 1, over), /CHECK/);
      refuses(() => key('ka', 1, { state: 'retiring' }), /tag_key_state/);
      key('ka', 1);
      sql("UPDATE nfc_tag_keys SET state = 'retiring' WHERE keyset_id = 'ka'");
      refuses(
        () => sql("UPDATE nfc_tag_keys SET meta_key = 'v1.2.a.b.c' WHERE keyset_id = 'ka'"),
        /tag_key_fixed/,
      );
      refuses(
        () => sql("UPDATE nfc_tag_keys SET file_key = 'v1.2.a.b.c' WHERE keyset_id = 'ka'"),
        /tag_key_fixed/,
      );
      // Retired with the material still there breaks the shape rule.
      refuses(
        () => sql("UPDATE nfc_tag_keys SET state = 'retired' WHERE keyset_id = 'ka'"),
        /CHECK/,
      );
      refuses(
        () => sql("UPDATE nfc_tag_keys SET version = 9 WHERE keyset_id = 'ka'"),
        /tag_key_fixed/,
      );
      refuses(
        () => sql("UPDATE nfc_tag_keys SET created_at = 9 WHERE keyset_id = 'ka'"),
        /tag_key_fixed/,
      );
      sql(`UPDATE nfc_tag_keys SET ${WIPE} WHERE keyset_id = 'ka'`);
      refuses(
        () => sql("UPDATE nfc_tag_keys SET state = 'active' WHERE keyset_id = 'ka'"),
        /tag_key_state|CHECK/,
      );
      refuses(
        () => sql("UPDATE nfc_tag_keys SET meta_key = 'v1.2.a.b.c' WHERE keyset_id = 'ka'"),
        /tag_key_fixed/,
      );
      refuses(() => sql("DELETE FROM nfc_tag_keys WHERE keyset_id = 'ka'"), /tag_key_fixed/);
    });
  });

  it('only moves forward: active, retiring, retired', () => {
    rolledBack(() => {
      keyset('ka');
      key('ka', 1);
      refuses(() => sql(`UPDATE nfc_tag_keys SET ${WIPE} WHERE keyset_id = 'ka'`), /tag_key_state/);
      sql("UPDATE nfc_tag_keys SET state = 'retiring' WHERE keyset_id = 'ka'");
      refuses(
        () => sql("UPDATE nfc_tag_keys SET state = 'active' WHERE keyset_id = 'ka'"),
        /tag_key_state/,
      );
      sql(`UPDATE nfc_tag_keys SET ${WIPE} WHERE keyset_id = 'ka'`);
    });
  });

  it('is not retired while a tag uses the version, unless the keyset is disabled', () => {
    rolledBack(() => {
      keyset('ka');
      key('ka', 1);
      tag('x', { system: 'sun' });
      side('x', 'ka');
      sql("UPDATE nfc_tag_keys SET state = 'retiring' WHERE keyset_id = 'ka'");
      refuses(
        () => sql(`UPDATE nfc_tag_keys SET ${WIPE} WHERE keyset_id = 'ka'`),
        /tag_key_in_use/,
      );
      sql("UPDATE nfc_tag_keysets SET disabled_at = 5 WHERE id = 'ka'");
      sql(`UPDATE nfc_tag_keys SET ${WIPE} WHERE keyset_id = 'ka'`);
    });
  });

  it('takes no new key on a disabled keyset, and a disable retires the active key directly', () => {
    rolledBack(() => {
      keyset('ka');
      key('ka', 1);
      refuses(
        () =>
          sql(
            "UPDATE nfc_tag_keys SET state = 'retired', meta_key = '', file_key = '' WHERE keyset_id = 'ka'",
          ),
        /tag_key_state/,
      );
      sql("UPDATE nfc_tag_keysets SET disabled_at = 5 WHERE id = 'ka'");
      refuses(() => key('ka', 2), /keyset_disabled/);
      sql(`UPDATE nfc_tag_keys SET ${WIPE} WHERE keyset_id = 'ka'`);
    });
  });
});

describe('per-tag side rows', () => {
  it('belongs to a sun tag of the keyset’s org and mode, on a key that is not retired', () => {
    rolledBack(() => {
      keyset('ka');
      key('ka', 1);
      keyset('kt', { mode: 'test' });
      key('kt', 1);
      keyset('ko', { org_id: 'o2' });
      key('ko', 1);
      tag('uid-tag');
      tag('sun-live', { system: 'sun' });
      tag('sun-test', { system: 'sun', mode: 'test' });
      refuses(() => side('uid-tag', 'ka'), /tag_sun_tenant/);
      refuses(() => side('sun-live', 'kt'), /tag_sun_tenant/);
      refuses(() => side('sun-live', 'ko'), /tag_sun_tenant/);
      refuses(() => side('sun-test', 'ka'), /tag_sun_tenant/);
      refuses(() => side('sun-live', 'ka', { key_version: 2 }), /FOREIGN KEY|tag_key_state/);
      refuses(() => side('sun-live', 'ka', { ctr: 16777216 }), /CHECK/);
      refuses(() => side('sun-live', 'ka', { file_key: 'plain' }), /CHECK/);
      side('sun-live', 'ka', { file_key: SEALED });
      side('sun-test', 'kt');
      refuses(() => side('sun-live', 'ka'), /UNIQUE/);
    });
  });

  it('refuses a disabled keyset and a retired version', () => {
    rolledBack(() => {
      keyset('ka');
      key('ka', 1);
      sql("UPDATE nfc_tag_keys SET state = 'retiring' WHERE keyset_id = 'ka'");
      key('ka', 2);
      sql(`UPDATE nfc_tag_keys SET ${WIPE} WHERE keyset_id = 'ka' AND version = 1`);
      tag('x', { system: 'sun' });
      refuses(() => side('x', 'ka'), /tag_key_state/);
      side('x', 'ka', { key_version: 2 });
      keyset('kb');
      key('kb', 1);
      tag('y', { system: 'sun' });
      sql("UPDATE nfc_tag_keysets SET disabled_at = 5 WHERE id = 'kb'");
      refuses(() => side('y', 'kb'), /keyset_disabled/);
    });
  });

  it('never lets the counter or the key version go down, or the keyset change', () => {
    rolledBack(() => {
      keyset('ka');
      key('ka', 1);
      sql("UPDATE nfc_tag_keys SET state = 'retiring' WHERE keyset_id = 'ka'");
      key('ka', 2);
      keyset('kb');
      key('kb', 1);
      tag('x', { system: 'sun' });
      side('x', 'ka', { ctr: 10 });
      refuses(() => sql("UPDATE nfc_tag_sun SET ctr = 9 WHERE tag_id = 'x'"), /tag_sun_ctr/);
      sql("UPDATE nfc_tag_sun SET ctr = 10 WHERE tag_id = 'x'");
      sql("UPDATE nfc_tag_sun SET ctr = 11, ctr_at = 3 WHERE tag_id = 'x'");
      refuses(
        () => sql("UPDATE nfc_tag_sun SET keyset_id = 'kb', key_version = 1 WHERE tag_id = 'x'"),
        /tag_sun_fixed/,
      );
      refuses(
        () => sql("UPDATE nfc_tag_sun SET tag_id = 'y' WHERE tag_id = 'x'"),
        /tag_sun_fixed|FOREIGN/,
      );
      refuses(
        () => sql("UPDATE nfc_tag_sun SET key_version = 3 WHERE tag_id = 'x'"),
        /FOREIGN KEY|tag_key_state/,
      );
      sql("UPDATE nfc_tag_sun SET key_version = 2 WHERE tag_id = 'x'");
      refuses(
        () => sql("UPDATE nfc_tag_sun SET key_version = 1 WHERE tag_id = 'x'"),
        /tag_sun_version/,
      );
    });
  });

  it('refuses a keyset delete while a tag is on it, and goes with its tag and its org', () => {
    rolledBack(() => {
      keyset('ka');
      key('ka', 1);
      tag('x', { system: 'sun' });
      side('x', 'ka');
      refuses(() => sql("DELETE FROM nfc_tag_keysets WHERE id = 'ka'"), /FOREIGN KEY/);
      sql("DELETE FROM nfc_tags WHERE id = 'x'");
      expect(db.prepare('SELECT count(*) AS n FROM nfc_tag_sun').get()).toEqual({ n: 0 });
      sql("DELETE FROM nfc_tag_keysets WHERE id = 'ka'");
      expect(db.prepare('SELECT count(*) AS n FROM nfc_tag_keys').get()).toEqual({ n: 0 });
    });
    // An org with nothing else hanging off it: the seeded orgs have passes and scanners that block a delete.
    rolledBack(() => {
      row(db, 'orgs', {
        id: 'o3',
        slug: 'o3',
        name: 'O',
        status: 'active',
        created_at: 1,
        updated_at: 1,
      });
      keyset('ka', { org_id: 'o3' });
      key('ka', 1);
      tag('x', { system: 'sun', org_id: 'o3' });
      side('x', 'ka');
      sql("DELETE FROM orgs WHERE id = 'o3'");
      for (const t of ['nfc_tag_keysets', 'nfc_tag_keys', 'nfc_tag_sun'])
        expect(db.prepare(`SELECT count(*) AS n FROM ${t}`).get(), t).toEqual({ n: 0 });
    });
  });
});
