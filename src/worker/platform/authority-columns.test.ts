import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import {
  fixtures,
  makeEnv,
  makeOrg,
  makePass,
  makeScanEvent,
  makeScanner,
  makeScanStaff,
  makeTemplate,
  persistTemplate,
} from '../../../test/helpers/index.ts';
import { EPOCH_TABLES } from './authority-columns.ts';
import { all, first, run } from './db.ts';

const db = env.DB;
const columnsOf = async (table: string) =>
  (await all<{ name: string }>(db, `SELECT name FROM pragma_table_info('${table}')`)).map(
    (c) => c.name,
  );
const epoch = async (table: string, id: string, column: string, key = 'id') =>
  (
    await first<Record<string, number>>(
      db,
      `SELECT ${column} AS v FROM ${table} WHERE ${key} = ?`,
      [id],
    )
  )?.v ?? -1;

describe('column classification', () => {
  for (const t of EPOCH_TABLES) {
    it(`${t.table}: every column is in exactly one class`, async () => {
      const epochs = Object.keys(t.epochs);
      const bump = Object.values(t.epochs).flat();
      const classes = [epochs, bump, t.volatile, t.fixed];
      const flat = classes.flat();
      expect(new Set(flat).size, `duplicates in ${t.table}`).toBe(flat.length);
      expect(flat.toSorted()).toEqual((await columnsOf(t.table)).toSorted());
    });

    for (const [name, bump] of t.bumpTriggerBy ? [] : Object.entries(t.epochs)) {
      it(`${t.table}.${name}: the migrated triggers watch exactly the bump set`, async () => {
        const triggers = await all<{ sql: string }>(
          db,
          "SELECT sql FROM sqlite_master WHERE type = 'trigger' AND tbl_name = ? AND sql LIKE '%' || ? || ' + 1%'",
          [t.table, name],
        );
        const watched = triggers.flatMap(({ sql }) => {
          const when = /\bWHEN\b([\s\S]*?)\bBEGIN\b/.exec(sql)?.[1] ?? '';
          return [...when.matchAll(/NEW\.(\w+) IS NOT OLD\.\1/g)].map((m) => m[1] as string);
        });
        expect(triggers.length).toBeGreaterThan(0);
        expect(watched.toSorted()).toEqual(bump.toSorted());
        const lists = triggers.flatMap(
          ({ sql }) => /UPDATE OF ([\w, ]+) ON/.exec(sql)?.[1]?.split(', ') ?? [],
        );
        expect(lists.toSorted()).toEqual(bump.toSorted());
      });
    }

    it(`${t.table}: each epoch has a monotonic guard and the fixed columns are guarded`, async () => {
      for (const name of Object.keys(t.epochs)) {
        const guard = await first(
          db,
          "SELECT 1 FROM sqlite_master WHERE type = 'trigger' AND tbl_name = ? AND sql LIKE ? AND sql LIKE '%epoch_monotonic%'",
          [t.table, `%UPDATE OF ${name} ON%`],
        );
        expect(guard, `${t.table}.${name}`).not.toBeNull();
      }
      const triggers = await all<{ sql: string }>(
        db,
        "SELECT sql FROM sqlite_master WHERE type = 'trigger' AND tbl_name = ? AND sql LIKE '%BEFORE UPDATE%'",
        [t.table],
      );
      const text = triggers.map((x) => x.sql).join('\n');
      for (const column of t.fixed)
        expect(text, `${t.table}.${column}`).toMatch(new RegExp(`OLD\\.${column}\\b`));
    });
  }
});

