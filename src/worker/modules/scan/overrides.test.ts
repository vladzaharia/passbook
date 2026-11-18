import { beforeAll, describe, expect, it } from 'vitest';
import { TEST_NOW } from '../../../../test/helpers/index.ts';
import { all, run } from '../../platform/db.ts';
import { accessTemplate, makeDoor, makeZone } from './access-test-fixtures.ts';
import { act, HOUR, kit, MINUTE, out, setupActionFixture } from './act-test-fixtures.ts';
import { scanAt, trackedZone } from './occupancy-scan-test-fixtures.ts';
import { resolvedTarget } from './override-scope.ts';
import { bodyOf, doorAndMonitor, overrideAs, scanById, signIn } from './overrides-test-fixtures.ts';
import { recoverScans } from './recover.ts';
import { codeOf, key } from './test-kit.ts';

beforeAll(setupActionFixture);

/** A person held at the gym door (still inside), the scan id of that hold. */
async function held(opts: Parameters<typeof doorAndMonitor>[2] = {}) {
  const tpl = await accessTemplate();
  const gym = await trackedZone({ occupancy: 'enforce' });
  const rig = await doorAndMonitor(tpl, [gym], opts);
  const pass = await kit.scanPass(tpl, { plan: 'gold' });
  await scanAt(rig.door, pass);
  kit.clock.advance(5 * MINUTE);
  await rig.bind();
  const hold = await scanAt(rig.door, pass);
  expect(hold).toMatchObject({ kind: 'heads_up', reason: 'still_inside' });
  return { tpl, gym, pass, hold: hold.scanId as string, ...rig };
}

