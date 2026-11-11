import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import { makeScanEvent, makeScanner } from '../../../test/helpers/index.ts';
import { seedAuthority } from './authority-test-fixtures.ts';
import { all, first, run } from './db.ts';

const db = env.DB;
const at = async (table: string, id: string, column: string) =>
  (await first<{ v: number }>(db, `SELECT ${column} AS v FROM ${table} WHERE id = ?`, [id]))?.v ??
  0;

describe('0052 epoch triggers move both sides of a re-key', () => {
  it('minor 1: a scanning_devices row moved between scanners bumps both, and cannot be replaced', async () => {
    const s = await seedAuthority('trg-devices');
    const other = await makeScanner(s.f, { orgId: s.org.id });
    const otherId = (
      await first<{ id: string }>(db, 'SELECT id FROM scanners WHERE org_id = ? AND id != ?', [
        s.org.id,
        s.scannerId,
      ])
    )?.id as string;
    expect(other).toBeDefined();
    await run(
      db,
      "INSERT INTO scanning_devices (scanner_id, session_id, org_id, mode) VALUES (?, ?, ?, 'live')",
      [s.scannerId, s.scanningSessionId, s.org.id],
    );
    const before = [
      await at('scanners', s.scannerId, 'config_epoch'),
      await at('scanners', otherId, 'config_epoch'),
    ];
    await run(db, 'UPDATE scanning_devices SET scanner_id = ? WHERE scanner_id = ?', [
      otherId,
      s.scannerId,
    ]);
    expect(await at('scanners', s.scannerId, 'config_epoch')).toBeGreaterThan(before[0] ?? 0);
    expect(await at('scanners', otherId, 'config_epoch')).toBeGreaterThan(before[1] ?? 0);
    for (const verb of ['INSERT OR REPLACE INTO', 'REPLACE INTO'])
      await expect(
        run(
          db,
          `${verb} scanning_devices (scanner_id, session_id, org_id, mode) VALUES (?, ?, ?, 'live')`,
          [otherId, s.scanningSessionId, s.org.id],
        ),
      ).rejects.toThrow(/UNIQUE/);
    expect(
      await all(db, 'SELECT scanner_id FROM scanning_devices WHERE org_id = ?', [s.org.id]),
    ).toEqual([{ scanner_id: otherId }]);
  });

  it('minor 2: a settings row moved to another org or key bumps the old and the new org', async () => {
    const a = await seedAuthority('trg-settings-a');
    const b = await seedAuthority('trg-settings-b');
    await run(
      db,
      "INSERT INTO settings (scope, key, value, updated_at) VALUES (?, 'move', '1', 1)",
      [`org:${a.org.id}`],
    );
    const rev = (id: string) => at('orgs', id, 'config_revision');
    let [ra, rb] = [await rev(a.org.id), await rev(b.org.id)];
    await run(db, "UPDATE settings SET scope = ? WHERE scope = ? AND key = 'move'", [
      `org:${b.org.id}`,
      `org:${a.org.id}`,
    ]);
    expect(await rev(a.org.id)).toBeGreaterThan(ra);
    expect(await rev(b.org.id)).toBeGreaterThan(rb);
    [ra, rb] = [await rev(a.org.id), await rev(b.org.id)];
    await run(db, "UPDATE settings SET key = 'moved' WHERE scope = ? AND key = 'move'", [
      `org:${b.org.id}`,
    ]);
    expect(await rev(b.org.id)).toBeGreaterThan(rb);
    expect(await rev(a.org.id)).toBe(ra);
    // Moving a platform row into an org changes that org's settings.
    await run(
      db,
      "INSERT INTO settings (scope, key, value, updated_at) VALUES ('platform', 'p', '1', 1)",
    );
    rb = await rev(b.org.id);
    await run(db, "UPDATE settings SET scope = ? WHERE scope = 'platform' AND key = 'p'", [
      `org:${b.org.id}`,
    ]);
    expect(await rev(b.org.id)).toBeGreaterThan(rb);
  });

  it('minor 3: moving a scan_event_templates row between events bumps both events', async () => {
    const s = await seedAuthority('trg-event-templates');
    const second = await makeScanEvent(s.f, { orgId: s.org.id });
    const tpl = s.template.resolved.id;
    await run(db, 'INSERT INTO scan_event_templates (event_id, template_id) VALUES (?, ?)', [
      s.event.id,
      tpl,
    ]);
    const [e1, e2] = [
      await at('scan_events', s.event.id, 'config_epoch'),
      await at('scan_events', second.id, 'config_epoch'),
    ];
    await run(db, 'UPDATE scan_event_templates SET event_id = ? WHERE event_id = ?', [
      second.id,
      s.event.id,
    ]);
    expect(await at('scan_events', s.event.id, 'config_epoch')).toBeGreaterThan(e1);
    expect(await at('scan_events', second.id, 'config_epoch')).toBeGreaterThan(e2);
  });

  it('minor 12: the role list in the 0029 guards is exactly OrgRoleSchema', async () => {
    const { OrgRoleSchema } = await import('../../shared/contracts/org-membership.ts');
    for (const name of ['org_memberships_roles_valid', 'org_invitations_roles_valid']) {
      const trigger = await first<{ sql: string }>(
        db,
        "SELECT sql FROM sqlite_master WHERE type = 'trigger' AND name = ?",
        [name],
      );
      const listed = /NOT IN \(([^)]*)\)/.exec(trigger?.sql ?? '')?.[1] ?? '';
      const names = [...listed.matchAll(/'([a-z_]+)'/g)].map((m) => m[1]).sort();
      expect(names, name).toEqual([...OrgRoleSchema.options].sort());
    }
  });
});