describe('epochs move with their bump set only', () => {
  const f = fixtures(env);
  const setup = async () => {
    const f2 = fixtures(await makeEnv());
    return { f: f2, org: await makeOrg(f2) };
  };

  it('orgs: status moves access_revision, profile moves config_revision, timestamps move neither', async () => {
    const { org } = await setup();
    const read = async () => ({
      a: await epoch('orgs', org.id, 'access_revision'),
      c: await epoch('orgs', org.id, 'config_revision'),
    });
    const base = await read();
    await run(
      db,
      'UPDATE orgs SET updated_at = updated_at + 1, branding_dirty_at = 5 WHERE id = ?',
      [org.id],
    );
    expect(await read()).toEqual(base);
    await run(db, "UPDATE orgs SET name = 'Renamed' WHERE id = ?", [org.id]);
    const afterName = await read();
    expect(afterName.c).toBeGreaterThan(base.c);
    expect(afterName.a).toBe(base.a);
    await run(db, "UPDATE orgs SET name = 'Renamed' WHERE id = ?", [org.id]);
    expect(await read()).toEqual(afterName);
    await run(db, "UPDATE orgs SET status = 'suspended' WHERE id = ?", [org.id]);
    const afterStatus = await read();
    expect(afterStatus.a).toBeGreaterThan(afterName.a);
    expect(afterStatus.c).toBe(afterName.c);
  });

  it('settings rows with an org scope move config_revision; other scopes do not', async () => {
    const { org } = await setup();
    const rev = () => epoch('orgs', org.id, 'config_revision');
    const base = await rev();
    await run(
      db,
      "INSERT INTO settings (scope, key, value, updated_at) VALUES ('platform', 'wp0.k', '1', 1)",
    );
    expect(await rev()).toBe(base);
    const scope = `org:${org.id}`;
    await run(
      db,
      "INSERT INTO settings (scope, key, value, updated_at) VALUES (?, 'wp0.k', '1', 1)",
      [scope],
    );
    const afterInsert = await rev();
    expect(afterInsert).toBeGreaterThan(base);
    await run(db, 'UPDATE settings SET updated_at = 9 WHERE scope = ?', [scope]);
    expect(await rev()).toBe(afterInsert);
    await run(db, "UPDATE settings SET value = '2' WHERE scope = ?", [scope]);
    const afterUpdate = await rev();
    expect(afterUpdate).toBeGreaterThan(afterInsert);
    await run(db, 'DELETE FROM settings WHERE scope = ?', [scope]);
    expect(await rev()).toBeGreaterThan(afterUpdate);
  });

  it('passes: volatile columns never bump, bump columns do, RETURNING shows the pre-trigger value', async () => {
    const { f: fx, org } = await setup();
    const pass = await makePass(fx, {
      orgId: org.id,
      template: makeTemplate({ id: 'tpl-wp0-rv' }).resolved,
    });
    const rv = () => epoch('passes', pass.id, 'row_version');
    const base = await rv();
    await run(
      db,
      'UPDATE passes SET next_sync_at = 5, sync_failures = 3, last_refreshed_at = 9, object_size = 4 WHERE id = ?',
      [pass.id],
    );
    expect(await rv()).toBe(base);
    const returned = await first<{ row_version: number }>(
      db,
      "UPDATE passes SET display_title = 'x' WHERE id = ? RETURNING row_version",
      [pass.id],
    );
    expect(returned?.row_version).toBe(base);
    expect(await rv()).toBeGreaterThan(base);
    const afterTitle = await rv();
    await run(db, "UPDATE passes SET display_title = 'x' WHERE id = ?", [pass.id]);
    expect(await rv()).toBe(afterTitle);
    await run(db, 'UPDATE passes SET version = version + 1, status = ? WHERE id = ?', [
      'active',
      pass.id,
    ]);
    expect(await rv()).toBeGreaterThan(afterTitle);
  });

  it('passes: scan_code, barcode_hash and lookup_hash bump only when they were already set', async () => {
    const { f: fx, org } = await setup();
    const pass = await makePass(fx, {
      orgId: org.id,
      template: makeTemplate({ id: 'tpl-wp0-lookup' }).resolved,
      scanCode: null,
    });
    const rv = () => epoch('passes', pass.id, 'row_version');
    const hash = 'a'.repeat(64);
    const base = await rv();
    // The credential guards need a transfer for these columns; this test is about the epoch only.
    const names = ['pass_credential_lookup_revision_guard', 'pass_credential_transfer_required'];
    const saved = await all<{ name: string; sql: string }>(
      db,
      `SELECT name, sql FROM sqlite_master WHERE type = 'trigger' AND name IN (${names.map(() => '?').join(',')})`,
      names,
    );
    for (const t of saved) await db.prepare(`DROP TRIGGER "${t.name}"`).run();
    try {
      await run(
        db,
        'UPDATE passes SET barcode_hash = ?, lookup_hash = ?, scan_code = ? WHERE id = ?',
        [hash, hash, 'c0de-1', pass.id],
      );
      expect(await rv(), 'first set is a backfill').toBe(base);
      await run(db, "UPDATE passes SET scan_code = 'c0de-2' WHERE id = ?", [pass.id]);
      expect(await rv(), 'a replaced code bumps').toBeGreaterThan(base);
    } finally {
      for (const t of saved) await db.prepare(t.sql).run();
    }
  });

  it('scanners: credential and config epochs are independent; devices feed config_epoch', async () => {
    const { f: fx, org } = await setup();
    const scanner = await makeScanner(fx, { orgId: org.id });
    const row = await first<{ id: string }>(
      db,
      'SELECT id FROM scanners WHERE org_id = ? LIMIT 1',
      [org.id],
    );
    const id = row?.id ?? '';
    const read = async () => ({
      c: await epoch('scanners', id, 'credential_epoch'),
      g: await epoch('scanners', id, 'config_epoch'),
    });
    expect(scanner.token).toBeTruthy();
    const base = await read();
    await run(
      db,
      "UPDATE scanners SET name = 'Door', last_seen_at = 99, staff_seen_at = 99, updated_at = updated_at + 1 WHERE id = ?",
      [id],
    );
    expect(await read()).toEqual(base);
    await run(db, "UPDATE scanners SET time_zone = 'Europe/Berlin' WHERE id = ?", [id]);
    const afterZone = await read();
    expect(afterZone.g).toBeGreaterThan(base.g);
    expect(afterZone.c).toBe(base.c);
    await run(db, 'UPDATE scanners SET revoked_at = 5 WHERE id = ?', [id]);
    const afterRevoke = await read();
    expect(afterRevoke.c).toBeGreaterThan(afterZone.c);
    expect(afterRevoke.g).toBe(afterZone.g);

    const sessionId = fx.ids.id();
    await run(
      db,
      "INSERT INTO scanning_sessions (id, org_id, mode, name, settings, time_zone, created_at, updated_at) VALUES (?, ?, 'live', 'S', '{}', 'UTC', 1, 1)",
      [sessionId, org.id],
    );
    await run(
      db,
      "INSERT INTO scanning_devices (scanner_id, session_id, org_id, mode) VALUES (?, ?, ?, 'live')",
      [id, sessionId, org.id],
    );
    const afterAttach = await read();
    expect(afterAttach.g).toBeGreaterThan(afterRevoke.g);
    await run(
      db,
      "UPDATE scanning_devices SET capabilities = '{}', reported_at = 7 WHERE scanner_id = ?",
      [id],
    );
    expect((await read()).g).toBe(afterAttach.g);
    await run(db, "UPDATE scanning_devices SET surface = 'desk' WHERE scanner_id = ?", [id]);
    const afterSurface = await read();
    expect(afterSurface.g).toBeGreaterThan(afterAttach.g);
    // A session edit moves the session's own epoch, not the scanner's.
    const sessionEpoch = await epoch('scanning_sessions', sessionId, 'config_epoch');
    await run(db, "UPDATE scanning_sessions SET name = 'Renamed', updated_at = 5 WHERE id = ?", [
      sessionId,
    ]);
    expect(await epoch('scanning_sessions', sessionId, 'config_epoch')).toBe(sessionEpoch);
    await run(db, "UPDATE scanning_sessions SET status = 'paused' WHERE id = ?", [sessionId]);
    expect(await epoch('scanning_sessions', sessionId, 'config_epoch')).toBeGreaterThan(
      sessionEpoch,
    );
  });

  it('scan_staff and scan_events: authority columns bump, labels do not, templates feed the event', async () => {
    const { f: fx, org } = await setup();
    const tpl = makeTemplate({ id: 'tpl-wp0-event' });
    await persistTemplate(fx, tpl.resolved, { registry: tpl.registry });
    const staff = await makeScanStaff(fx, { orgId: org.id });
    const auth = () => epoch('scan_staff', staff.id, 'auth_epoch');
    const a0 = await auth();
    await run(db, "UPDATE scan_staff SET name = 'Renamed', updated_at = 9 WHERE id = ?", [
      staff.id,
    ]);
    expect(await auth()).toBe(a0);
    await run(db, "UPDATE scan_staff SET role = 'manager' WHERE id = ?", [staff.id]);
    const a1 = await auth();
    expect(a1).toBeGreaterThan(a0);
    await run(db, 'UPDATE scan_staff SET disabled_at = 5 WHERE id = ?', [staff.id]);
    expect(await auth()).toBeGreaterThan(a1);

    const event = await makeScanEvent(fx, { orgId: org.id });
    const cfg = () => epoch('scan_events', event.id, 'config_epoch');
    const c0 = await cfg();
    await run(
      db,
      "UPDATE scan_events SET name = 'N', note = 'n', expected = 3, expected_at = 4, updated_at = 5 WHERE id = ?",
      [event.id],
    );
    expect(await cfg()).toBe(c0);
    await run(db, 'UPDATE scan_events SET capacity = 10 WHERE id = ?', [event.id]);
    const c1 = await cfg();
    expect(c1).toBeGreaterThan(c0);
    await run(db, 'INSERT INTO scan_event_templates (event_id, template_id) VALUES (?, ?)', [
      event.id,
      tpl.resolved.id,
    ]);
    const c2 = await cfg();
    expect(c2).toBeGreaterThan(c1);
    await run(db, 'DELETE FROM scan_event_templates WHERE event_id = ?', [event.id]);
    expect(await cfg()).toBeGreaterThan(c2);
  });

  it('connections.generation moves with its bump set (0044 trigger) and never with volatile columns', async () => {
    const { org } = await setup();
    const id = f.ids.id();
    await run(
      db,
      "INSERT INTO connections (id, org_id, connector_type, name, created_at, updated_at) VALUES (?, ?, 'x', 'C', 1, 1)",
      [id, org.id],
    );
    const gen = () => epoch('connections', id, 'generation');
    const g0 = await gen();
    await run(
      db,
      "UPDATE connections SET health = 'healthy', cursor = 'c', next_run_at = 3, name = 'N', interval_seconds = 60 WHERE id = ?",
      [id],
    );
    expect(await gen()).toBe(g0);
    await run(db, "UPDATE connections SET mapping = '{}', mode = 'manual' WHERE id = ?", [id]);
    expect(await gen()).toBeGreaterThan(g0);
    const g1 = await gen();
    await run(db, 'UPDATE connections SET enabled = 0 WHERE id = ?', [id]);
    expect(await gen()).toBeGreaterThan(g1);
    await expect(
      run(db, 'UPDATE connections SET generation = ? WHERE id = ?', [g0, id]),
    ).rejects.toThrow(/epoch_monotonic/);
  });
});