describe('desk overrides', () => {
  it('lets a held person in from a monitor of the same session, records the grant and audits it', async () => {
    const r = await held();
    const res = await overrideAs(r.monitor.headers, r.hold, { note: 'forgot_out' });
    expect(res.status).toBe(200);
    const body = await bodyOf(res);
    expect(body).toMatchObject({ kind: 'ok', replay: false });
    const row = await scanById(body.scanId as string);
    expect(row).toMatchObject({
      override_of: r.hold,
      outcome: 'ok',
      actor_key: `s:${r.monitor.id}`,
      override_note: 'forgot_out',
    });
    const audit = await all<{ detail: string }>(
      kit.env.DB,
      "SELECT detail FROM audit_log WHERE action = 'scan.override' AND target_id = ?",
      [body.scanId as string],
    );
    expect(JSON.parse(audit[0]?.detail ?? '{}')).toMatchObject({ via: 'monitor', of: r.hold });
    // `since` reset: the forced re-entry is a new stay.
    const [presence] = await all<{ entered_at: number }>(
      kit.env.DB,
      'SELECT entered_at FROM scan_presence WHERE pass_id = ? AND scope = ?',
      [r.pass.id, `zone:${r.gym}`],
    );
    expect(presence?.entered_at).toBe(kit.clock.now());
  });

  it('refuses after 15 minutes, outside the watch and an unknown id alike', async () => {
    const r = await held();
    const other = await doorAndMonitor(r.tpl, [r.gym]);
    const shape = async (res: Response) => {
      const { code, detail } = (await res.json()) as Record<string, unknown>;
      return { status: res.status, code, detail };
    };
    const unknown = await shape(await overrideAs(r.monitor.headers, 'no-such-scan'));
    expect(unknown).toMatchObject({ status: 422, code: 'SCAN_OVERRIDE_INVALID' });
    expect(await shape(await overrideAs(other.monitor.headers, r.hold))).toEqual(unknown);
    kit.clock.advance(16 * MINUTE);
    await r.bind();
    expect(await shape(await overrideAs(r.monitor.headers, r.hold))).toEqual(unknown);
  });

  it('lets the same scan in once: the second gets SCAN_OVERRIDE_TAKEN', async () => {
    const r = await held();
    expect((await overrideAs(r.monitor.headers, r.hold)).status).toBe(200);
    const second = await overrideAs(r.monitor.headers, r.hold);
    expect(second.status).toBe(409);
    expect(await second.text()).toContain('SCAN_OVERRIDE_TAKEN');
  });

  it('lets one of two racing overrides win', async () => {
    const r = await held();
    const second = await kit.scanner({ templateIds: [r.tpl], deviceRole: 'monitor' });
    await run(
      kit.env.DB,
      `INSERT INTO scanning_devices (scanner_id,session_id,org_id,mode,surface,effective_surface,overrides)
       SELECT id,?,org_id,mode,'desk','desk','{}' FROM scanners WHERE id=?`,
      [r.sessionId, second.id],
    );
    await signIn(second.id, r.staff.id);
    const [a, b] = await Promise.all([
      overrideAs(r.monitor.headers, r.hold),
      overrideAs(second.headers, r.hold),
    ]);
    expect([a.status, b.status].sort()).toEqual([200, 409]);
    const wins = await all<{ n: number }>(
      kit.env.DB,
      "SELECT count(*) AS n FROM scans WHERE override_of = ? AND outcome = 'ok'",
      [r.hold],
    );
    expect(wins[0]?.n).toBe(1);
  });

  it('does not let a hard refusal through', async () => {
    const tpl = await accessTemplate();
    const rig = await doorAndMonitor(tpl, []);
    const pass = await kit.scanPass(tpl, { plan: 'gold' });
    await run(kit.env.DB, "UPDATE passes SET status = 'voided' WHERE id = ?", [pass.id]);
    const refused = await scanAt(rig.door, pass);
    expect(refused).toMatchObject({ kind: 'refused', reason: 'voided' });
    const res = await overrideAs(rig.monitor.headers, refused.scanId);
    expect(res.status).toBe(422);
  });

  it('honours the refusing door: letInAgain never closes it for the desk', async () => {
    const r = await held({ letInAgain: 'never' });
    const res = await overrideAs(r.monitor.headers, r.hold);
    expect(res.status).toBe(403);
    expect(await res.text()).toContain('SCAN_OVERRIDE_FORBIDDEN');
  });

  it('needs a Manager over a guest who is out of visits, and lets a Manager PIN through', async () => {
    const tpl = await accessTemplate();
    const rig = await doorAndMonitor(tpl, [], { role: 'door' });
    const pass = await kit.scanPass(tpl, { plan: 'guest', visits: 1 });
    expect((await scanAt(rig.door, pass)).kind).toBe('ok');
    kit.clock.advance(3 * HOUR);
    await rig.bind();
    const refused = await scanAt(rig.door, pass);
    expect(refused).toMatchObject({ kind: 'refused', reason: 'guest_visits_used' });
    const held = await bodyOf(await overrideAs(rig.monitor.headers, refused.scanId));
    expect(held).toMatchObject({ kind: 'heads_up', reason: 'needs_approval' });
    const manager = await kit.staff('manager');
    const approved = await overrideAs(rig.monitor.headers, refused.scanId, {
      approval: { staffId: manager.id, pin: manager.pin },
    });
    const final = await bodyOf(approved);
    expect({ kind: final.kind, reason: final.reason }).toEqual({ kind: 'ok', reason: null });
    expect((await scanById(refused.scanId as string))?.outcome).toBe('refused');
  });

  it('is refused for a monitor with Desk actions off, a customer screen, and without a signed-in person', async () => {
    const off = await held({ deskActions: false });
    const offRes = await overrideAs(off.monitor.headers, off.hold);
    expect(offRes.status).toBe(403);
    expect(await offRes.text()).toContain('SCREEN_ONLY');
    const customer = await held({ deviceRole: 'customer' });
    const customerRes = await overrideAs(customer.monitor.headers, customer.hold);
    expect(customerRes.status).toBe(403);
    expect(await customerRes.text()).toContain('SCREEN_ONLY');
    const staff = await held({ unattended: true });
    const noOne = await overrideAs(staff.monitor.headers, staff.hold);
    expect(noOne.status).toBe(403);
    expect(await noOne.text()).toContain('STAFF_REQUIRED');
  });

  it('stops at 120 an hour with 429', async () => {
    const r = await held();
    const now = kit.clock.now();
    await run(kit.env.DB, 'INSERT INTO counters (key, window_start, count) VALUES (?, ?, 120)', [
      `scan:ovr:s:${r.monitor.id}`,
      now - (now % 3_600_000),
    ]);
    const res = await overrideAs(r.monitor.headers, r.hold);
    expect(res.status).toBe(429);
    expect(await res.text()).toContain('SCAN_TOO_MANY_OVERRIDES');
    expect((await scanById(r.hold))?.outcome).toBe('heads_up');
  });

  it('takes a note for two minutes, once, from the same actor only', async () => {
    const r = await held();
    const done = await bodyOf(await overrideAs(r.monitor.headers, r.hold));
    const path = `/overrides/${done.scanId}/note`;
    expect((await kit.post(r.door.headers, path, { note: 'paid' })).status).toBe(422);
    expect((await kit.post(r.monitor.headers, path, { note: 'paid' })).status).toBe(204);
    expect((await scanById(done.scanId as string))?.override_note).toBe('paid');
    expect((await kit.post(r.monitor.headers, path, { note: 'known' })).status).toBe(422);
    const late = await bodyOf(await overrideAs(r.monitor.headers, (await held()).hold));
    kit.clock.advance(3 * MINUTE);
    await r.bind();
    expect(
      (await kit.post(r.monitor.headers, `/overrides/${late.scanId}/note`, { note: 'known' }))
        .status,
    ).toBe(422);
  });

  it('tells only the refusing device, never the one that acted', async () => {
    const r = await held();
    const actor = { scanner: { id: r.monitor.id } } as never;
    expect(resolvedTarget(actor, { scannerId: r.door.scanner.id })).toBe(r.door.scanner.id);
    expect(resolvedTarget(actor, { scannerId: r.monitor.id })).toBeNull();
    expect(resolvedTarget(actor, { scannerId: null })).toBeNull();
    void makeDoor;
    void key;
  });
});

