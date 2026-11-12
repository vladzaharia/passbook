import { beforeAll, expect, it } from 'vitest';
import { makeOrg, makeScanner, type ScannerFixture } from '../../../../test/helpers/index.ts';
import type { ScanOutcome } from '../../../shared/contracts/scan.ts';
import { first, run } from '../../platform/db.ts';
import type { Pass } from '../passes/repo-map.ts';
import { eventTotalsStmt } from './repo-event-attendance.ts';
import { codeOf, key, type ScanKit, setupScanKit } from './test-kit.ts';

let kit: ScanKit;
beforeAll(async () => {
  kit = await setupScanKit();
});

async function action(scanner: ScannerFixture, pass: Pass): Promise<ScanOutcome> {
  const response = await kit.post(scanner.headers, '/actions', {
    input: codeOf(pass),
    idempotencyKey: key(),
    clientTs: kit.clock.now(),
    actionId: 'check_in',
  });
  expect(response.status).toBe(200);
  return (await response.json()) as ScanOutcome;
}

it.each(['once', 'daily', 'always', 'cooldown'] as const)(
  'counts event admissions without changing the %s action gate scope',
  async (repeat) => {
    const templateId = await kit.scanTemplate(`Event ${repeat}`, {
      actions: [
        { id: 'check_in', label: 'Check in', kind: 'check_in', repeat, cooldownMinutes: 5 },
      ],
    });
    const event = await kit.event({ templateIds: [templateId] });
    await run(kit.env.DB, 'UPDATE scan_events SET capacity=2,reentry=1 WHERE id=?', [event.id]);
    const scanner = await kit.scanner({ eventId: event.id });
    const a = await kit.scanPass(templateId);
    const b = await kit.scanPass(templateId);
    const c = await kit.scanPass(templateId);
    expect(await action(scanner, a)).toMatchObject({ kind: 'ok' });
    expect(await action(scanner, b)).toMatchObject({
      kind: 'ok',
      counts: { event: { arrived: 2, inside: 2 } },
    });
    const gate = await first<{ scope: string }>(
      kit.env.DB,
      'SELECT scope FROM scan_gates WHERE pass_id=?',
      [a.id],
    );
    expect(gate?.scope).toBe(
      repeat === 'once'
        ? `event:${event.id}`
        : repeat === 'daily'
          ? `day:${new Date(kit.clock.now()).toISOString().slice(0, 10)}`
          : '',
    );
    expect(
      await first(
        kit.env.DB,
        'SELECT state,last_scan_id FROM scan_presence WHERE pass_id=? AND scope=?',
        [a.id, `event:${event.id}`],
      ),
    ).toMatchObject({ state: 'in', last_scan_id: expect.any(String) });
    expect(await action(scanner, c)).toMatchObject({ kind: 'heads_up', reason: 'capacity_full' });
    if (repeat === 'always')
      expect(await action(scanner, a)).toMatchObject({
        kind: 'ok',
        counts: { event: { arrived: 2, inside: 2 } },
      });
  },
);

it('keeps independent attendance when two events share an always-repeat action gate', async () => {
  const templateId = await kit.scanTemplate('Shared repeat gate', {
    actions: [{ id: 'check_in', label: 'Check in', kind: 'check_in', repeat: 'always' }],
  });
  const a = await kit.event({ templateIds: [templateId] });
  const b = await kit.event({ templateIds: [templateId] });
  const scannerA = await kit.scanner({ eventId: a.id });
  const scannerB = await kit.scanner({ eventId: b.id });
  const pass = await kit.scanPass(templateId);
  expect(await action(scannerA, pass)).toMatchObject({ kind: 'ok' });
  expect(await action(scannerB, pass)).toMatchObject({ kind: 'ok' });
  expect(await eventTotalsStmt(kit.env.DB, kit.org.id, pass.mode, a.id).first()).toEqual({
    arrived: 1,
    inside: 1,
  });
  expect(await eventTotalsStmt(kit.env.DB, kit.org.id, pass.mode, b.id).first()).toEqual({
    arrived: 1,
    inside: 1,
  });
});

it('counts attendance only when both ledger scopes match the same live witness', async () => {
  const templateId = await kit.scanTemplate('Attendance witness', {
    actions: [{ id: 'check_in', label: 'Check in', kind: 'check_in' }],
  });
  const otherTemplate = await kit.scanTemplate('Other witness template', {
    actions: [{ id: 'check_in', label: 'Check in', kind: 'check_in' }],
  });
  const event = await kit.event({ templateIds: [templateId] });
  const scanner = await kit.scanner({ eventId: event.id });
  const foreignOrg = await makeOrg(kit.fx);
  const foreign = await makeScanner(kit.fx, { orgId: foreignOrg.id });
  const pass = await kit.scanPass(templateId);
  const scope = `event:${event.id}`;
  const unqualified = kit.fx.ids.id();
  const foreignWitness = kit.fx.ids.id();
  const valid = kit.fx.ids.id();
  async function recordWitness(id: string, scannerId: string, witnessTemplate: string) {
    await run(
      kit.env.DB,
      `INSERT INTO scans
        (id,org_id,mode,pass_id,template_id,scanner_id,event_id,actor_type,actor_id,actor_key,
         idempotency_key,request_hash,method,state,outcome,action_id,action_kind,direction,presence_scope,at)
      VALUES (?,?,?,?,?,?,?,'scanner',?,?,?,?,'camera','done','ok','check_in','check_in','in',?,?)`,
      [
        id,
        kit.org.id,
        'live',
        pass.id,
        witnessTemplate,
        scannerId,
        event.id,
        scannerId,
        `s:${scannerId}`,
        id,
        id,
        scope,
        kit.clock.now(),
      ],
    );
  }
  await recordWitness(unqualified, scanner.id, otherTemplate);
  await recordWitness(foreignWitness, foreign.id, templateId);
  await run(
    kit.env.DB,
    `INSERT INTO scan_presence
      (pass_id,org_id,scope,state,tracking,entered_at,first_at,last_entry_at,last_scan_id)
     VALUES (?,?,?,'in',1,?,?,?,?)`,
    [pass.id, kit.org.id, scope, kit.clock.now(), kit.clock.now(), kit.clock.now(), unqualified],
  );
  expect(await eventTotalsStmt(kit.env.DB, kit.org.id, pass.mode, event.id).first()).toEqual({
    arrived: 0,
    inside: 0,
  });
  await recordWitness(valid, scanner.id, templateId);
  await run(kit.env.DB, 'UPDATE scan_presence SET last_scan_id=? WHERE pass_id=? AND scope=?', [
    valid,
    pass.id,
    scope,
  ]);
  expect(await eventTotalsStmt(kit.env.DB, kit.org.id, pass.mode, event.id).first()).toEqual({
    arrived: 1,
    inside: 1,
  });
});
