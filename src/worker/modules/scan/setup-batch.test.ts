import { beforeEach, describe, expect, it } from 'vitest';
import { makeSession, makeUser } from '../../../../test/helpers/index.ts';
import { CreateScanEventSchema } from '../../../shared/contracts/index.ts';
import { CreateScanZoneSchema } from '../../../shared/contracts/scan-access.ts';
import { CreateScanStaffSchema } from '../../../shared/contracts/scanners.ts';
import {
  CreateScanningDeviceSchema,
  CreateScanningSessionSchema,
} from '../../../shared/contracts/scanning-sessions.ts';
import { grantedBatch } from '../../platform/authority.ts';
import { all, classifyD1Error, first } from '../../platform/db.ts';
import { createSessionStore } from '../auth/sessions.ts';
import { type TenantPassWrite, tenantAuthorityOf } from '../passes/http.ts';
import { planScanningDevice, scanningDeviceStatements } from './device-statements.ts';
import { createEvent } from './events-mutations.ts';
import { EVENT_CODES, eventStatements, planEvent } from './events-statements.ts';
import { adminGrant } from './repo-admin-grant.ts';
import { createScanningDevice } from './scanning-devices.ts';
import {
  insertScanningSession,
  planSession,
  sessionStatements,
} from './scanning-session-insert.ts';
import { newCapture, slotChecks } from './setup-capture.ts';
import { createStaff } from './staff-admin.ts';
import { planStaff, staffStatements } from './staff-statements.ts';
import { grantScanMembership, type ScanKit, setupScanKit } from './test-kit.ts';
import { createZone } from './zones.ts';
import { planZone, zoneStatements } from './zones-statements.ts';

let kit: ScanKit;
let authority: TenantPassWrite;
let session: NonNullable<Awaited<ReturnType<ReturnType<typeof createSessionStore>['resolve']>>>;
let userId: string;
let templateId: string;

beforeEach(async () => {
  kit = await setupScanKit();
  const user = await makeUser(kit.fx);
  userId = user.id;
  await grantScanMembership(kit.fx, kit.org.id, user.id);
  const made = await makeSession(kit.fx, { userId: user.id, roles: ['admin', 'user'] });
  const resolved = await createSessionStore(kit.env, kit.clock).resolve(made.cookieValue);
  if (resolved?.kind !== 'session') throw new Error('Missing session.');
  session = resolved;
  authority = await tenantAuthorityOf(kit.ctx, session, kit.org.id, 'scanning:manage');
  templateId = await kit.scanTemplate('Batch pass', {
    actions: [{ id: 'entry', label: 'Check in', kind: 'check_in' }],
  });
});

const day = 86_400_000;
const zoneInput = (key: string) =>
  CreateScanZoneSchema.parse({ orgId: kit.org.id, key, name: `Zone ${key}`, occupancy: 'track' });
const eventInput = (name: string) =>
  CreateScanEventSchema.parse({
    orgId: kit.org.id,
    name,
    opensAt: kit.clock.now(),
    closesAt: kit.clock.now() + day,
    timeZone: 'UTC',
    templateIds: [templateId],
  });
const staffInput = (name: string) =>
  CreateScanStaffSchema.parse({ orgId: kit.org.id, name, role: 'door' });
const sessionInput = (name: string, zoneIds: string[], eventId: string) =>
  CreateScanningSessionSchema.parse({
    orgId: kit.org.id,
    name,
    timeZone: 'UTC',
    zoneIds,
    accepts: { templateIds: [templateId], eventIds: [eventId] },
  });

const count = async (table: string) =>
  (
    await first<{ n: number }>(kit.env.DB, `SELECT COUNT(*) AS n FROM ${table} WHERE org_id = ?`, [
      kit.org.id,
    ])
  )?.n;

/** Plans every object, then one grant with all their checks, then every object's statements. */
async function runBatch(zoneKeys: string[], label: string) {
  const capture = newCapture({
    userId,
    authority,
    orgId: kit.org.id,
    mode: 'live',
    origin: 'https://wallet.test',
  });
  const zones = [];
  for (const key of zoneKeys) zones.push(await planZone(kit.ctx, zoneInput(key), capture));
  const event = await planEvent(kit.ctx, eventInput(`${label} event`), capture);
  const staff = await planStaff(kit.ctx, staffInput(`${label} staff`));
  const sess = await planSession(
    kit.ctx,
    sessionInput(`${label} session`, [zones[0]?.values.id ?? ''], event.values.id),
    capture,
  );
  const devices = [];
  const parent = capture.sessions.get(sess.id);
  if (!parent) throw new Error('Session not captured.');
  for (const [name, surface] of [
    [`${label} phone`, 'phone'],
    [`${label} operator`, 'operator'],
  ] as const)
    devices.push(
      await planScanningDevice(
        kit.ctx,
        parent,
        CreateScanningDeviceSchema.parse({ name, surface }),
        capture,
      ),
    );
  const g = adminGrant(
    kit.ctx,
    'org_mode.scan.setup.create',
    userId,
    authority,
    kit.org.id,
    [
      ...slotChecks(capture),
      ...[...zones, event, sess, ...devices.map((d) => d.plan)].flatMap((p) => p.checks),
    ],
    EVENT_CODES,
  );
  const out = {
    zones: zones.map((z) => zoneStatements(g, kit.ctx, z, capture)),
    event: eventStatements(g, kit.ctx, event, capture),
    staff: staffStatements(g, kit.ctx, staff, capture),
    session: sessionStatements(g, kit.ctx, sess, capture),
    devices: devices.map((d) => scanningDeviceStatements(g, kit.ctx, d.plan, capture)),
  };
  return { g, out, capture };
}

