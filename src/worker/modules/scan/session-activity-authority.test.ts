import { describe, expect, it } from 'vitest';
import { makeOrg, makeSession, makeUser } from '../../../../test/helpers/index.ts';
import { run } from '../../platform/db.ts';
import { sha256Hex } from '../../platform/ids.ts';
import {
  ACTION,
  ACTIVITY_NAME,
  activityFixture,
  atActivityRead,
  consoleRows,
  deviceRows,
  noLeak,
  record,
  workspace,
} from './repo-session-activity-authority-test-fixtures.ts';
import { approveScanReleases, grantScanMembership } from './test-kit.ts';

describe('session activity authority', () => {
  it('returns proven activity to both authorized consumers, but never another session or tenant', async () => {
    const f = await activityFixture();
    const otherScanner = await f.kit.scanner({ eventId: f.event.id });
    await workspace(f.kit, otherScanner, { eventId: f.event.id });
    const other = await f.kit.scanPass(f.template, { memberName: 'Other session guest' });
    await record(f.kit, otherScanner, other);
    for (const rows of [await deviceRows(await f.device()), await consoleRows(await f.console())]) {
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        id: f.scanId,
        deviceId: f.scanner.id,
        passId: f.pass.id,
        title: ACTIVITY_NAME,
      });
      expect(JSON.stringify(rows)).not.toContain(other.id);
      expect(JSON.stringify(rows)).not.toContain('Other session guest');
    }
    const otherOrg = await makeOrg(f.kit.fx);
    const outsider = await makeUser(f.kit.fx);
    await grantScanMembership(f.kit.fx, otherOrg.id, outsider.id);
    const foreign = await makeSession(f.kit.fx, { userId: outsider.id });
    await noLeak(await f.console(foreign.headers), 403, 'FORBIDDEN', f.pass.id, ACTIVITY_NAME);
    await noLeak(
      await f.request(`/scanning-sessions/${f.sessionId}`, {
        ...f.browser.headers,
        'x-passbook-mode': 'test',
      }),
      404,
      'SCANNING_SESSION_NOT_FOUND',
      f.pass.id,
      ACTIVITY_NAME,
    );
  });

  it('distinguishes authorized empty activity from revoked device and membership access', async () => {
    const f = await activityFixture({ record: false });
    expect(await deviceRows(await f.device())).toEqual([]);
    expect(await consoleRows(await f.console())).toEqual([]);
    await run(f.kit.env.DB, 'UPDATE scanners SET revoked_at=? WHERE id=?', [
      f.kit.clock.now(),
      f.scanner.id,
    ]);
    await noLeak(await f.device(), 401, 'SCANNER_REVOKED', f.pass.id, ACTIVITY_NAME);
    await run(f.kit.env.DB, 'UPDATE org_memberships SET revoked_at=? WHERE id=?', [
      f.kit.clock.now(),
      f.membershipId,
    ]);
    await noLeak(await f.console(), 403, 'FORBIDDEN', f.pass.id, ACTIVITY_NAME);
  });

  it.each(['missing', 'revoked', 'rotated'] as const)(
    'denies %s device credentials rather than returning empty activity',
    async (change) => {
      const f = await activityFixture();
      const rows = await deviceRows(await f.device());
      expect(rows).toEqual([
        expect.objectContaining({ id: f.scanId, passId: f.pass.id, title: ACTIVITY_NAME }),
      ]);
      if (change === 'revoked')
        await run(f.kit.env.DB, 'UPDATE scanners SET revoked_at=? WHERE id=?', [
          f.kit.clock.now(),
          f.scanner.id,
        ]);
      if (change === 'rotated')
        await run(
          f.kit.env.DB,
          'UPDATE scanners SET token_hash=?,updated_at=updated_at+1 WHERE id=?',
          [await sha256Hex(f.kit.fx.ids.token()), f.scanner.id],
        );
      const response =
        change === 'missing' ? await f.request('/scan/activity', {}) : await f.device();
      await noLeak(
        response,
        401,
        change === 'revoked' ? 'SCANNER_REVOKED' : 'SCANNER_UNAUTHENTICATED',
        f.pass.id,
        ACTIVITY_NAME,
      );
    },
  );

  it.each(['missing', 'revoked session', 'revoked membership'] as const)(
    'denies a console request with %s instead of returning empty activity',
    async (change) => {
      const f = await activityFixture();
      const rows = await consoleRows(await f.console());
      expect(rows).toEqual([
        expect.objectContaining({ id: f.scanId, passId: f.pass.id, title: ACTIVITY_NAME }),
      ]);
      if (change === 'revoked session')
        await run(f.kit.env.DB, 'UPDATE sessions SET revoked_at=? WHERE id_hash=?', [
          f.kit.clock.now(),
          f.auth.sessionId,
        ]);
      if (change === 'revoked membership')
        await run(f.kit.env.DB, 'UPDATE org_memberships SET revoked_at=? WHERE id=?', [
          f.kit.clock.now(),
          f.membershipId,
        ]);
      await noLeak(
        change === 'missing' ? await f.console({}) : await f.console(),
        change === 'revoked membership' ? 403 : 401,
        change === 'revoked membership' ? 'FORBIDDEN' : 'UNAUTHENTICATED',
        f.pass.id,
        ACTIVITY_NAME,
      );
    },
  );

  const deviceChanges = [
    'revoked',
    'csrf rotation',
    'token rotation',
    'binding mode',
    'reparent',
    'event row',
    'event templates',
    'scanner templates',
    'release head',
  ] as const;
  type DeviceChange = (typeof deviceChanges)[number];
  async function changeDevice(
    f: Awaited<ReturnType<typeof activityFixture>>,
    change: DeviceChange,
  ) {
    const otherScanner = await f.kit.scanner({ eventId: f.event.id });
    const otherSession = await workspace(f.kit, otherScanner, { eventId: f.event.id });
    const extraTemplate = await f.kit.scanTemplate('Another activity scope', { actions: [ACTION] });
    return async (db: D1Database) => {
      if (change === 'revoked')
        await run(db, 'UPDATE scanners SET revoked_at=? WHERE id=?', [
          f.kit.clock.now(),
          f.scanner.id,
        ]);
      if (change === 'csrf rotation')
        await run(db, 'UPDATE scanners SET csrf_secret=?,updated_at=updated_at+1 WHERE id=?', [
          'replacement-device-secret',
          f.scanner.id,
        ]);
      if (change === 'token rotation')
        await run(db, 'UPDATE scanners SET token_hash=?,updated_at=updated_at+1 WHERE id=?', [
          await sha256Hex(f.kit.fx.ids.token()),
          f.scanner.id,
        ]);
      if (change === 'binding mode')
        await run(db, "UPDATE scanning_devices SET mode='test' WHERE scanner_id=?", [f.scanner.id]);
      if (change === 'reparent')
        await run(db, 'UPDATE scanning_devices SET session_id=? WHERE scanner_id=?', [
          otherSession,
          f.scanner.id,
        ]);
      if (change === 'event row')
        await run(db, "UPDATE scan_events SET name='Changed',updated_at=updated_at+1 WHERE id=?", [
          f.event.id,
        ]);
      if (change === 'event templates')
        await run(db, 'INSERT INTO scan_event_templates(event_id,template_id) VALUES(?,?)', [
          f.event.id,
          extraTemplate,
        ]);
      if (change === 'scanner templates')
        await run(db, 'INSERT INTO scanner_templates(scanner_id,template_id) VALUES(?,?)', [
          f.scanner.id,
          extraTemplate,
        ]);
      if (change === 'release head')
        await approveScanReleases(f.kit, f.template, { modes: ['live'], db });
    };
  }
  // A rename and a release head move no epoch. A lost credential unpairs the device; a scope or
  // binding change is configuration and keeps it paired.
  const deviceAnswer = (change: DeviceChange) =>
    change === 'event row' || change === 'release head'
      ? ([200, null] as const)
      : change === 'revoked' || change === 'csrf rotation' || change === 'token rotation'
        ? ([401, 'SCANNER_REPAIR'] as const)
        : ([409, 'SCAN_CONFIG_CHANGED'] as const);

  it.each(deviceChanges)(
    'refuses a device %s change made before its activity read',
    async (change) => {
      const f = await activityFixture();
      const response = await atActivityRead(f.kit.env, f.device, await changeDevice(f, change));
      const [status, code] = deviceAnswer(change);
      if (code === null) expect(response.status).toBe(status);
      else await noLeak(response, status, code, f.pass.id, ACTIVITY_NAME);
    },
  );

  it.each(deviceChanges)(
    'answers the snapshot for a device %s change made after its activity read',
    async (change) => {
      const f = await activityFixture();
      const response = await atActivityRead(f.kit.env, f.device, await changeDevice(f, change), {
        when: 'after',
      });
      expect(await deviceRows(response)).toEqual([
        expect.objectContaining({ id: f.scanId, passId: f.pass.id, title: ACTIVITY_NAME }),
      ]);
      // The next request sees a lost credential.
      if (change === 'revoked')
        await noLeak(await f.device(), 401, 'SCANNER_REVOKED', f.pass.id, ACTIVITY_NAME);
      if (change === 'token rotation')
        await noLeak(await f.device(), 401, 'SCANNER_UNAUTHENTICATED', f.pass.id, ACTIVITY_NAME);
    },
  );

  const consoleChanges = [
    'membership revoked',
    'membership roles',
    'session rotation',
    'session mode',
  ] as const;
  function changeConsole(
    f: Awaited<ReturnType<typeof activityFixture>>,
    change: (typeof consoleChanges)[number],
  ) {
    return async (db: D1Database) => {
      if (change === 'membership revoked' || change === 'membership roles') {
        await run(db, 'UPDATE org_memberships SET revoked_at=? WHERE id=?', [
          f.kit.clock.now(),
          f.membershipId,
        ]);
        if (change === 'membership roles') {
          const fx = { ...f.kit.fx, env: { ...f.kit.fx.env, DB: db } };
          await grantScanMembership(fx, f.kit.org.id, f.user.id, ['read_only']);
        }
      }
      if (change === 'session rotation') {
        await makeSession(f.kit.fx, { userId: f.user.id });
        await run(db, 'UPDATE sessions SET revoked_at=? WHERE id_hash=?', [
          f.kit.clock.now(),
          f.auth.sessionId,
        ]);
      }
      if (change === 'session mode')
        await run(db, "UPDATE scanning_sessions SET mode='test' WHERE id=?", [f.sessionId]);
    };
  }

  it.each(consoleChanges)(
    'refuses a console %s change made before its activity read',
    async (change) => {
      const f = await activityFixture();
      const response = await atActivityRead(f.kit.env, f.console, changeConsole(f, change));
      await noLeak(response, 404, 'SCANNING_SESSION_NOT_FOUND', f.pass.id, ACTIVITY_NAME);
    },
  );

  it.each(consoleChanges)(
    'answers the snapshot for a console %s change made after its activity read',
    async (change) => {
      const f = await activityFixture();
      const response = await atActivityRead(f.kit.env, f.console, changeConsole(f, change), {
        when: 'after',
      });
      expect(await consoleRows(response)).toEqual([
        expect.objectContaining({ id: f.scanId, passId: f.pass.id, title: ACTIVITY_NAME }),
      ]);
      // The next request is refused when the membership, the session or the mode is gone.
      if (change === 'membership roles') return;
      const next = await f.console();
      expect(next.status).toBe(
        change === 'membership revoked' ? 403 : change === 'session rotation' ? 401 : 404,
      );
      expect(await next.text()).not.toContain(ACTIVITY_NAME);
    },
  );

  it.each(['device', 'console'] as const)(
    'serves %s activity after a session rename and revision bump: they are not authority',
    async (kind) => {
      const f = await activityFixture();
      const response = await atActivityRead(
        f.kit.env,
        kind === 'device' ? f.device : f.console,
        async (db) => {
          await run(
            db,
            "UPDATE scanning_sessions SET name='Changed',updated_at=updated_at+1 WHERE id=?",
            [f.sessionId],
          );
        },
      );
      expect(response.status).toBe(200);
    },
  );

  // A page with a pass in it needs the stored keyset; an empty page exposes nothing derived from it.
  it.each(['device', 'console'] as const)(
    'fails the %s activity closed on a mismatched keyring, and an empty page needs none',
    async (consumer) => {
      const f = await activityFixture();
      const empty = await activityFixture({ record: false });
      const key = f.kit.env.KEK_V1;
      const swapped = key === btoa('z'.repeat(32)) ? btoa('y'.repeat(32)) : btoa('z'.repeat(32));
      f.kit.env.KEK_V1 = swapped;
      empty.kit.env.KEK_V1 = swapped;
      try {
        await noLeak(
          await (consumer === 'device' ? f.device() : f.console()),
          503,
          'CREDENTIAL_REF_KEYSET_UNAVAILABLE',
          f.pass.id,
          ACTIVITY_NAME,
        );
        const rows =
          consumer === 'device'
            ? await deviceRows(await empty.device())
            : await consoleRows(await empty.console());
        expect(rows).toEqual([]);
      } finally {
        f.kit.env.KEK_V1 = key;
      }
    },
  );

  it.each(['device', 'console'] as const)(
    'keeps the %s request pinned to its original keyset during a binding change',
    async (consumer) => {
      const f = await activityFixture();
      const key = f.kit.env.KEK_V1;
      try {
        const response = await atActivityRead(
          f.kit.env,
          consumer === 'device' ? f.device : f.console,
          async () => {
            f.kit.env.KEK_V1 =
              key === btoa('z'.repeat(32)) ? btoa('y'.repeat(32)) : btoa('z'.repeat(32));
          },
        );
        const rows =
          consumer === 'device' ? await deviceRows(response) : await consoleRows(response);
        expect(rows).toEqual([
          expect.objectContaining({ id: f.scanId, passId: f.pass.id, title: ACTIVITY_NAME }),
        ]);
      } finally {
        f.kit.env.KEK_V1 = key;
      }
    },
  );
});
