import { describe, expect, it } from 'vitest';
import { makeOrg, runOne } from '../../../../test/helpers/index.ts';
import {
  ACTION,
  ACTIVITY_NAME,
  activityFixture,
  atActivityRead,
  consoleRows,
  deviceRows,
  noLeak,
} from './repo-session-activity-authority-test-fixtures.ts';

const invalidScopes = [
  'archived event',
  'deleted event',
  'event without templates',
  'event with unreleased template',
  'event with wrong-mode release',
  'event with foreign template',
  'missing selected template',
  'unreleased selected template',
] as const;

describe('invalid session activity scopes', () => {
  it.each(invalidScopes)(
    'shows the device and the console no activity for an already %s scope, keeping the device paired',
    async (invalid) => {
      const f = await activityFixture();
      for (const rows of [await deviceRows(await f.device()), await consoleRows(await f.console())])
        expect(rows).toEqual([
          expect.objectContaining({ id: f.scanId, passId: f.pass.id, title: ACTIVITY_NAME }),
        ]);

      const db = f.kit.env.DB;
      if (invalid === 'archived event')
        await runOne(
          db,
          'UPDATE scan_events SET archived_at=?,updated_at=updated_at+1 WHERE id=?',
          [f.kit.clock.now(), f.event.id],
        );
      if (invalid === 'deleted event')
        await runOne(db, 'DELETE FROM scan_events WHERE id=?', [f.event.id]);
      if (invalid === 'event without templates')
        await runOne(db, 'DELETE FROM scan_event_templates WHERE event_id=?', [f.event.id]);
      if (
        invalid === 'event with unreleased template' ||
        invalid === 'event with wrong-mode release' ||
        invalid === 'event with foreign template'
      ) {
        const foreign = invalid === 'event with foreign template' ? await makeOrg(f.kit.fx) : null;
        const template = await f.kit.scanTemplate(
          'Invalid event member',
          { actions: [ACTION] },
          {
            ...(foreign ? { orgId: foreign.id } : {}),
            ...(invalid === 'event with unreleased template' ? { releaseModes: [] } : {}),
            ...(invalid === 'event with wrong-mode release'
              ? { releaseModes: ['test'] as const }
              : {}),
          },
        );
        await runOne(db, 'INSERT INTO scan_event_templates(event_id,template_id) VALUES(?,?)', [
          f.event.id,
          template,
        ]);
      }
      if (invalid === 'missing selected template' || invalid === 'unreleased selected template') {
        const template = await f.kit.scanTemplate(
          'Unreleased session member',
          { actions: [ACTION] },
          { releaseModes: [] },
        );
        await runOne(
          db,
          'UPDATE scanning_sessions SET accepts=?,updated_at=updated_at+1 WHERE id=?',
          [JSON.stringify({ templateIds: [f.template, template] }), f.sessionId],
        );
        if (invalid === 'missing selected template')
          await runOne(db, 'DELETE FROM templates WHERE id=?', [template]);
      }
      // An invalid scope is configuration: the device stays paired and sees nothing.
      const device = await f.device();
      expect(device.status).toBe(200);
      const deviceText = await device.text();
      expect(JSON.parse(deviceText)).toEqual({ items: [] });
      for (const secret of [f.pass.id, ACTIVITY_NAME]) expect(deviceText).not.toContain(secret);
      // The session stays open so an admin can fix it: never as all templates, and no activity it
      // cannot scope (a rename or other edit answers the same detail).
      const detail = await f.console();
      expect(detail.status).toBe(200);
      const text = await detail.text();
      expect(JSON.parse(text)).toMatchObject({
        accepts: null,
        settings: { acceptAllTemplates: false },
        activity: [],
      });
      for (const secret of [f.pass.id, ACTIVITY_NAME]) expect(text).not.toContain(secret);
    },
  );

  const races = (['device', 'console'] as const).flatMap((consumer) =>
    (['event revision', 'event archived', 'template archived'] as const).map(
      (change) => [consumer, change] as const,
    ),
  );
  it.each(races)(
    'handles a %s activity read when its original %s changes at the final batch',
    async (consumer, change) => {
      const f = await activityFixture();
      const response = await atActivityRead(
        f.kit.env,
        consumer === 'device' ? f.device : f.console,
        async (db) => {
          if (change === 'event revision')
            await runOne(
              db,
              "UPDATE scan_events SET name='Changed',updated_at=updated_at+1 WHERE id=?",
              [f.event.id],
            );
          if (change === 'event archived')
            await runOne(
              db,
              'UPDATE scan_events SET archived_at=?,updated_at=updated_at+1 WHERE id=?',
              [f.kit.clock.now(), f.event.id],
            );
          if (change === 'template archived')
            await runOne(
              db,
              "UPDATE templates SET status='archived',updated_at=updated_at+1 WHERE id=?",
              [f.template],
            );
        },
      );
      // A rename or an archived template moves no epoch, and a console reader's authority does not
      // depend on the event: the read still serves.
      if (
        change === 'event revision' ||
        change === 'template archived' ||
        (consumer === 'console' && change === 'event archived')
      ) {
        expect(response.status).toBe(200);
        return;
      }
      await noLeak(
        response,
        consumer === 'device' ? 409 : 404,
        consumer === 'device' ? 'SCAN_CONFIG_CHANGED' : 'SCANNING_SESSION_NOT_FOUND',
        f.pass.id,
        ACTIVITY_NAME,
      );
    },
  );

  it.each([
    ['no change', 200, null],
    ['scanner revoked', 401, 'SCANNER_REPAIR'],
    ['scanner time zone', 409, 'SCAN_CONFIG_CHANGED'],
  ] as const)(
    'answers an invalid-scope device read with %s before its authority read',
    async (change, status, code) => {
      const f = await activityFixture();
      await runOne(f.kit.env.DB, 'DELETE FROM scan_event_templates WHERE event_id=?', [f.event.id]);
      const response = await beforeAuthorityRead(f.kit.env, f.device, async (db) => {
        if (change === 'scanner revoked')
          await runOne(db, 'UPDATE scanners SET revoked_at=? WHERE id=?', [
            f.kit.clock.now(),
            f.scanner.id,
          ]);
        if (change === 'scanner time zone')
          await runOne(db, "UPDATE scanners SET time_zone='Europe/Paris' WHERE id=?", [
            f.scanner.id,
          ]);
      });
      if (code === null) {
        expect(response.status).toBe(status);
        expect(await response.json()).toEqual({ items: [] });
        return;
      }
      await noLeak(response, status, code, f.pass.id, ACTIVITY_NAME);
    },
  );
});

/** Runs `change` right before the redacted-scope authority read of an invalid-scope device. */
async function beforeAuthorityRead(
  env: { DB: D1Database },
  operation: () => Promise<Response>,
  change: (db: D1Database) => Promise<void>,
) {
  const real = env.DB;
  let fired = 0;
  const hooked = (statement: D1PreparedStatement): D1PreparedStatement =>
    new Proxy(statement, {
      get(target, member) {
        if (member === 'bind') return (...values: unknown[]) => hooked(target.bind(...values));
        if (member === 'first')
          return async (...args: unknown[]) => {
            if (++fired === 1) await change(real);
            return (target.first as (...values: unknown[]) => unknown).apply(target, args);
          };
        const value = Reflect.get(target, member, target);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
  env.DB = new Proxy(real, {
    get(target, member) {
      if (member === 'prepare')
        return (sql: string) => {
          const statement = target.prepare(sql);
          return sql.startsWith('SELECT (') && sql.endsWith(') AS current')
            ? hooked(statement)
            : statement;
        };
      const value = Reflect.get(target, member, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  try {
    const response = await operation();
    expect(fired).toBe(1);
    return response;
  } finally {
    env.DB = real;
  }
}
