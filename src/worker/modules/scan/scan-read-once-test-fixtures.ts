// Shared by the join-once differentials: the actor fields the readers consult, a fence per actor, and seeded
// scanners, staff, scans, events and a photo of two orgs and both modes.
import type { passRow } from '../../platform/authority-checks.ts';
import { db } from '../../platform/authority-ext-fixtures.ts';
import { authorityPredicate } from '../../platform/authority-read.ts';
import type { Actor, Seed } from '../../platform/authority-read-join-fixtures.ts';
import { all, run } from '../../platform/db.ts';
import type { ScanActor } from './actor.ts';
import { apiKeyReadAuthority, type ScanReadAuthority } from './repo-read-authority.ts';

/** The scan actor fields the readers consult: no session, no event, every template accepted. */
export const scanner = {
  scanningSession: null,
  scanner: null,
  event: null,
  events: null,
  templateIds: [],
  settings: { acceptAllTemplates: true },
  invalidScannerScope: false,
  role: 'manager',
} as unknown as ScanActor;

export function fence(
  actor: Actor,
  now: number,
  checks?: ReturnType<typeof passRow>,
): ScanReadAuthority {
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
    rows: p.rows,
    anchor: p.anchor,
    present: p.ok,
    platform: p.platform,
    tenantOnce: (alias, table) => p.tenant(alias, table, 'org_mode'),
  };
}

export async function seedScanRows(s: Seed) {
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
