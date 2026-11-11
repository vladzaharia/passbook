import { beforeAll, expect, it } from 'vitest';
import { first, run } from '../../platform/db.ts';
import { scannerActor, withRole } from './actor.ts';
import { eventPassPredicate } from './repo-action-authority.ts';
import { getScanner } from './repo-device.ts';
import { readScannerScope } from './repo-scope.ts';
import { codeOf, key, proofedScanActor, type ScanKit, setupScanKit } from './test-kit.ts';

let kit: ScanKit;
let templateId: string;
beforeAll(async () => {
  kit = await setupScanKit();
  templateId = await kit.scanTemplate('Event match authority', {
    actions: [{ id: 'check_in', label: 'Check in', kind: 'check_in' }],
  });
});

it('applies the same event filter to check-in and expected membership', async () => {
  const event = await kit.event({ templateIds: [templateId] });
  await run(kit.env.DB, 'UPDATE scan_events SET match_input=?,match_values=? WHERE id=?', [
    'tier',
    JSON.stringify(['gold']),
    event.id,
  ]);
  const scanner = await kit.scanner({ eventId: event.id });
  const accepted = await kit.scanPass(templateId, { tier: 'gold' });
  const rejected = await kit.scanPass(templateId, { tier: 'silver' });
  const action = (pass: typeof accepted) =>
    kit.post(scanner.headers, '/actions', {
      input: codeOf(pass),
      idempotencyKey: key(),
      clientTs: kit.clock.now(),
      actionId: 'check_in',
    });
  const admitted = await action(accepted);
  expect(admitted.status).toBe(200);
  expect(await admitted.json()).toMatchObject({ kind: 'ok', counts: { event: { expected: 1 } } });
  const refused = await action(rejected);
  expect(refused.status).toBe(200);
  expect(await refused.json()).toMatchObject({ kind: 'refused', reason: 'wrong_event' });
  expect(
    await first(kit.env.DB, 'SELECT pass_id FROM scan_gates WHERE pass_id=?', [rejected.id]),
  ).toBeNull();
});

it('fails closed on malformed filters and SQLite numeric representations at the pass fence', async () => {
  const event = await kit.event({ templateIds: [templateId] });
  const scanner = await kit.scanner({ eventId: event.id });
  const row = await getScanner(kit.env.DB, scanner.id);
  if (!row) throw new Error('Missing scanner');
  const scope = await readScannerScope(kit.env.DB, row, null);
  const actor = await proofedScanActor(
    kit.ctx,
    withRole(scannerActor(kit.ctx, row, row.mode, 'cookie', scope), null),
  );
  const pass = await kit.scanPass(templateId, { tier: 'gold', balance: 1 });
  const fence = eventPassPredicate(actor, actor.event);
  const allowed = () =>
    first<{ allowed: number }>(
      kit.env.DB,
      `SELECT (${fence.sql}) AS allowed FROM passes p WHERE p.id=?`,
      [...fence.params, pass.id],
    );
  expect(await allowed()).toEqual({ allowed: 1 });
  await run(kit.env.DB, 'UPDATE scan_events SET match_input=?,match_values=? WHERE id=?', [
    'tier',
    JSON.stringify(['gold']),
    event.id,
  ]);
  expect(await allowed()).toEqual({ allowed: 1 });
  await run(kit.env.DB, 'UPDATE scan_events SET match_values=? WHERE id=?', [
    JSON.stringify(['gold', 3]),
    event.id,
  ]);
  expect(await allowed()).toEqual({ allowed: 0 });
  await run(kit.env.DB, 'UPDATE scan_events SET match_input=?,match_values=? WHERE id=?', [
    'balance',
    JSON.stringify(['1']),
    event.id,
  ]);
  await run(
    kit.env.DB,
    "UPDATE passes SET personalization=json_set(personalization,'$.balance',json('1.0')) WHERE id=?",
    [pass.id],
  );
  expect(await allowed()).toEqual({ allowed: 0 });
});
