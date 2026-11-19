import { expect, it } from 'vitest';
import { first, run } from '../../platform/db.ts';
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

async function mixedSessionDevice(headers: Record<string, string>, eventTemplate: string) {
  const event = await kit.event({ mode: 'test', templateIds: [eventTemplate] });
  const made = await request('POST', '/scanning-sessions', headers, {
    orgId: kit.org.id,
    name: `Mixed sample ${kit.fx.ids.token(5)}`,
    timeZone: 'UTC',
    accepts: { templateIds: [templateId], eventIds: [event.id] },
  });
  expect(made.status).toBe(201);
  const session = (await made.json()) as { id: string };
  const device = await request('POST', `/scanning-sessions/${session.id}/devices`, headers, {
    name: `Device ${kit.fx.ids.token(5)}`,
    surface: 'phone',
  });
  expect(device.status).toBe(201);
  return { sessionId: session.id, deviceId: ((await device.json()) as { id: string }).id };
}

it("issues a mixed session's sample from its first event", async () => {
  const actor = await member();
  const headers = { ...actor.session.headers, 'x-passbook-mode': 'test' };
  const ticket = await kit.scanTemplate('Mixed sample ticket', {
    actions: [{ id: 'check_in', label: 'Check in', kind: 'check_in' }],
  });
  const { deviceId } = await mixedSessionDevice(headers, ticket);
  const response = await request('POST', scannerPath(deviceId, 'sample-pass'), headers);
  expect(response.status).toBe(201);
  const sample = (await response.json()) as { passId: string; templateId: string };
  expect(sample.templateId).toBe(ticket);
  expect(
    await first(kit.env.DB, 'SELECT template_id,mode FROM passes WHERE id=?', [sample.passId]),
  ).toEqual({ template_id: ticket, mode: 'test' });
});

it('issues no sample when the mixed admits change at commit', async () => {
  const actor = await member();
  const headers = { ...actor.session.headers, 'x-passbook-mode': 'test' };
  const ticket = await kit.scanTemplate('Mixed sample race', {
    actions: [{ id: 'check_in', label: 'Check in', kind: 'check_in' }],
  });
  const { sessionId, deviceId } = await mixedSessionDevice(headers, ticket);
  const before = await passState();
  const response = await atCommit(
    'pass',
    async (db) => {
      await run(db, 'UPDATE scanning_sessions SET accepts=?,updated_at=updated_at+1 WHERE id=?', [
        JSON.stringify({ templateIds: [templateId] }),
        sessionId,
      ]);
    },
    () => request('POST', scannerPath(deviceId, 'sample-pass'), headers),
  );
  expect([403, 409, 412]).toContain(response.status);
  expect(await passState()).toEqual(before);
});
