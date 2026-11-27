// Differential: the scan readers on the join-once predicate return exactly the rows of their scalar-form
// originals (repo-read-once-legacy*.ts), for member, scanner (good and bad epoch), key and platform actors,
// over seeded scanners, staff, scans, events and photos of two orgs and both modes.
import { describe, expect, it } from 'vitest';
import { passRow } from '../../platform/authority-checks.ts';
import { db } from '../../platform/authority-ext-fixtures.ts';
import { actors, seed } from '../../platform/authority-read-join-fixtures.ts';
import { all } from '../../platform/db.ts';
import { effectiveReleaseIdSql } from './effective-release.ts';
import type { LiveRingRow } from './live-ring.ts';
import type { LookupEntry } from './lookup-history.ts';
import { eventsStmt } from './repo-events.ts';
import { historyPageStmt } from './repo-history-rows.ts';
import { livePlaceEventStmt } from './repo-live-places.ts';
import { livePhotoStmt, liveRecipientStmt, liveRowsStmt } from './repo-live-render.ts';
import { lookupGateStmt, lookupPassesStmt } from './repo-lookup-final.ts';
import {
  legacyLivePhotoStmt,
  legacyLivePlaceEventStmt,
  legacyLiveRecipientStmt,
  legacyLiveRowsStmt,
  legacyLookupPassesStmt,
} from './repo-read-once-legacy.ts';
import { legacyOf } from './repo-read-once-legacy-auth.ts';
import {
  legacyEventsStmt,
  legacyHistoryPageStmt,
  legacyLookupGateStmt,
  legacyStaffActivityStmt,
  legacyTimeZonesStmt,
} from './repo-read-once-legacy-staff.ts';
import { readStaffActivity, staffTimeZones } from './repo-staff-activity.ts';
import { fence, scanner, seedScanRows } from './scan-read-once-test-fixtures.ts';

describe('scan readers on the join-once predicate equal their scalar originals', () => {
  it('returns the same rows for every actor kind', async () => {
    const s = await seed();
    const passes = await seedScanRows(s);
    const now = s.f.clock.now();
    const scanIds = await all<{ id: string; pass_id: string }>(
      db,
      'SELECT id, pass_id FROM scans WHERE org_id IN (?, ?)',
      [s.a.id, s.b.id],
    );
    const generations = await all<{
      id: string;
      c: number;
      l: number;
      i: number;
      rel: string | null;
    }>(
      db,
      `SELECT p.id, p.credential_generation AS c, p.lifecycle_generation AS l, p.image_generation AS i,
         ${effectiveReleaseIdSql('p')} AS rel FROM passes p WHERE p.org_id IN (?, ?)`,
      [s.a.id, s.b.id],
    );
    const ring = [
      ...scanIds.map((x) => ({ scan: x.id, pass: x.pass_id })),
      { scan: null, pass: passes[0]?.id ?? '' },
    ].flatMap(({ scan, pass }) => {
      const g = generations.find((x) => x.id === pass);
      if (!g) return [];
      return [
        {
          row: { passId: pass },
          scanId: scan,
          gen: { credential: g.c, lifecycle: g.l, image: g.i },
          release: g.rel,
          refPrefixes: [],
          sourceStaff: scan ? { id: s.ident('st-a1'), authEpoch: 1 } : null,
        } as unknown as LiveRingRow,
      ];
    });
    const lookups = generations.map(
      (g) =>
        ({
          source: {
            pass: {
              id: g.id,
              credentialGeneration: g.c,
              lifecycleGeneration: g.l,
              imageGeneration: g.i,
            },
            templateSnapshot: null,
          },
        }) as unknown as LookupEntry,
    );
    const page = { limit: 10, q: undefined } as const;
    let nonEmpty = 0;
    const same = async (
      name: string,
      was: D1PreparedStatement | null,
      is: D1PreparedStatement | null,
    ) => {
      expect(is === null, `${name}: both or neither`).toBe(was === null);
      if (!was || !is) return;
      const [a, b] = [await was.all(), await is.all()];
      expect(b.results, name).toEqual(a.results);
      if (a.results.length > 0) nonEmpty++;
    };
    for (const actor of await actors(s)) {
      if (actor.scope === 'platform' && !actor.platform) continue;
      const checks = actor.check
        ? passRow(actor.check === 'own' ? s.w.a.pass : (s.tb.passes.live ?? ''))
        : undefined;
      const auth = fence(actor, now, checks);
      const old = legacyOf(auth);
      const at = (what: string) => `${actor.name}: ${what}`;
      await same(
        at('recipient'),
        legacyLiveRecipientStmt(db, old, scanner, s.ident('sc-a-live')),
        liveRecipientStmt(db, auth, scanner, s.ident('sc-a-live')),
      );
      await same(
        at('rows'),
        legacyLiveRowsStmt(db, old, scanner, ring),
        liveRowsStmt(db, auth, scanner, ring),
      );
      for (const entry of ring)
        await same(
          at('photo'),
          legacyLivePhotoStmt(db, old, scanner, entry),
          livePhotoStmt(db, auth, scanner, entry),
        );
      for (const mode of ['live', 'test'] as const)
        await same(
          at(`place ${mode}`),
          legacyLivePlaceEventStmt(db, old, s.a.id, mode, `se-${s.a.id}-${mode}`),
          livePlaceEventStmt(db, auth, s.a.id, mode, `se-${s.a.id}-${mode}`),
        );
      await same(
        at('lookup'),
        legacyLookupPassesStmt(db, old, scanner, lookups, []),
        lookupPassesStmt(db, auth, scanner, lookups, []),
      );
      await same(at('gate'), legacyLookupGateStmt(db, old), lookupGateStmt(db, auth));
      expect(await staffTimeZones(db, auth), at('zones')).toEqual(
        (await legacyTimeZonesStmt(db, old).all<{ time_zone: string }>()).results.map(
          (r) => r.time_zone,
        ),
      );
      for (const filter of ['', ' AND e.archived_at IS NULL ORDER BY e.id LIMIT ?'])
        await same(
          at('events'),
          legacyEventsStmt(db, old, filter, filter ? [5] : [], now),
          eventsStmt(db, auth, filter, filter ? [5] : [], now),
        );
      const sel = { where: 's.id IS NOT NULL', params: [], limit: 20 };
      await same(
        at('history'),
        legacyHistoryPageStmt(db, old, { ...sel, tenant: old.tenant('+s', 'scans') }, now),
        historyPageStmt(db, auth, { ...sel, tenant: auth.tenantOnce('+s', 'scans') }, now),
      );
      // A platform key's tenant names a mode; staff have none, and the feed never reads them.
      for (const zones of actor.platform ? [] : [['UTC'], []]) {
        const was = await legacyStaffActivityStmt(db, old, zones, now, page, 'UTC').all();
        const is = await readStaffActivity(db, auth, zones, now, page, 'UTC');
        expect(is, at(`staff ${zones.length}`)).toEqual(was.results);
        expect(is.length, at('staff: a row at least')).toBeGreaterThan(0);
        if (is.some((r) => r.m_id !== null)) nonEmpty++;
      }
    }
    expect(nonEmpty).toBeGreaterThan(40);
  });
});
