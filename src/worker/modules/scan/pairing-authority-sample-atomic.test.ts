import { describe, expect, it } from 'vitest';
import { run } from '../../platform/db.ts';
import {
  atCommit,
  kit,
  member,
  passState,
  request,
  scannerPath,
  setupPairingAuthorityFixture,
  templateId,
} from './repo-pairing-authority-split-test-fixtures.ts';

setupPairingAuthorityFixture();

/**
 * The sample scope is checked inside the pass create grant, so a change that lands after the
 * request read it and before the create commits refuses the sample. The event a device's session
 * accepts was read only before the commit until then.
 */
async function sessionOnEvent() {
  const actor = await member();
  const headers = { ...actor.session.headers, 'x-passbook-mode': 'test' };
  const other = await kit.scanTemplate('Second event template', {
    actions: [{ id: 'check_in', label: 'Check in', kind: 'check_in' }],
  });
  const event = await kit.event({ mode: 'test', templateIds: [templateId, other] });
  const session = await request('POST', '/scanning-sessions', headers, {
    orgId: kit.org.id,
    name: `Sample ${kit.fx.ids.token(5)}`,
    timeZone: 'UTC',
    accepts: { eventId: event.id },
  });
  expect(session.status).toBe(201);
  const { id: sessionId } = (await session.json()) as { id: string };
  const device = await request('POST', `/scanning-sessions/${sessionId}/devices`, headers, {
    name: `Device ${kit.fx.ids.token(5)}`,
    surface: 'phone',
  });
  expect(device.status).toBe(201);
  const { id: deviceId } = (await device.json()) as { id: string };
  const sample = () => request('POST', scannerPath(deviceId, 'sample-pass'), headers);
  return { event, other, sample };
}

describe('sample scope inside the create grant', () => {
  it('issues when nothing moved (positive control)', async () => {
    const { sample } = await sessionOnEvent();
    const response = await atCommit('pass', async () => {}, sample);
    expect(response.status).toBe(201);
  });

  it.each(['event templates', 'event match', 'event archived'] as const)(
    "refuses when the session event's %s change at commit",
    async (change) => {
      const { event, other, sample } = await sessionOnEvent();
      const before = await passState();
      const response = await atCommit(
        'pass',
        async (db) => {
          if (change === 'event templates')
            await run(db, 'DELETE FROM scan_event_templates WHERE event_id=? AND template_id=?', [
              event.id,
              other,
            ]);
          else if (change === 'event match')
            await run(
              db,
              `UPDATE scan_events SET match_input='memberName',match_values='["x"]',
                updated_at=updated_at+1 WHERE id=?`,
              [event.id],
            );
          else
            await run(
              db,
              'UPDATE scan_events SET archived_at=?,updated_at=updated_at+1 WHERE id=?',
              [kit.clock.now(), event.id],
            );
        },
        sample,
      );
      expect(response.status).toBe(409);
      expect(await passState()).toEqual(before);
    },
    60_000,
  );
});
