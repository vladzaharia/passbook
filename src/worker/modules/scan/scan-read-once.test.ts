// Differential: the scan readers on the join-once predicate return exactly the rows of their scalar-form
// originals (scan-read-once-legacy*.ts), for member, scanner (good and bad epoch), key and platform actors,
// over seeded scanners, staff, scans, events and photos of two orgs and both modes.
import { describe, expect, it } from 'vitest';
import { passRow } from '../../platform/authority-checks.ts';
import { db } from '../../platform/authority-ext-fixtures.ts';
import { authorityPredicate, tenantFilter } from '../../platform/authority-read.ts';
import { type Actor, actors, type Seed, seed } from '../../platform/authority-read-join-fixtures.ts';
import { all, run } from '../../platform/db.ts';
import type { ScanActor } from './actor.ts';
import { effectiveReleaseIdSql } from './effective-release.ts';
import type { LiveRingRow } from './live-ring.ts';
import type { LookupEntry } from './lookup-history.ts';
import { eventsStmt } from './repo-events.ts';
import { historyPageStmt } from './repo-history-rows.ts';
import { liveRecipientStmt, livePhotoStmt, liveRowsStmt } from './repo-live-render.ts';
import { livePlaceEventStmt } from './repo-live-places.ts';
import { lookupGateStmt, lookupPassesStmt } from './repo-lookup-final.ts';
import { apiKeyReadAuthority, type ScanReadAuthority } from './repo-read-authority.ts';
import { readStaffActivity, staffTimeZones } from './repo-staff-activity.ts';
import {
  legacyLiveRecipientStmt,
  legacyLivePhotoStmt,
  legacyLivePlaceEventStmt,
  legacyLiveRowsStmt,
  legacyLookupPassesStmt,
} from './scan-read-once-legacy.ts';
import {
  legacyEventsStmt,
  legacyHistoryPageStmt,
  legacyLookupGateStmt,
  legacyStaffActivityStmt,
  legacyTimeZonesStmt,
} from './scan-read-once-legacy-staff.ts';

/** The scan actor fields the readers consult: no session, no event, every template accepted. */
const scanner = {
  scanningSession: null,
  scanner: null,
  event: null,
  events: null,
  templateIds: [],
  settings: { acceptAllTemplates: true },
  invalidScannerScope: false,
  role: 'manager',
} as unknown as ScanActor;

function fence(actor: Actor, now: number, checks?: ReturnType<typeof passRow>): ScanReadAuthority {
  if (actor.platform && actor.principal.kind === 'api_key')
    return apiKeyReadAuthority(
      { keyId: actor.principal.keyId, orgId: null },
      actor.platform.named,
      now,
    );
  const p = authorityPredicate(actor.principal, {
    scope: 'org_mode',
    now,
    ...(checks ? { checks } : {}),
  });
  return {
    ctes: p.ctes,
    params: p.params,
    ok: 'EXISTS (SELECT 1 FROM actor_ok)',
    tenant: (alias, table) => tenantFilter(alias, table, 'org_mode'),
    rows: p.rows,
    anchor: p.anchor,
    present: p.ok,
    platform: p.platform,
    tenantOnce: (alias, table) => p.tenant(alias, table, 'org_mode'),
  };
}

