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
    'rejects an already %s scope instead of returning an unrestricted or empty activity page',
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
      await noLeak(await f.device(), 401, 'SCANNER_UNAUTHENTICATED', f.pass.id, ACTIVITY_NAME);
      await noLeak(await f.console(), 404, 'SCANNING_SESSION_NOT_FOUND', f.pass.id, ACTIVITY_NAME);
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
        consumer === 'device' ? 401 : 404,
        consumer === 'device' ? 'SCANNER_UNAUTHENTICATED' : 'SCANNING_SESSION_NOT_FOUND',
        f.pass.id,
        ACTIVITY_NAME,
      );
    },
  );
});
