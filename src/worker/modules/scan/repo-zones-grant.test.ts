import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import { grant } from '../../platform/authority.ts';
import { setupGrant } from '../../platform/authority-test-fixtures.ts';
import { all, first, run } from '../../platform/db.ts';
import { addSessionZones, addZoneUpdate, zoneFitsUnder, zonesOpen } from './repo-zones.ts';

const db = env.DB;
const zone = (id: string, orgId: string, extra = '') =>
  run(
    db,
    `INSERT INTO scan_zones (id, org_id, key, name, ${extra ? 'parent_id, ' : ''}created_at, updated_at)
     VALUES (?, ?, ?, ?, ${extra ? '?, ' : ''}1, 1)`,
    extra ? [id, orgId, id, id, extra] : [id, orgId, id, id],
  );
const refused = async (promise: Promise<unknown>) =>
  (await promise.then(
    () => null,
    (e: unknown) => e,
  )) as { code?: string } | null;

describe('zone grants', () => {
  it('a link to a zone of another org inserts nothing', async () => {
    const a = await setupGrant('zone-a');
    const b = await setupGrant('zone-b');
    await zone('za-1', a.s.org.id);
    await zone('zb-1', b.s.org.id);
    const g = grant(a.route, {
      purpose: 'org_mode.scan.session.update',
      principal: a.member(),
      tables: ['scanning_session_zones', 'scan_zones', 'scanning_sessions'],
    });
    addSessionZones(g, a.s.scanningSessionId, ['zb-1', 'za-1'], false);
    await g.commit();
    const rows = await all<{ zone_id: string }>(
      db,
      'SELECT zone_id FROM scanning_session_zones WHERE session_id = ?',
      [a.s.scanningSessionId],
    );
    expect(rows.map((r) => r.zone_id)).toEqual(['za-1']);
    // And a foreign session takes no link either.
    const h = grant(a.route, {
      purpose: 'org_mode.scan.session.update',
      principal: a.member(),
      tables: ['scanning_session_zones', 'scan_zones', 'scanning_sessions'],
    });
    addSessionZones(h, b.s.scanningSessionId, ['za-1'], false);
    await h.commit();
    expect(
      await first(db, 'SELECT 1 AS x FROM scanning_session_zones WHERE session_id = ?', [
        b.s.scanningSessionId,
      ]),
    ).toBeNull();
  });

  it('refuses a batch that names a zone of another org or an archived one', async () => {
    const a = await setupGrant('zone-open-a');
    const b = await setupGrant('zone-open-b');
    await zone('zoa-1', a.s.org.id);
    await zone('zob-1', b.s.org.id);
    await run(db, "UPDATE scan_zones SET archived_at = 5 WHERE id = 'zoa-1'");
    for (const id of ['zob-1', 'zoa-1']) {
      const g = grant(a.route, {
        purpose: 'org_mode.scan.session.update',
        principal: a.member(),
        checks: zonesOpen([id]),
        tables: ['scanning_session_zones', 'scan_zones', 'scanning_sessions'],
      });
      addSessionZones(g, a.s.scanningSessionId, [id], false);
      expect((await refused(g.commit()))?.code, id).toBe('SCAN_CONFIG_CHANGED');
    }
    expect(
      await first(db, 'SELECT 1 AS x FROM scanning_session_zones WHERE session_id = ?', [
        a.s.scanningSessionId,
      ]),
    ).toBeNull();
  });

  it('an edit of a zone of another org changes nothing and is refused', async () => {
    const a = await setupGrant('zone-edit-a');
    const b = await setupGrant('zone-edit-b');
    await zone('zeb-1', b.s.org.id);
    const g = grant(a.route, {
      purpose: 'org.scan.zone.update',
      principal: a.member(),
      tables: ['scan_zones'],
    });
    addZoneUpdate(g, 'zeb-1', { name: 'Taken' }, 9);
    expect((await refused(g.commit()))?.code).toBeTruthy();
    expect(
      (await first<{ name: string }>(db, "SELECT name FROM scan_zones WHERE id = 'zeb-1'"))?.name,
    ).toBe('zeb-1');
  });

  it('the commit-time tree check refuses a cycle and a fifth level', async () => {
    const a = await setupGrant('zone-tree');
    await zone('zt-1', a.s.org.id);
    await zone('zt-2', a.s.org.id, 'zt-1');
    await zone('zt-3', a.s.org.id, 'zt-2');
    await zone('zt-4', a.s.org.id, 'zt-3');
    const tryMove = async (id: string, parent: string) => {
      const g = grant(a.route, {
        purpose: 'org.scan.zone.update',
        principal: a.member(),
        checks: [zoneFitsUnder(id, parent)],
        tables: ['scan_zones'],
      });
      addZoneUpdate(g, id, { parentId: parent }, 9);
      return refused(g.commit());
    };
    expect((await tryMove('zt-1', 'zt-3'))?.code).toBe('SCAN_CONFIG_CHANGED');
    expect((await tryMove('zt-1', 'zt-1'))?.code).toBe('SCAN_CONFIG_CHANGED');
    await zone('zt-5', a.s.org.id);
    expect((await tryMove('zt-5', 'zt-4'))?.code).toBe('SCAN_CONFIG_CHANGED');
    expect(await tryMove('zt-5', 'zt-3')).toBeNull();
  });
});
