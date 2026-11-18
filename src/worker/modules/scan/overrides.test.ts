import { beforeAll, describe, expect, it } from 'vitest';
import { all, run } from '../../platform/db.ts';
import { accessTemplate, makeDoor } from './access-test-fixtures.ts';
import { HOUR, kit, MINUTE, setupActionFixture } from './act-test-fixtures.ts';
import { scanAt, trackedZone } from './occupancy-scan-test-fixtures.ts';
import { resolvedTarget } from './override-scope.ts';
import { bodyOf, doorAndMonitor, overrideAs, scanById } from './overrides-test-fixtures.ts';
import { key } from './test-kit.ts';

beforeAll(setupActionFixture);

/** A person held at the gym door (still inside), the scan id of that hold. */
async function held(opts: Parameters<typeof doorAndMonitor>[2] = {}) {
  const tpl = await accessTemplate();
  const gym = await trackedZone({ occupancy: 'enforce' });
  const rig = await doorAndMonitor(tpl, [gym], opts);
  const pass = await kit.scanPass(tpl, { plan: 'gold' });
  await scanAt(rig.door, pass);
  kit.clock.advance(5 * MINUTE);
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
    const staff = await held();
    await run(
      kit.env.DB,
      "UPDATE scanning_sessions SET settings = json_set(settings, '$.staffSignIn', json('true')) WHERE id = ?",
      [staff.sessionId],
    );
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
