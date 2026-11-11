import { beforeEach, describe, expect, it } from 'vitest';
import {
  type Fixtures,
  fixtures,
  makeEnv,
  makeOrg,
  makeScanner,
  makeScanStaff,
} from '../../../../test/helpers/index.ts';
import { ManualClock } from '../../platform/clock.ts';
import { run } from '../../platform/db.ts';
import { AppError } from '../../platform/errors.ts';
import { createServiceContext, type ServiceContext } from '../../platform/service-context.ts';
import { bindStaff, getScanner, touchStaff, unbindStaff } from './repo-device.ts';
import { getStaff } from './repo-staff.ts';
import { boundStaff } from './staff-binding.ts';
import { hashPin } from './staff-pin.ts';

let f: Fixtures;
let clock: ManualClock;
let orgId: string;
let ctx: ServiceContext;

beforeEach(async () => {
  clock = new ManualClock(Date.UTC(2026, 5, 1, 12));
  f = fixtures(await makeEnv(), clock);
  orgId = (await makeOrg(f)).id;
  ctx = createServiceContext(f.env, { clock });
});

async function snapshot(scannerId: string, staffId: string) {
  const [scanner, staff] = await Promise.all([
    getScanner(f.env.DB, scannerId),
    getStaff(f.env.DB, orgId, staffId),
  ]);
  if (!scanner || !staff) throw new Error('Missing scanner or staff fixture.');
  return { scanner, staff };
}

/** `ok`, or the refusal's `status code`: a refused bind writes nothing. */
async function tryBind(
  scanner: Awaited<ReturnType<typeof getScanner>> & object,
  staff: Awaited<ReturnType<typeof getStaff>> & object,
  session?: { id: string; configEpoch: number },
): Promise<string> {
  try {
    await bindStaff(ctx, scanner, { id: staff.id, authEpoch: staff.authEpoch ?? 0 }, session);
    return 'ok';
  } catch (error) {
    if (error instanceof AppError) return `${error.status} ${error.code}`;
    throw error;
  }
}