async function seedScanRows(s: Seed) {
  const { a, b } = s;
  const staff = [
    ['st-a1', a.id, 'Ann', null],
    ['st-a2', a.id, 'Bo', 5],
    ['st-b1', b.id, 'Cy', null],
  ] as const;
  for (const [id, org, name, disabled] of staff)
    await run(
      db,
      `INSERT INTO scan_staff (id, org_id, name, role, pin_hash, pin_set_at, disabled_at, created_at, updated_at)
       VALUES (?, ?, ?, 'door', 'h', 1, ?, 1, 1)`,
      [`${s.ident(id)}`, org, name, disabled],
    );
  const places = [
    ['sc-a-live', a.id, 'live'],
    ['sc-a-test', a.id, 'test'],
    ['sc-b-live', b.id, 'live'],
  ] as const;
  for (const [id, org, mode] of places)
    await run(
      db,
      `INSERT INTO scanners (id, org_id, mode, kind, name, settings, time_zone, created_at, updated_at)
       VALUES (?, ?, ?, 'device', ?, '{}', 'UTC', 1, 1)`,
      [s.ident(id), org, mode, `Gate ${id}`],
    );
  const passes = await all<{ id: string; org_id: string; mode: string }>(
    db,
    'SELECT id, org_id, mode FROM passes WHERE org_id IN (?, ?) ORDER BY id',
    [a.id, b.id],
  );
  let n = 0;
  for (const p of passes) {
    const sc = p.org_id === a.id ? (p.mode === 'live' ? 'sc-a-live' : 'sc-a-test') : 'sc-b-live';
    const staffId = p.org_id === a.id ? 'st-a1' : 'st-b1';
    await run(
      db,
      `INSERT INTO scans (id, org_id, mode, pass_id, scanner_id, event_id, actor_type, actor_id, actor_key,
         staff_id, idempotency_key, request_hash, method, state, outcome, action_kind, at)
       VALUES (?, ?, ?, ?, ?, ?, 'scanner', ?, ?, ?, ?, 'r', 'camera', 'done', 'ok', 'check_in', ?)`,
      [
        s.ident(`scan-${n}`),
        p.org_id,
        p.mode,
        p.id,
        s.ident(sc),
        `se-${p.org_id}-${p.mode}`,
        s.ident(sc),
        `k${n}`,
        s.ident(staffId),
        `i${n}`,
        100 + n,
      ],
    );
    n++;
  }
  const photo = passes[0];
  if (photo)
    await run(
      db,
      `INSERT INTO member_photos (pass_id, org_id, r2_key, sha1, size, crc32, version, updated_at)
       VALUES (?, ?, 'k', 's', 1, 1, 'v1', 1)`,
      [photo.id, photo.org_id],
    );
  return passes;
}

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
      const at = (what: string) => `${actor.name}: ${what}`;
      await same(
        at('recipient'),
        legacyLiveRecipientStmt(db, auth, scanner, s.ident('sc-a-live')),
        liveRecipientStmt(db, auth, scanner, s.ident('sc-a-live')),
      );
      await same(
        at('rows'),
        legacyLiveRowsStmt(db, auth, scanner, ring),
        liveRowsStmt(db, auth, scanner, ring),
      );
      for (const entry of ring)
        await same(
          at('photo'),
          legacyLivePhotoStmt(db, auth, scanner, entry),
          livePhotoStmt(db, auth, scanner, entry),
        );
      for (const mode of ['live', 'test'] as const)
        await same(
          at(`place ${mode}`),
          legacyLivePlaceEventStmt(db, auth, s.a.id, mode, `se-${s.a.id}-${mode}`),
          livePlaceEventStmt(db, auth, s.a.id, mode, `se-${s.a.id}-${mode}`),
        );
      await same(
        at('lookup'),
        legacyLookupPassesStmt(db, auth, scanner, lookups, []),
        lookupPassesStmt(db, auth, scanner, lookups, []),
      );
      await same(at('gate'), legacyLookupGateStmt(db, auth), lookupGateStmt(db, auth));
      expect(await staffTimeZones(db, auth), at('zones')).toEqual(
        (await legacyTimeZonesStmt(db, auth).all<{ time_zone: string }>()).results.map(
          (r) => r.time_zone,
        ),
      );
      for (const filter of ['', ' AND e.archived_at IS NULL ORDER BY e.id LIMIT ?'])
        await same(
          at('events'),
          legacyEventsStmt(db, auth, filter, now),
          eventsStmt(db, auth, filter, filter ? [5] : [], now),
        );
      const sel = { where: 's.id IS NOT NULL', params: [], limit: 20 };
      await same(
        at('history'),
        legacyHistoryPageStmt(db, auth, { ...sel, tenant: auth.tenant('+s', 'scans') }, now),
        historyPageStmt(db, auth, { ...sel, tenant: auth.tenantOnce('+s', 'scans') }, now),
      );
      for (const zones of [['UTC'], []]) {
        const was = await legacyStaffActivityStmt(db, auth, zones, now, page, 'UTC').all();
        const is = await readStaffActivity(db, auth, zones, now, page, 'UTC');
        expect(is, at(`staff ${zones.length}`)).toEqual(was.results);
        expect(is.length, at('staff: a row at least')).toBeGreaterThan(0);
        if (is.some((r) => r.m_id !== null)) nonEmpty++;
      }
    }
    expect(nonEmpty).toBeGreaterThan(40);
  });
});
