import { expect, it } from 'vitest';
import { run } from '../../platform/db.ts';
import { sha256Hex } from '../../platform/ids.ts';
import { expectAdmitted, expectBlocked, raceGate } from './act-authority-test-fixtures.ts';
import { act, CHECK_IN, HOUR, kit, out, rows, tpl } from './act-test-fixtures.ts';
import { codeOf, key } from './test-kit.ts';

export function registerAuthoritySessions() {
  it.each(['disabled', 'role', 'pin', 'unbound'] as const)(
    'revalidates a signed-in staff member when %s changes',
    async (change) => {
      const staff = await kit.staff('manager');
      const s = await kit.scanner({
        templateIds: [tpl],
        staffId: staff.id,
        settings: { staffSignIn: true },
      });
      const pass = await kit.scanPass(tpl);
      const idempotencyKey = key();
      const response = await raceGate(
        s.headers,
        codeOf(pass),
        (db) =>
          change === 'unbound'
            ? run(
                db,
                'UPDATE scanners SET staff_id=NULL,staff_since=NULL,staff_seen_at=NULL WHERE id=?',
                [s.id],
              )
            : run(
                db,
                change === 'disabled'
                  ? 'UPDATE scan_staff SET disabled_at=1 WHERE id=?'
                  : change === 'pin'
                    ? "UPDATE scan_staff SET pin_hash='rotated' WHERE id=?"
                    : "UPDATE scan_staff SET role='door' WHERE id=?",
                [staff.id],
              ),
        { idempotencyKey },
      );
      await expectBlocked(response, pass.id, idempotencyKey, 'SCAN_STAFF_CHANGED');
    },
  );

  it('revalidates the approving manager and PIN at the gate', async () => {
    const t = await kit.scanTemplate('Manager action', {
      actions: [{ ...CHECK_IN, minRole: 'manager' }],
    });
    const s = await kit.scanner({ templateIds: [t] });
    const manager = await kit.staff('manager');
    const pass = await kit.scanPass(t);
    const idempotencyKey = key();
    const response = await raceGate(
      s.headers,
      codeOf(pass),
      (db) => run(db, "UPDATE scan_staff SET role='door' WHERE id=?", [manager.id]),
      { idempotencyKey, approval: { staffId: manager.id, pin: manager.pin } },
    );
    await expectBlocked(response, pass.id, idempotencyKey, 'SCAN_STAFF_CHANGED');
  });

  it.each(['archived', 'match', 'templates'] as const)(
    'revalidates the live event when its %s changes',
    async (change) => {
      const event = await kit.event({ templateIds: [tpl] });
      const s = await kit.scanner({ eventId: event.id });
      const pass = await kit.scanPass(tpl);
      const idempotencyKey = key();
      const response = await raceGate(
        s.headers,
        codeOf(pass),
        (db) => {
          if (change === 'templates')
            return run(db, 'DELETE FROM scan_event_templates WHERE event_id=? AND template_id=?', [
              event.id,
              tpl,
            ]);
          return run(
            db,
            change === 'archived'
              ? 'UPDATE scan_events SET archived_at=1 WHERE id=?'
              : "UPDATE scan_events SET match_input='tier',match_values='[\"VIP\"]' WHERE id=?",
            [event.id],
          );
        },
        { idempotencyKey },
      );
      await expectBlocked(response, pass.id, idempotencyKey, 'SCAN_CONFIG_CHANGED');
    },
  );

  it.each(['paused', 'accepts', 'settings', 'overrides'] as const)(
    'revalidates an attached scanning session when it is %s',
    async (change) => {
      const s = await kit.scanner({ templateIds: [tpl] });
      const sessionId = kit.fx.ids.id();
      await run(
        kit.env.DB,
        `INSERT INTO scanning_sessions
        (id,org_id,mode,name,status,accepts,settings,time_zone,created_at,updated_at)
        SELECT ?,org_id,mode,name,'active',?,settings,time_zone,created_at,updated_at
        FROM scanners WHERE id=?`,
        [sessionId, JSON.stringify({ templateIds: [tpl] }), s.id],
      );
      await run(
        kit.env.DB,
        `INSERT INTO scanning_devices
        (scanner_id,session_id,org_id,mode,surface,effective_surface,overrides)
        SELECT id,?,org_id,mode,'phone','phone','{}' FROM scanners WHERE id=?`,
        [sessionId, s.id],
      );
      const pass = await kit.scanPass(tpl);
      const idempotencyKey = key();
      const response = await raceGate(
        s.headers,
        codeOf(pass),
        (db) => {
          if (change === 'overrides')
            return run(
              db,
              `UPDATE scanning_devices SET overrides='{"flow":"choose"}' WHERE scanner_id=?`,
              [s.id],
            );
          const update =
            change === 'paused'
              ? "status='paused'"
              : change === 'accepts'
                ? 'accepts=NULL'
                : `settings=json_set(settings,'$.roleWithoutSignIn','desk')`;
          return run(db, `UPDATE scanning_sessions SET ${update} WHERE id=?`, [sessionId]);
        },
        { idempotencyKey },
      );
      await expectBlocked(response, pass.id, idempotencyKey, 'SCAN_CONFIG_CHANGED');
    },
  );

  // Liveness: columns outside every epoch's bump set never refuse the ticket.
  it.each([
    ['staff name', "UPDATE scan_staff SET name=name||'x' WHERE id=?", 'staff'],
    ['event name', "UPDATE scan_events SET name=name||'x' WHERE id=?", 'event'],
    ['session name', "UPDATE scanning_sessions SET name=name||'x' WHERE id=?", 'session'],
  ] as const)(
    'admits the scan when only the %s changes before commit',
    async (_name, sql, kind) => {
      const staff = await kit.staff('manager');
      const event = await kit.event({ templateIds: [tpl] });
      const s = await kit.scanner({
        eventId: event.id,
        staffId: staff.id,
        settings: { staffSignIn: true },
      });
      const sessionId = kit.fx.ids.id();
      await run(
        kit.env.DB,
        `INSERT INTO scanning_sessions
      (id,org_id,mode,name,status,accepts,settings,time_zone,created_at,updated_at)
      SELECT ?,org_id,mode,name,'active',?,settings,time_zone,created_at,updated_at
      FROM scanners WHERE id=?`,
        [sessionId, JSON.stringify({ eventId: event.id }), s.id],
      );
      await run(
        kit.env.DB,
        `INSERT INTO scanning_devices
      (scanner_id,session_id,org_id,mode,surface,effective_surface,overrides)
      SELECT id,?,org_id,mode,'phone','phone','{}' FROM scanners WHERE id=?`,
        [sessionId, s.id],
      );
      const pass = await kit.scanPass(tpl);
      const target = kind === 'staff' ? staff.id : kind === 'event' ? event.id : sessionId;
      const response = await raceGate(s.headers, codeOf(pass), (db) => run(db, sql, [target]), {
        idempotencyKey: key(),
      });
      await expectAdmitted(response, pass.id);
    },
  );

  it('does not broaden an event-bound session with no event templates', async () => {
    const event = await kit.event({ templateIds: [] });
    const s = await kit.scanner({ settings: { acceptAllTemplates: true } });
    const sessionId = kit.fx.ids.id();
    await run(
      kit.env.DB,
      `INSERT INTO scanning_sessions
      (id,org_id,mode,name,status,accepts,settings,time_zone,created_at,updated_at)
      SELECT ?,org_id,mode,name,'active',?,settings,time_zone,created_at,updated_at
      FROM scanners WHERE id=?`,
      [sessionId, JSON.stringify({ eventId: event.id }), s.id],
    );
    await run(
      kit.env.DB,
      `INSERT INTO scanning_devices
      (scanner_id,session_id,org_id,mode,surface,effective_surface,overrides)
      SELECT id,?,org_id,mode,'phone','phone','{}' FROM scanners WHERE id=?`,
      [sessionId, s.id],
    );
    const pass = await kit.scanPass(tpl);
    const result = await out(await act(s.headers, codeOf(pass)));
    expect(result).toMatchObject({ kind: 'refused', reason: 'not_accepted' });
    expect(await rows('SELECT pass_id FROM scan_gates WHERE pass_id=?', [pass.id])).toHaveLength(0);
  });

  it('does not broaden a session whose bound event no longer exists', async () => {
    const s = await kit.scanner({ settings: { acceptAllTemplates: true } });
    const sessionId = kit.fx.ids.id();
    await run(
      kit.env.DB,
      `INSERT INTO scanning_sessions
      (id,org_id,mode,name,status,accepts,settings,time_zone,created_at,updated_at)
      SELECT ?,org_id,mode,name,'active',?,settings,time_zone,created_at,updated_at
      FROM scanners WHERE id=?`,
      [sessionId, JSON.stringify({ eventId: kit.fx.ids.id() }), s.id],
    );
    await run(
      kit.env.DB,
      `INSERT INTO scanning_devices
      (scanner_id,session_id,org_id,mode,surface,effective_surface,overrides)
      SELECT id,?,org_id,mode,'phone','phone','{}' FROM scanners WHERE id=?`,
      [sessionId, s.id],
    );
    const pass = await kit.scanPass(tpl);
    const response = await act(s.headers, codeOf(pass));
    expect(await out(response)).toMatchObject({ kind: 'refused', reason: 'not_accepted' });
    expect(await rows('SELECT pass_id FROM scan_gates WHERE pass_id=?', [pass.id])).toHaveLength(0);
  });

  // Session roles are immutable (0047), so a 'demoted' session cannot exist; revocation covers it.
  it.each(['revoked', 'disabled'] as const)(
    'revalidates an administrator session when %s',
    async (change) => {
      const headers = kit.admin();
      const sessionId = await sha256Hex(headers.cookie?.split('=')[1] ?? '');
      const pass = await kit.scanPass(tpl);
      const idempotencyKey = key();
      const response = await raceGate(
        headers,
        codeOf(pass),
        (db) =>
          change === 'disabled'
            ? run(db, "UPDATE users SET status='disabled' WHERE id='admin-1'")
            : run(db, 'UPDATE sessions SET revoked_at=1 WHERE id_hash=?', [sessionId]),
        {
          idempotencyKey,
          scope: { orgId: kit.org.id, templateIds: [tpl], timeZone: 'UTC' },
        },
      );
      try {
        await expectBlocked(response, pass.id, idempotencyKey, 'ACTOR_CHANGED');
      } finally {
        if (change === 'disabled')
          await run(kit.env.DB, "UPDATE users SET status='active' WHERE id='admin-1'");
      }
    },
  );

  it.each(['camera', 'wedge', 'nfc', 'manual'] as const)(
    'preserves valid %s actions and undo',
    async (method) => {
      const s = await kit.scanner({ templateIds: [tpl] });
      const pass = await kit.scanPass(tpl);
      const input =
        method === 'manual' ? { passId: pass.id, method } : { code: pass.scanCode ?? '', method };
      const response = await out(await act(s.headers, input));
      expect(response.kind).toBe('ok');
      expect(
        (
          await kit.post(s.headers, `/scans/${response.scanId}/undo`, {
            idempotencyKey: key(),
          })
        ).status,
      ).toBe(200);
    },
  );

  it('admits a pass whose stored title is hidden by the scanner projection', async () => {
    const s = await kit.scanner({ templateIds: [tpl] });
    const pass = await kit.scanPass(tpl);
    await run(kit.env.DB, 'UPDATE passes SET display_title=?,display_subtitle=? WHERE id=?', [
      'PRIVATE-TITLE-SENTINEL',
      'PRIVATE-SUBTITLE-SENTINEL',
      pass.id,
    ]);
    const result = await out(await act(s.headers, codeOf(pass)));
    expect(result.kind).toBe('ok');
    expect(JSON.stringify(result)).not.toContain('PRIVATE-TITLE-SENTINEL');
    expect(JSON.stringify(result)).not.toContain('PRIVATE-SUBTITLE-SENTINEL');
  });

  it('preserves an offline-queued action using the current server authority', async () => {
    const s = await kit.scanner({ templateIds: [tpl], settings: { offline: true } });
    const pass = await kit.scanPass(tpl);
    const result = await out(
      await act(s.headers, codeOf(pass), {
        clientTs: kit.clock.now() - HOUR,
      }),
    );
    expect(result.kind).toBe('ok');
  });
}
