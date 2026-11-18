import { beforeAll, describe, expect, it } from 'vitest';
import { makeScanStaff } from '../../../../test/helpers/index.ts';
import { all, first } from '../../platform/db.ts';
import { getScanner } from './repo-device.ts';
import { staffSessionFixture } from './staff-session-test-fixtures.ts';
import { ORIGIN } from './test-kit.ts';

const noStaff = staffSessionFixture();
beforeAll(async () => {
  await noStaff.setup();
});

type Fixture = typeof noStaff;
// A PIN lock is shared per org, so each PIN case gets its own org.
async function fresh(): Promise<Fixture> {
  const f = staffSessionFixture();
  await f.setup();
  return f;
}
const flip = (f: Fixture, headers: Record<string, string>, body: unknown) =>
  f.call('POST', '/scan/role', headers, body);
const roleOf = async (f: Fixture, id: string) => (await getScanner(f.kit.env.DB, id))?.deviceRole;
const pinKeys = (f: Fixture, id: string) =>
  all<{ key: string; count: number }>(
    f.kit.env.DB,
    'SELECT key, count FROM counters WHERE key LIKE ? ORDER BY key',
    [`scan:pin%:${id}%`],
  );

describe('device flip (S9)', () => {
  it('flips to a customer screen and back with no staff, no PIN', async () => {
    const f = noStaff;
    const scanner = await f.kit.scanner({ templateIds: [f.deskTemplate] });
    const shown = await flip(f, scanner.headers, { role: 'customer' });
    expect(shown.status).toBe(200);
    expect(await shown.json()).toMatchObject({ scanner: { deviceRole: 'customer' } });
    expect(await roleOf(f, scanner.id)).toBe('customer');
    const audit = await first<{ detail: string; actor_type: string }>(
      f.kit.env.DB,
      "SELECT detail, actor_type FROM audit_log WHERE action = 'scanner.role_change' AND target_id = ?",
      [scanner.id],
    );
    expect(audit?.actor_type).toBe('scanner');
    expect(JSON.parse(audit?.detail ?? '{}')).toMatchObject({ from: 'scan', to: 'customer' });

    const back = await flip(f, scanner.headers, { role: 'scan' });
    expect(back.status).toBe(200);
    expect(await back.json()).toMatchObject({ scanner: { deviceRole: 'scan' } });
    expect(await roleOf(f, scanner.id)).toBe('scan');
  });

  it('needs a PIN with no name to flip back when the org has staff, and records who', async () => {
    const f = await fresh();
    const staff = await makeScanStaff(f.kit.fx, { orgId: f.kit.org.id, pin: '482916' });
    await makeScanStaff(f.kit.fx, { orgId: f.kit.org.id, pin: '519384', role: 'door' });
    const scanner = await f.kit.scanner({ templateIds: [f.deskTemplate] });
    expect((await flip(f, scanner.headers, { role: 'customer' })).status).toBe(200);

    const bare = await flip(f, scanner.headers, { role: 'scan' });
    expect(bare.status).toBe(403);
    expect(await bare.json()).toMatchObject({ code: 'UNLOCK_REQUIRED' });
    expect(await roleOf(f, scanner.id)).toBe('customer');

    const named = await flip(f, scanner.headers, {
      role: 'scan',
      unlock: { staffId: staff.id, pin: staff.pin },
    });
    expect(named.status).toBe(422);

    const ok = await flip(f, scanner.headers, { role: 'scan', unlock: { pin: staff.pin } });
    expect(ok.status).toBe(200);
    expect(await roleOf(f, scanner.id)).toBe('scan');
    const audit = await all<{ detail: string }>(
      f.kit.env.DB,
      "SELECT detail FROM audit_log WHERE action = 'scanner.role_change' AND target_id = ? ORDER BY at, id",
      [scanner.id],
    );
    expect(JSON.parse(audit.at(-1)?.detail ?? '{}')).toMatchObject({
      to: 'scan',
      unlockedBy: staff.id,
    });
  });

  it('answers an ambiguous PIN as a wrong one and counts it', async () => {
    const f = await fresh();
    await makeScanStaff(f.kit.fx, { orgId: f.kit.org.id, pin: '246810' });
    await makeScanStaff(f.kit.fx, { orgId: f.kit.org.id, pin: '246810' });
    const scanner = await f.kit.scanner({ templateIds: [f.deskTemplate] });
    await flip(f, scanner.headers, { role: 'customer' });
    const res = await flip(f, scanner.headers, { role: 'scan', unlock: { pin: '246810' } });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ code: 'PIN_INVALID' });
    expect(await roleOf(f, scanner.id)).toBe('customer');
    expect((await pinKeys(f, scanner.id)).length).toBeGreaterThan(0);
  });

  it('counts misses per scanner, never per name, and locks', async () => {
    const f = await fresh();
    const staff = await makeScanStaff(f.kit.fx, { orgId: f.kit.org.id, pin: '739150' });
    const scanner = await f.kit.scanner({ templateIds: [f.deskTemplate] });
    await flip(f, scanner.headers, { role: 'customer' });
    for (let i = 0; i < 5; i++) {
      const miss = await flip(f, scanner.headers, { role: 'scan', unlock: { pin: '000000' } });
      expect(miss.status).toBe(400);
      expect(await miss.json()).toMatchObject({ code: 'PIN_INVALID' });
    }
    const keys = await pinKeys(f, scanner.id);
    expect(keys.find((k) => k.key === `scan:pin:${scanner.id}:*`)?.count).toBe(5);
    expect(keys.some((k) => k.key.includes(staff.id))).toBe(false);
    const locked = await flip(f, scanner.headers, { role: 'scan', unlock: { pin: staff.pin } });
    expect(locked.status).toBe(429);
    expect(await roleOf(f, scanner.id)).toBe('customer');
  });

  it('signs the unlocking staff member in when staff sign-in is on', async () => {
    const f = await fresh();
    const staff = await makeScanStaff(f.kit.fx, { orgId: f.kit.org.id, pin: '805217' });
    const scanner = await f.kit.scanner({
      templateIds: [f.deskTemplate],
      settings: { staffSignIn: true },
    });
    await flip(f, scanner.headers, { role: 'customer' });
    const res = await flip(f, scanner.headers, { role: 'scan', unlock: { pin: staff.pin } });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ state: 'ready', staff: { id: staff.id } });
    expect((await getScanner(f.kit.env.DB, scanner.id))?.staffId).toBe(staff.id);
  });

  it('refuses terminals, displays and admin sessions with ROLE_NOT_ALLOWED', async () => {
    const f = noStaff;
    const terminal = await f.kit.scanner({ kind: 'terminal', templateIds: [f.deskTemplate] });
    const display = await f.kit.scanner({ kind: 'display', deviceRole: 'customer' });
    for (const [headers, body] of [
      [{ ...terminal.headers, origin: ORIGIN }, { role: 'customer' }],
      [display.headers, { role: 'scan' }],
    ] as const) {
      const res = await flip(f, headers, body);
      expect(res.status).toBe(403);
      expect(await res.json()).toMatchObject({ code: 'ROLE_NOT_ALLOWED' });
    }
    expect(await roleOf(f, display.id)).toBe('customer');
    expect(await roleOf(f, terminal.id)).toBe('scan');
  });

  it('refuses a customer-role phone on every scan route, whatever the client claims', async () => {
    const f = noStaff;
    const scanner = await f.kit.scanner({ templateIds: [f.deskTemplate] });
    await flip(f, scanner.headers, { role: 'customer' });
    const claims = {
      ...scanner.headers,
      'x-passbook-role': 'scan',
      'x-device-role': 'scan',
      'x-passbook-scan-admin': '0',
    };
    const calls: [string, string, unknown?][] = [
      ['POST', '/scan/resolve', { role: 'scan', deviceRole: 'scan' }],
      ['POST', '/scan/actions', { deviceRole: 'scan' }],
      ['POST', '/scan/lookup', { q: 'x' }],
      ['POST', '/scan/scans/x/undo', {}],
      ['POST', '/scan/staff', { staffId: 'x', pin: '123456' }],
      ['DELETE', '/scan/staff'],
      ['GET', '/scan/staff?q=a'],
      ['GET', '/scan/scans'],
      ['GET', '/scan/stats'],
      ['GET', '/scan/summary'],
      ['GET', '/scan/activity'],
      ['GET', '/scan/passes/x/assets/y?g=1'],
      ['POST', '/scan/actions/x', {}],
    ];
    for (const [method, path, body] of calls) {
      const res = await f.call(method, path, claims, body);
      if (res.status === 404) continue;
      expect(res.status, `${method} ${path}`).toBe(403);
      expect(await res.json(), `${method} ${path}`).toMatchObject({ code: 'SCREEN_ONLY' });
    }
    expect(await roleOf(f, scanner.id)).toBe('customer');
    const session = await f.call('GET', '/scan/session', claims);
    expect(await session.json()).toMatchObject({ scanner: { deviceRole: 'customer' } });
  });

  it('ignores a role claim in the request: the row decides', async () => {
    const f = noStaff;
    const scanner = await f.kit.scanner({ templateIds: [f.deskTemplate] });
    const odd = await flip(f, scanner.headers, { role: 'monitor' });
    expect(odd.status).toBe(422);
    expect(await roleOf(f, scanner.id)).toBe('scan');
    const extra = await flip(f, scanner.headers, { role: 'customer', deviceRole: 'scan' });
    expect(extra.status).toBe(422);
    expect(await roleOf(f, scanner.id)).toBe('scan');
  });

  it('never puts a staff name in a response to a customer-role phone', async () => {
    const f = await fresh();
    const staff = await makeScanStaff(f.kit.fx, {
      orgId: f.kit.org.id,
      name: 'Zelda Roster',
      pin: '913746',
    });
    const scanner = await f.kit.scanner({
      templateIds: [f.deskTemplate],
      settings: { staffSignIn: true },
    });
    const bodies: string[] = [];
    const record = async (res: Response) => bodies.push(await res.text());
    await record(await flip(f, scanner.headers, { role: 'customer' }));
    await record(await f.call('GET', '/scan/session', scanner.headers));
    await record(await f.call('GET', '/scan/staff?q=zelda', scanner.headers));
    await record(await f.call('GET', '/scan/role/staff?q=zelda', scanner.headers));
    await record(await flip(f, scanner.headers, { role: 'scan' }));
    await record(await flip(f, scanner.headers, { role: 'scan', unlock: { pin: '000000' } }));
    for (const body of bodies) {
      expect(body).not.toContain('Zelda');
      expect(body).not.toContain(staff.id);
    }
  });
});
