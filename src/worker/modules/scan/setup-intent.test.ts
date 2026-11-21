import { beforeAll, describe, expect, it } from 'vitest';
import { all, first } from '../../platform/db.ts';
import { door, fixture, made, post } from './setup-intent-test-fixtures.ts';

let templateId: string;
beforeAll(async () => {
  await fixture.setup();
  templateId = await fixture.kit.scanTemplate('Setup pass', {
    actions: [{ id: 'entry', label: 'Check in', kind: 'check_in' }],
  });
});

const rows = (sql: string, ...binds: string[]) =>
  all<Record<string, unknown>>(fixture.kit.env.DB, sql, binds);
const orgId = () => fixture.kit.org.id;

describe('front desk preset', () => {
  it('makes a counted place, a staff member and a session with two devices in one call', async () => {
    const result = await made(
      await post({
        orgId: orgId(),
        preset: 'front_desk',
        places: [{ ref: 'gym', name: 'Gym', max: 50 }],
        staff: [{ name: 'Maya Chen', role: 'manager' }],
        doors: [door(templateId, { place: 'gym' })],
      }),
    );
    expect(result).toMatchObject({ replayed: false, mode: 'live', pairingReissued: false });
    expect(result.zones).toMatchObject([{ ref: 'gym', name: 'Gym', created: true }]);
    expect(result.staff[0]?.pin).toMatch(/^\d{6}$/);
    const [session] = result.sessions;
    expect(session?.devices).toHaveLength(2);
    expect(session?.devices.every((d) => d.pairing?.code.length === 10)).toBe(true);
    const zone = await first<Record<string, unknown>>(
      fixture.kit.env.DB,
      'SELECT occupancy, capacity, max_stay_minutes AS stay FROM scan_zones WHERE id = ?',
      [result.zones[0]?.id ?? ''],
    );
    expect(zone).toEqual({ occupancy: 'track', capacity: 50, stay: 720 });
    const stored = await first<{ settings: string; accepts: string }>(
      fixture.kit.env.DB,
      'SELECT settings, accepts FROM scanning_sessions WHERE id = ?',
      [session?.id ?? ''],
    );
    expect(JSON.parse(stored?.settings ?? '{}')).toMatchObject({
      staffSignIn: true,
      lookup: true,
      showPhoto: true,
      deskActions: true,
    });
    expect(JSON.parse(stored?.accepts ?? '{}').templateIds).toEqual([templateId]);
    expect(
      await rows(
        'SELECT action FROM audit_log WHERE action = ? AND target_id = ?',
        'scan.setup.apply',
        session?.id ?? '',
      ),
    ).toHaveLength(1);
  });
});

describe('event night preset', () => {
  it('makes an event door with no zones, anyone scanning and test-free live objects', async () => {
    const day = 86_400_000;
    const now = fixture.kit.clock.now();
    const result = await made(
      await post({
        orgId: orgId(),
        preset: 'event_night',
        events: [
          {
            ref: 'gala',
            name: 'Saturday gala',
            templateIds: [templateId],
            opensAt: now,
            closesAt: now + day,
            max: 300,
            reentry: false,
          },
        ],
        doors: [
          {
            name: 'Gala door',
            admits: { events: ['gala'] },
          },
        ],
      }),
    );
    expect(result.events).toMatchObject([{ ref: 'gala', name: 'Saturday gala', created: true }]);
    expect(result.zones).toEqual([]);
    expect(result.staff).toEqual([]);
    const event = await first<Record<string, unknown>>(
      fixture.kit.env.DB,
      'SELECT capacity, reentry, mode FROM scan_events WHERE id = ?',
      [result.events[0]?.id ?? ''],
    );
    expect(event).toEqual({ capacity: 300, reentry: 0, mode: 'live' });
    const stored = await first<{ settings: string }>(
      fixture.kit.env.DB,
      'SELECT settings FROM scanning_sessions WHERE id = ?',
      [result.sessions[0]?.id ?? ''],
    );
    expect(JSON.parse(stored?.settings ?? '{}')).toMatchObject({ staffSignIn: false });
  });
});

describe('venue preset', () => {
  it('makes nested places and one session per door, devices named after the door', async () => {
    const result = await made(
      await post({
        orgId: orgId(),
        preset: 'venue',
        places: [
          { ref: 'club', name: 'Club', max: 200 },
          { ref: 'vip', name: 'VIP', inside: 'club', max: 20 },
        ],
        doors: [
          door(templateId, { name: 'Main door', place: 'club' }),
          door(templateId, { name: 'VIP door', place: 'vip' }),
        ],
      }),
    );
    expect(result.zones.map((z) => z.name)).toEqual(['Club', 'VIP']);
    expect(result.sessions.map((s) => s.name)).toEqual(['Main door', 'VIP door']);
    expect(result.sessions[0]?.devices[0]?.name).toBe('Main door 1');
    const vip = await first<{ parent_id: string }>(
      fixture.kit.env.DB,
      'SELECT parent_id FROM scan_zones WHERE id = ?',
      [result.zones[1]?.id ?? ''],
    );
    expect(vip?.parent_id).toBe(result.zones[0]?.id);
  });

  it('picks a free name when one is taken', async () => {
    const first1 = await made(
      await post({
        orgId: orgId(),
        places: [{ ref: 'a', name: 'Lobby' }],
        staff: [{ name: 'Sam', role: 'door' }],
        doors: [door(templateId, { name: 'Lobby door' })],
      }),
    );
    const second = await made(
      await post({
        orgId: orgId(),
        places: [{ ref: 'a', name: 'Lobby' }],
        staff: [{ name: 'Sam', role: 'door' }],
        doors: [door(templateId, { name: 'Lobby door' })],
      }),
    );
    expect(first1.zones[0]?.name).toBe('Lobby');
    expect(second.zones[0]?.name).toBe('Lobby 2');
    expect(second.staff[0]?.name).toBe('Sam 2');
    expect(second.sessions[0]?.devices[0]?.name).toBe('Lobby door 2');
  });
});

describe('dry run', () => {
  it('answers the plan and its checks and writes nothing', async () => {
    const before = await rows(
      'SELECT COUNT(*) AS n FROM scanning_sessions WHERE org_id = ?',
      orgId(),
    );
    const res = await post(
      {
        orgId: orgId(),
        places: [{ ref: 'gym', name: 'Dry gym', max: 5 }],
        doors: [door(templateId, { name: 'Dry door' })],
      },
      fixture.fake.admin(),
      null,
      '?dryRun=true',
    );
    expect(res.status).toBe(200);
    const plan = (await res.json()) as {
      zones: { ref: string }[];
      checks: unknown[];
      sessions: { ref: string }[];
    };
    expect(plan.zones[0]?.ref).toBe('gym');
    expect(plan.sessions).toHaveLength(1);
    expect(
      await rows('SELECT COUNT(*) AS n FROM scanning_sessions WHERE org_id = ?', orgId()),
    ).toEqual(before);
  });
});
