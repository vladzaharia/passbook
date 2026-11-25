import { beforeAll, expect, it } from 'vitest';
import { scannerActor, withRole } from './actor.ts';
import { liveReadyId, liveRingRow } from './live.ts';
import { getScanner } from './repo-device.ts';
import { candidateById } from './repo-lookup.ts';
import { readScannerScope } from './repo-scope.ts';
import { bindScanningSession } from './scanning-workspace.ts';
import { type EnrollFixture, enrollFixture } from './tags-enroll-test-fixtures.ts';
import { key, proofedScanActor } from './test-kit.ts';

let f: EnrollFixture;
beforeAll(async () => {
  f = await enrollFixture();
});

it('never sends a draft to a device socket', async () => {
  const desk = await f.device('desk');
  const device = await f.connect(desk.id);
  const row = await f.kit.scanner({ templateIds: [f.tpl] });
  const source = await getScanner(f.kit.env.DB, row.id);
  if (!source) throw new Error('Missing source.');
  const scope = await readScannerScope(f.kit.env.DB, source, source.staffId);
  const actor = scannerActor(f.kit.ctx, source, source.mode, 'cookie', scope);
  await bindScanningSession(f.kit.ctx, actor);
  withRole(actor, null);
  const pass = await f.kit.scanPass(f.tpl);
  const candidate = await candidateById(f.kit.env.DB, f.kit.org.id, pass.id);
  const readyId = await liveReadyId(row.id, key());
  const entry = await liveRingRow(
    f.kit.ctx,
    await proofedScanActor(f.kit.ctx, actor),
    {
      id: readyId,
      at: f.kit.clock.now(),
      scannerId: row.id,
      scannerName: 'Counter',
      passId: null,
      holder: null,
      photoUrl: null,
      kind: 'ready',
      direction: null,
      label: 'Choose an action',
      presented: true,
    },
    candidate,
    null,
  );
  if (!entry) throw new Error('No ring entry.');
  const input = { orgId: f.kit.org.id, mode: 'live' as const, readyId, scannerId: row.id };
  expect(await f.hub().publish({ orgId: f.kit.org.id, mode: 'live', row: entry })).toBe(true);
  const say = { headline: 'To pay $12.00', sub: null };
  expect(await f.hub().draft({ ...input, say })).toBe(0);
  expect(await f.hub().clearDraft(input)).toBe(0);
  await f.wait(80);
  expect(device.messages).toEqual([]);
  expect(device.closed).toEqual([]);
  device.socket.close(1000);
});