describe('one batch creates a setup', () => {
  it('commits a zone, an event, staff, a session linking both and two devices', async () => {
    const { g, out } = await runBatch(['front'], 'one');
    await grantedBatch(kit.env.DB, [g]);
    expect(out.zones).toHaveLength(1);
    expect(out.staff.pin).toMatch(/^\d{6}$/);
    expect(out.devices.every((d) => d.pairing?.code.length === 10)).toBe(true);
    const links = await all<{ zone_id: string }>(
      kit.env.DB,
      'SELECT zone_id FROM scanning_session_zones WHERE session_id = ?',
      [out.session.id],
    );
    expect(links.map((l) => l.zone_id)).toEqual([out.zones[0]?.id]);
    const sess = await first<{ accepts: string }>(
      kit.env.DB,
      'SELECT accepts FROM scanning_sessions WHERE id = ?',
      [out.session.id],
    );
    expect(JSON.parse(sess?.accepts ?? '{}').eventIds).toEqual([out.event.id]);
    const members = await all<{
      scanner_id: string;
      pair_code_hash: string;
      pair_expires_at: number;
    }>(
      kit.env.DB,
      `SELECT d.scanner_id, s.pair_code_hash, s.pair_expires_at FROM scanning_devices d
       JOIN scanners s ON s.id = d.scanner_id WHERE d.session_id = ?`,
      [out.session.id],
    );
    expect(members.map((m) => m.scanner_id).sort()).toEqual(out.devices.map((d) => d.id).sort());
    expect(members.every((m) => m.pair_code_hash && m.pair_expires_at > kit.clock.now())).toBe(
      true,
    );
    expect(
      await first(kit.env.DB, 'SELECT 1 AS x FROM scan_event_templates WHERE event_id = ?', [
        out.event.id,
      ]),
    ).not.toBeNull();
  });

  it('writes nothing when a late statement fails', async () => {
    const before = {
      zones: await count('scan_zones'),
      events: await count('scan_events'),
      staff: await count('scan_staff'),
      sessions: await count('scanning_sessions'),
      scanners: await count('scanners'),
      audit: await count('audit_log'),
    };
    const { g } = await runBatch(['dup', 'dup'], 'two');
    const error = await grantedBatch(kit.env.DB, [g]).then(
      () => null,
      (e: unknown) => e,
    );
    expect(classifyD1Error(error)?.kind).toBe('unique');
    expect({
      zones: await count('scan_zones'),
      events: await count('scan_events'),
      staff: await count('scan_staff'),
      sessions: await count('scanning_sessions'),
      scanners: await count('scanners'),
      audit: await count('audit_log'),
    }).toEqual(before);
  });

  it('audits the same rows as the per-object creates', async () => {
    const lastAudit = async () =>
      (await first<{ n: number }>(kit.env.DB, 'SELECT COALESCE(MAX(id), 0) AS n FROM audit_log'))
        ?.n ?? 0;
    const since = async (from: number) =>
      (
        await all<{
          action: string;
          target_type: string;
          actor_type: string;
          detail: string | null;
        }>(
          kit.env.DB,
          'SELECT action, target_type, actor_type, detail FROM audit_log WHERE id > ? ORDER BY id',
          [from],
        )
      ).map((r) => ({
        ...r,
        detail: (r.detail ?? '').replace(/"expiresAt":\d+/, '"expiresAt":0'),
      }));
    const start = await lastAudit();
    const zone = await createZone(kit.ctx, userId, zoneInput('solo'), authority as never, 'live');
    const event = await createEvent(kit.ctx, userId, 'live', eventInput('solo event'), authority);
    await createStaff(kit.ctx, session, authority as never, 'live', staffInput('solo staff'));
    const sid = await insertScanningSession(
      kit.ctx,
      userId,
      'live',
      sessionInput('solo session', [zone.id], event.id),
      authority,
    );
    await createScanningDevice(
      kit.ctx,
      userId,
      'live',
      sid,
      CreateScanningDeviceSchema.parse({ name: 'solo phone', surface: 'phone' }),
      'https://wallet.test',
      authority,
    );
    const single = await since(start);
    const mid = await lastAudit();
    const { g } = await runBatch(['front'], 'three');
    await grantedBatch(kit.env.DB, [g]);
    const batched = await since(mid);
    const first1 = (list: typeof single, action: string) => list.find((r) => r.action === action);
    const actions = [...new Set(single.map((r) => r.action))];
    expect(actions.length).toBeGreaterThanOrEqual(6);
    expect([...new Set(batched.map((r) => r.action))].sort()).toEqual([...actions].sort());
    for (const action of actions)
      expect(first1(batched, action), action).toEqual(first1(single, action));
    // Two devices, each with its setup and pairing rows.
    expect(batched.filter((r) => r.action === 'scanner.setup_create')).toHaveLength(2);
    expect(batched.filter((r) => r.action === 'scanner.pairing_create')).toHaveLength(2);
  });
});