describe('a held entry names the zone to tap in at first', () => {
  it('puts the enforcing parent on a not_inside hold', async () => {
    const tpl = await accessTemplate();
    const gym = await trackedZone({ occupancy: 'enforce' });
    const pool = await trackedZone({ occupancy: 'track', parentId: gym });
    const door = await makeDoor([tpl], [pool]);
    const pass = await kit.scanPass(tpl, { plan: 'gold' });
    const [row] = await all<{ name: string }>(
      kit.env.DB,
      'SELECT name FROM scan_zones WHERE id = ?',
      [gym],
    );
    expect(await scanAt(door, pass)).toMatchObject({
      kind: 'heads_up',
      reason: 'not_inside',
      occupancy: { parent: { id: gym, name: row?.name } },
    });
  });
});

describe('access refusals a Manager lets through', () => {
  const iso = (t: number) => new Date(t).toISOString();
  type Setup = () => Promise<{
    tpl: string;
    zones: string[];
    pass: { scanCode: string | null };
    reason: string;
  }>;
  const cases: Record<string, Setup> = {
    zone_not_included: async () => {
      const tpl = await accessTemplate();
      const gone = await makeZone('gym-room');
      return {
        tpl,
        zones: [gone],
        pass: await kit.scanPass(tpl, { plan: 'pool_only' }),
        reason: 'zone_not_included',
      };
    },
    outside_hours: async () => {
      const tpl = await accessTemplate();
      kit.clock.set(TEST_NOW + 8 * HOUR);
      return {
        tpl,
        zones: [],
        pass: await kit.scanPass(tpl, { plan: 'off_peak' }),
        reason: 'outside_hours',
      };
    },
    guest_expired: async () => {
      const tpl = await accessTemplate();
      const pass = await kit.scanPass(tpl, { plan: 'guest', validUntil: iso(TEST_NOW - MINUTE) });
      return { tpl, zones: [], pass, reason: 'guest_expired' };
    },
    not_yet_valid: async () => {
      const tpl = await accessTemplate();
      const pass = await kit.scanPass(tpl, { plan: 'gold', validFrom: iso(TEST_NOW + HOUR) });
      return { tpl, zones: [], pass, reason: 'not_yet_valid' };
    },
  };
  for (const [name, setup] of Object.entries(cases))
    it(`admits a refused ${name} on a Manager's PIN, and not without it`, async () => {
      const c = await setup();
      const rig = await doorAndMonitor(c.tpl, c.zones, { role: 'door' });
      const refused = await out(await act(rig.door.headers, codeOf(c.pass as never)));
      expect(refused).toMatchObject({ kind: 'refused', reason: c.reason });
      const manager = await kit.staff('manager');
      const asked = await bodyOf(await overrideAs(rig.monitor.headers, refused.scanId));
      expect(asked).toMatchObject({ kind: 'heads_up', reason: 'needs_approval' });
      const through = await bodyOf(
        await overrideAs(rig.monitor.headers, refused.scanId, {
          approval: { staffId: manager.id, pin: manager.pin },
        }),
      );
      expect(through).toMatchObject({ kind: 'ok', reason: null });
      kit.clock.set(TEST_NOW);
    });

  it('keeps a suspended pass final', async () => {
    const tpl = await accessTemplate();
    const rig = await doorAndMonitor(tpl, []);
    const pass = await kit.scanPass(tpl, { plan: 'gold', status: 'Suspended' });
    const refused = await out(await act(rig.door.headers, codeOf(pass)));
    expect(refused).toMatchObject({ kind: 'refused', reason: 'suspended' });
    expect((await overrideAs(rig.monitor.headers, refused.scanId)).status).toBe(422);
  });
});