describe('staff binding grants', () => {
  it('binds the verified staff to the scanner without storing their PIN', async () => {
    const device = await makeScanner(f, { orgId, settings: { staffSignIn: true } });
    const person = await makeScanStaff(f, { orgId, pin: '682731' });
    const { scanner, staff } = await snapshot(device.id, person.id);
    expect(await tryBind(scanner, staff)).toBe('ok');
    const bound = await getScanner(f.env.DB, device.id);
    expect(bound).toMatchObject({
      staffId: person.id,
      staffSince: clock.now(),
      staffSeenAt: clock.now(),
    });
    expect(JSON.stringify(bound)).not.toContain(person.pin);
  });

  it('cannot bind a person who was disabled, deleted, or had their PIN reset after verification', async () => {
    for (const change of ['disabled', 'deleted', 'reset'] as const) {
      const device = await makeScanner(f, { orgId, settings: { staffSignIn: true } });
      const person = await makeScanStaff(f, { orgId });
      const { scanner, staff } = await snapshot(device.id, person.id);
      if (change === 'disabled')
        await run(f.env.DB, 'UPDATE scan_staff SET disabled_at = ? WHERE id = ?', [
          clock.now(),
          person.id,
        ]);
      else if (change === 'deleted')
        await run(f.env.DB, 'DELETE FROM scan_staff WHERE id = ?', [person.id]);
      else
        await run(f.env.DB, 'UPDATE scan_staff SET pin_hash = ? WHERE id = ?', [
          await hashPin(f.env, person.id, '654321'),
          person.id,
        ]);
      expect(await tryBind(scanner, staff), change).toBe('409 SCAN_STAFF_CHANGED');
      expect((await getScanner(f.env.DB, device.id))?.staffId, change).toBeNull();
    }
  });

  it('rejects a stale PIN verification after staff authority changes away and back', async () => {
    const device = await makeScanner(f, { orgId, settings: { staffSignIn: true } });
    const person = await makeScanStaff(f, { orgId, role: 'door' });
    const { scanner, staff } = await snapshot(device.id, person.id);
    await run(f.env.DB, "UPDATE scan_staff SET role = 'manager' WHERE id = ?", [person.id]);
    await run(f.env.DB, "UPDATE scan_staff SET role = 'door' WHERE id = ?", [person.id]);
    expect(await tryBind(scanner, staff)).toBe('409 SCAN_STAFF_CHANGED');
    expect((await getScanner(f.env.DB, device.id))?.staffId).toBeNull();
  });

  it('cannot bind another organization’s staff even with a valid hash', async () => {
    const otherOrg = await makeOrg(f);
    const device = await makeScanner(f, { orgId, settings: { staffSignIn: true } });
    const person = await makeScanStaff(f, { orgId: otherOrg.id });
    const scanner = await getScanner(f.env.DB, device.id);
    const staff = await getStaff(f.env.DB, otherOrg.id, person.id);
    if (!scanner || !staff) throw new Error('Missing scanner or staff fixture.');
    expect(await tryBind(scanner, staff)).toBe('409 SCAN_STAFF_CHANGED');
    expect((await getScanner(f.env.DB, device.id))?.staffId).toBeNull();
  });

  it('discards a binding if its staff row does not match the scanner and organization', async () => {
    const person = await makeScanStaff(f, { orgId });
    const device = await makeScanner(f, {
      orgId,
      settings: { staffSignIn: true },
      staffId: person.id,
    });
    const { scanner, staff } = await snapshot(device.id, person.id);
    expect(await boundStaff(ctx, scanner, { ...staff, orgId: 'other-org' })).toBeNull();
    expect((await getScanner(f.env.DB, device.id))?.staffId).toBeNull();
  });

  it('binds only within the same active scanning session at the epoch it was derived from', async () => {
    const device = await makeScanner(f, { orgId, settings: { staffSignIn: true } });
    const person = await makeScanStaff(f, { orgId });
    const { scanner, staff } = await snapshot(device.id, person.id);
    const sessionId = f.ids.id();
    await run(
      f.env.DB,
      `INSERT INTO scanning_sessions
       (id, org_id, mode, name, settings, time_zone, created_at, updated_at)
       VALUES (?, ?, 'live', 'Session', ?, 'UTC', ?, ?)`,
      [sessionId, orgId, scanner.settings, clock.now(), clock.now()],
    );
    await run(
      f.env.DB,
      `INSERT INTO scanning_devices (scanner_id, session_id, org_id, mode)
       VALUES (?, ?, ?, 'live')`,
      [device.id, sessionId, orgId],
    );
    const epoch = async () =>
      (
        await run(f.env.DB, 'SELECT 1', []).then(() =>
          f.env.DB.prepare('SELECT config_epoch AS e FROM scanning_sessions WHERE id = ?')
            .bind(sessionId)
            .first<{ e: number }>(),
        )
      )?.e ?? 0;
    const fresh = await getScanner(f.env.DB, device.id);
    if (!fresh) throw new Error('Missing scanner.');
    // The device now belongs to a session: a bind that names none is stale.
    expect(await tryBind(fresh, staff)).toBe('409 SCAN_STAFF_CHANGED');
    const session = { id: sessionId, configEpoch: await epoch() };
    expect(await tryBind(fresh, staff, session)).toBe('ok');
    // A rename is volatile: the same derivation still binds.
    await run(f.env.DB, "UPDATE scanning_sessions SET name = 'Renamed' WHERE id = ?", [sessionId]);
    expect(await tryBind(fresh, staff, session)).toBe('ok');
    // Pausing moves the session's config epoch and refuses the stale derivation.
    await run(f.env.DB, "UPDATE scanning_sessions SET status = 'paused' WHERE id = ?", [sessionId]);
    expect(await tryBind(fresh, staff, session)).toBe('409 SCAN_STAFF_CHANGED');
    expect((await getScanner(f.env.DB, device.id))?.staffId).toBe(person.id);
  });

  it.each([
    [
      'repaired',
      'UPDATE scanners SET token_hash = ?, updated_at = updated_at + 1 WHERE id = ?',
      'new-token-hash',
      '401',
    ],
    ['revoked', 'UPDATE scanners SET revoked_at = ? WHERE id = ?', 1, '401'],
    ['mode changed', 'UPDATE scanners SET mode = ? WHERE id = ?', 'test', '409'],
    ['screen', 'UPDATE scanners SET device_role = ? WHERE id = ?', 'customer', '409'],
    ['settings changed', 'UPDATE scanners SET settings = ? WHERE id = ?', '{}', '409'],
  ] as const)(
    'cannot bind when the scanner is %s during PIN verification',
    async (_name, sql, value, status) => {
      const device = await makeScanner(f, { orgId, settings: { staffSignIn: true } });
      const person = await makeScanStaff(f, { orgId });
      const { scanner, staff } = await snapshot(device.id, person.id);
      await run(f.env.DB, sql, [value, device.id]);
      expect((await tryBind(scanner, staff)).startsWith(status)).toBe(true);
      expect((await getScanner(f.env.DB, device.id))?.staffId).toBeNull();
    },
  );

  it('a volatile scanner change (revision, name, last seen) does not refuse a bind', async () => {
    const device = await makeScanner(f, { orgId, settings: { staffSignIn: true } });
    const person = await makeScanStaff(f, { orgId });
    const { scanner, staff } = await snapshot(device.id, person.id);
    await run(
      f.env.DB,
      "UPDATE scanners SET updated_at = updated_at + 1, name = 'Renamed' WHERE id = ?",
      [device.id],
    );
    expect(await tryBind(scanner, staff)).toBe('ok');
  });

  it('does not erase or touch a newer binding using a stale snapshot', async () => {
    const device = await makeScanner(f, { orgId, settings: { staffSignIn: true } });
    const first = await makeScanStaff(f, { orgId });
    const second = await makeScanStaff(f, { orgId });
    const { scanner, staff } = await snapshot(device.id, first.id);
    expect(await tryBind(scanner, staff)).toBe('ok');
    const stale = await getScanner(f.env.DB, device.id);
    const replacement = await getStaff(f.env.DB, orgId, second.id);
    if (!stale || !replacement) throw new Error('Missing scanner or staff fixture.');
    clock.advance(1);
    expect(await tryBind(stale, replacement)).toBe('ok');
    const seenAt = clock.now();
    clock.advance(60_001);
    await touchStaff(f.env.DB, stale, clock.now(), 60_000);
    await unbindStaff(ctx, stale);
    expect(await boundStaff(ctx, stale, null)).toBeNull();
    expect(await getScanner(f.env.DB, device.id)).toMatchObject({
      staffId: second.id,
      staffSince: seenAt,
      staffSeenAt: seenAt,
    });
  });

  it('advances the scanner revision across sign-out and sign-in', async () => {
    const device = await makeScanner(f, { orgId, settings: { staffSignIn: true } });
    const person = await makeScanStaff(f, { orgId });
    const { scanner, staff } = await snapshot(device.id, person.id);
    expect(await tryBind(scanner, staff)).toBe('ok');
    const first = await getScanner(f.env.DB, device.id);
    if (!first) throw new Error('Missing first scanner binding.');
    expect(first.updatedAt).toBeGreaterThan(scanner.updatedAt);
    const stale = await getScanner(f.env.DB, device.id);
    if (!stale) throw new Error('Missing stale scanner copy.');
    await unbindStaff(ctx, first);
    const signedOut = await getScanner(f.env.DB, device.id);
    if (!signedOut) throw new Error('Missing signed-out scanner.');
    expect(signedOut.updatedAt).toBeGreaterThan(stale.updatedAt);
    expect(first).toMatchObject({
      staffId: null,
      staffSince: null,
      staffSeenAt: null,
      updatedAt: signedOut.updatedAt,
    });
    await unbindStaff(ctx, signedOut);
    expect((await getScanner(f.env.DB, device.id))?.updatedAt).toBe(signedOut.updatedAt);
    // A later sign-in is a new binding: a stale snapshot of the old one cannot end it.
    clock.advance(1);
    expect(await tryBind(signedOut, staff)).toBe('ok');
    const second = await getScanner(f.env.DB, device.id);
    if (!second) throw new Error('Missing second scanner binding.');
    expect(second.updatedAt).toBeGreaterThan(signedOut.updatedAt);
    expect(second.staffId).toBe(stale.staffId);
    expect(second.staffSince).toBeGreaterThan(stale.staffSince ?? 0);
    clock.advance(60_001);
    await touchStaff(f.env.DB, stale, clock.now(), 60_000);
    await unbindStaff(ctx, stale);
    expect(await getScanner(f.env.DB, device.id)).toMatchObject({
      staffId: person.id,
      staffSince: second.staffSince,
      staffSeenAt: second.staffSeenAt,
      updatedAt: second.updatedAt,
    });
  });
});
