/* istanbul ignore file -- @preserve */
import { expect, it } from 'vitest';
import { makeSession, makeUser, runOne } from '../../../../test/helpers/index.ts';
import type { ScanOutcome } from '../../../shared/contracts/scan.ts';
import { CreateScanningSessionSchema } from '../../../shared/contracts/scanning-sessions.ts';
import { createApp } from '../../app.ts';
import { denyAllStores } from '../../platform/auth.ts';
import { all, first, run } from '../../platform/db.ts';
import { createSessionStore, hashSessionCookie } from '../auth/sessions.ts';
import {
  accepted,
  atCommit,
  type Effects,
  effects,
  kit,
  sessionCountAuthority,
  sessionCreator,
  sessionWriteAuthority,
  template,
  tracking,
  undoResponse,
} from './repo-commit-fence-test-fixtures.ts';
import { createScanningSession } from './scanning-sessions.ts';
import { codeOf, key, ORIGIN } from './test-kit.ts';

export function registerCommitFenceUndo() {
  // A pass transfer is not simulated here: the credential-transfer guards refuse a direct owner change.
  it('undoes when the pass version changes while the undo commits', async () => {
    const pass = await kit.scanPass(template);
    const scanner = await kit.scanner({ templateIds: [template], settings: tracking });
    const scanId = await accepted(scanner, pass);
    const idempotencyKey = key();
    const response = await atCommit(
      'undo',
      async (db) => {
        await runOne(db, 'UPDATE passes SET version = version + 1 WHERE id = ?', [pass.id]);
      },
      () => undoResponse(scanner, scanId, idempotencyKey),
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ kind: 'ok', replay: false });
    expect(
      await first(kit.env.DB, 'SELECT undone_by FROM scans WHERE id = ?', [scanId]),
    ).not.toEqual({ undone_by: null });
  });

  it.each([
    ['pass quarantine', 409, 'SCAN_RETAINED'],
    ['scanner revocation', 401, 'SCANNER_REPAIR'],
  ] as const)(
    'leaves the original check-in intact when %s races undo',
    async (change, status, code) => {
      const mode = change === 'pass quarantine' ? 'test' : 'live';
      const pass = await kit.scanPass(template, {}, { mode });
      const scanner = await kit.scanner({ mode, templateIds: [template], settings: tracking });
      const scanId = await accepted(scanner, pass);
      const idempotencyKey = key();
      let before: Effects | undefined;
      const response = await atCommit(
        'undo',
        async (db) => {
          const original = await first(
            db,
            'SELECT state, outcome, undone_by FROM scans WHERE id = ?',
            [scanId],
          );
          expect(original).toEqual({ state: 'done', outcome: 'ok', undone_by: null });
          if (change === 'scanner revocation') {
            await runOne(
              db,
              'UPDATE scanners SET revoked_at = ?, updated_at = updated_at + 1 WHERE id = ?',
              [kit.clock.now(), scanner.id],
            );
          } else {
            await runOne(db, 'UPDATE passes SET test_data_quarantined = 1 WHERE id = ?', [pass.id]);
          }
          before = await effects(db, pass.id);
          expect(before.gates).toHaveLength(1);
          expect(before.presence).toHaveLength(1);
        },
        () => undoResponse(scanner, scanId, idempotencyKey),
      );
      expect(response.status).toBe(status);
      expect(await response.json()).toMatchObject({ code });
      expect(before).toBeDefined();
      expect(await effects(kit.env.DB, pass.id)).toEqual(before);
      expect(
        await all(kit.env.DB, 'SELECT id FROM scans WHERE actor_key = ? AND idempotency_key = ?', [
          `s:${scanner.id}`,
          idempotencyKey,
        ]),
      ).toEqual([]);
    },
  );

  it('does not undo after a real administrator session is revoked before commit', async () => {
    const user = await makeUser(kit.fx);
    const session = await makeSession(kit.fx, { userId: user.id, roles: ['admin'] });
    const sessionId = await hashSessionCookie(session.cookieValue);
    const app = createApp({
      stores: { ...denyAllStores, sessions: createSessionStore(kit.env, kit.clock) },
      clock: kit.clock,
    });
    const scope = { orgId: kit.org.id, templateIds: [template], timeZone: 'UTC' };
    const send = (path: string, body: unknown) =>
      Promise.resolve(
        app.request(
          `${ORIGIN}/api/v1/scan${path}`,
          {
            method: 'POST',
            headers: { ...session.headers, origin: ORIGIN, 'content-type': 'application/json' },
            body: JSON.stringify(body),
          },
          kit.env,
        ),
      );
    const pass = await kit.scanPass(template);
    const admitted = await send('/actions', {
      idempotencyKey: key(),
      input: codeOf(pass),
      clientTs: kit.clock.now(),
      actionId: 'check_in',
      scope,
    });
    expect(admitted.status).toBe(200);
    const original = (await admitted.json()) as ScanOutcome;
    expect(original.kind).toBe('ok');
    if (!original.scanId) throw new Error('A successful scan must have an id.');
    const idempotencyKey = key();
    let before: Effects | undefined;
    const response = await atCommit(
      'undo',
      async (db) => {
        await runOne(db, 'UPDATE sessions SET revoked_at=? WHERE id_hash=?', [
          kit.clock.now(),
          sessionId,
        ]);
        before = await effects(db, pass.id);
      },
      () => send(`/scans/${original.scanId}/undo`, { idempotencyKey, scope }),
    );
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ code: 'ACTOR_CHANGED' });
    expect(before).toBeDefined();
    expect(await effects(kit.env.DB, pass.id)).toEqual(before);
    expect(
      await all(kit.env.DB, 'SELECT id FROM scans WHERE actor_key=? AND idempotency_key=?', [
        `u:${user.id}`,
        idempotencyKey,
      ]),
    ).toEqual([]);
  });

  it('leaves an admitted scan intact if its event is archived before undo commits', async () => {
    const event = await kit.event({ templateIds: [template] });
    const pass = await kit.scanPass(template);
    const scanner = await kit.scanner({ eventId: event.id, settings: tracking });
    const scanId = await accepted(scanner, pass);
    let before: Effects | undefined;
    const response = await atCommit(
      'undo',
      async (db) => {
        await runOne(
          db,
          'UPDATE scan_events SET archived_at=?, updated_at=updated_at+1 WHERE id=?',
          [kit.clock.now(), event.id],
        );
        before = await effects(db, pass.id);
      },
      () => undoResponse(scanner, scanId, key()),
    );
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ code: 'SCAN_CONFIG_CHANGED' });
    expect(before).toBeDefined();
    expect(await effects(kit.env.DB, pass.id)).toEqual(before);
  });

  it('leaves an admitted scan intact if its scanning session pauses before undo commits', async () => {
    const session = await createScanningSession(
      kit.ctx,
      sessionCreator,
      'live',
      CreateScanningSessionSchema.parse({
        orgId: kit.org.id,
        name: `Undo session ${key()}`,
        timeZone: 'UTC',
        accepts: { templateIds: [template] },
        settings: tracking,
      }),
      sessionWriteAuthority,
      sessionCountAuthority,
    );
    const scanner = await kit.scanner({ templateIds: [template], settings: tracking });
    await run(
      kit.env.DB,
      "INSERT INTO scanning_devices (scanner_id,session_id,org_id,mode) VALUES (?,?,?,'live')",
      [scanner.id, session.id, kit.org.id],
    );
    const pass = await kit.scanPass(template);
    const scanId = await accepted(scanner, pass);
    let before: Effects | undefined;
    const response = await atCommit(
      'undo',
      async (db) => {
        await runOne(
          db,
          "UPDATE scanning_sessions SET status='paused', updated_at=updated_at+1 WHERE id=?",
          [session.id],
        );
        before = await effects(db, pass.id);
      },
      () => undoResponse(scanner, scanId, key()),
    );
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ code: 'SCAN_CONFIG_CHANGED' });
    expect(before).toBeDefined();
    expect(await effects(kit.env.DB, pass.id)).toEqual(before);
  });

  it.each(['valid', 'disabled before commit'] as const)(
    'uses the current Manager approval for undo: %s',
    async (change) => {
      const originalStaff = await kit.staff('door');
      const nextStaff = await kit.staff('door');
      const manager = await kit.staff('manager');
      const pass = await kit.scanPass(template);
      const scanner = await kit.scanner({
        templateIds: [template],
        staffId: originalStaff.id,
        settings: { ...tracking, staffSignIn: true },
      });
      const scanId = await accepted(scanner, pass);
      await run(
        kit.env.DB,
        'UPDATE scanners SET staff_id = ?, staff_since = ?, staff_seen_at = ? WHERE id = ?',
        [nextStaff.id, kit.clock.now(), kit.clock.now(), scanner.id],
      );
      const idempotencyKey = key();
      const send = () =>
        kit.post(scanner.headers, `/scans/${scanId}/undo`, {
          idempotencyKey,
          approval: { staffId: manager.id, pin: manager.pin },
        });
      if (change === 'valid') {
        const response = await send();
        expect(response.status).toBe(200);
        const result = (await response.json()) as ScanOutcome;
        expect(result).toMatchObject({ kind: 'ok', replay: false });
        expect(
          await first(kit.env.DB, 'SELECT approved_by, undoes FROM scans WHERE id = ?', [
            result.scanId ?? '',
          ]),
        ).toEqual({ approved_by: manager.id, undoes: scanId });
      } else {
        let before: Effects | undefined;
        const response = await atCommit(
          'undo',
          async (db) => {
            await runOne(
              db,
              'UPDATE scan_staff SET disabled_at = ?, updated_at = updated_at + 1 WHERE id = ?',
              [kit.clock.now(), manager.id],
            );
            before = await effects(db, pass.id);
          },
          send,
        );
        expect(response.status).toBe(409);
        expect(await response.json()).toMatchObject({ code: 'SCAN_STAFF_CHANGED' });
        expect(before).toBeDefined();
        expect(await effects(kit.env.DB, pass.id)).toEqual(before);
        expect(
          await all(
            kit.env.DB,
            'SELECT id FROM scans WHERE actor_key = ? AND idempotency_key = ?',
            [`s:${scanner.id}`, idempotencyKey],
          ),
        ).toEqual([]);
      }
    },
  );
}