describe('a full place', () => {
  async function full(opts: Parameters<typeof doorAndMonitor>[2] = {}) {
    const tpl = await accessTemplate();
    const gym = await trackedZone({ occupancy: 'enforce', capacity: 1 });
    const rig = await doorAndMonitor(tpl, [gym], opts);
    await scanAt(rig.door, await kit.scanPass(tpl, { plan: 'gold' }));
    const second = await kit.scanPass(tpl, { plan: 'gold' });
    const held = await scanAt(rig.door, second);
    expect(held).toMatchObject({ kind: 'heads_up', reason: 'capacity_full' });
    return { ...rig, held, second };
  }

  it('follows who can admit again: anyone lets a Desk person fill it', async () => {
    const r = await full();
    expect(await bodyOf(await overrideAs(r.monitor.headers, r.held.scanId))).toMatchObject({
      kind: 'ok',
    });
  });

  it('follows the door: manager asks for a PIN, never closes it', async () => {
    const manager = await full({ letInAgain: 'manager' });
    expect(
      await bodyOf(await overrideAs(manager.monitor.headers, manager.held.scanId)),
    ).toMatchObject({
      reason: 'needs_approval',
    });
    const never = await full({ letInAgain: 'never' });
    expect((await overrideAs(never.monitor.headers, never.held.scanId)).status).toBe(403);
  });

  it('a Hard limit refuses every role, and the door does not offer Let in', async () => {
    const r = await full({ hardLimit: true, role: 'desk' });
    expect(r.held.overridable).toBe(false);
    const res = await overrideAs(r.monitor.headers, r.held.scanId);
    expect(res.status).toBe(403);
  });
});

describe('an unattended monitor', () => {
  it('acts for nobody: override and mark-out answer STAFF_REQUIRED', async () => {
    const r = await held({ unattended: true });
    for (const res of [
      await overrideAs(r.monitor.headers, r.hold),
      await kit.post(r.monitor.headers, '/mark-out', {
        idempotencyKey: key(),
        passId: r.pass.id,
        place: `zone:${r.gym}`,
      }),
    ]) {
      expect(res.status).toBe(403);
      expect(await res.text()).toContain('STAFF_REQUIRED');
    }
  });
});

describe('a losing override claim and recovery', () => {
  it('a pending override claim is retried, not quarantined, by recovery', async () => {
    const r = await held();
    const id = kit.fx.ids.ordered();
    await run(
      kit.env.DB,
      `INSERT INTO scans (id, org_id, mode, scanner_id, actor_type, actor_id, actor_key, idempotency_key, request_hash,
         method, state, override_of, at) VALUES (?, ?, 'live', ?, 'scanner', ?, ?, ?, 'h', 'manual', 'pending', ?, ?)`,
      [
        id,
        kit.org.id,
        r.monitor.id,
        r.monitor.id,
        `s:${r.monitor.id}`,
        key(),
        r.hold,
        kit.clock.now() - HOUR,
      ],
    );
    const [row] = await all<Record<string, unknown>>(
      kit.env.DB,
      'SELECT * FROM scans WHERE id = ?',
      [id],
    );
    const scan = (await import('./repo-scans.ts')).scanById;
    const pending = await scan(kit.env.DB, kit.org.id, id);
    expect(row).toBeTruthy();
    await recoverScans(kit.ctx, pending ? [pending] : []);
    const [after] = await all<{ state: string; reason: string | null }>(
      kit.env.DB,
      'SELECT state, reason FROM scans WHERE id = ?',
      [id],
    );
    expect(after).toEqual({ state: 'failed', reason: null });
  });
});

describe('the hub', () => {
  it('is told of the override for the refusing door only, and not when the door did it', async () => {
    const r = await held();
    const calls: { scannerId: string; resolved: { of: string; by: unknown } }[] = [];
    const real = kit.env.SCAN_HUB;
    kit.env.SCAN_HUB = new Proxy(real, {
      get(target, prop) {
        if (prop !== 'getByName') return Reflect.get(target, prop, target);
        return (name: string) => {
          const stub = target.getByName(name);
          return new Proxy(stub, {
            get(s, p) {
              if (p !== 'resolved') return Reflect.get(s, p);
              return async (input: (typeof calls)[number]) => {
                calls.push(input);
                return 0;
              };
            },
          });
        };
      },
    });
    try {
      const res = await overrideAs(r.monitor.headers, r.hold);
      expect(res.status).toBe(200);
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(calls).toHaveLength(1);
      expect(calls[0]).toMatchObject({ scannerId: r.door.scanner.id, resolved: { of: r.hold } });
    } finally {
      kit.env.SCAN_HUB = real;
    }
  });
});
