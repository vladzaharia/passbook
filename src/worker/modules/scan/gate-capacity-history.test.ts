import { beforeAll, describe, expect, it } from 'vitest';
import type { ScannerFixture } from '../../../../test/helpers/index.ts';
import type { ScanOutcome } from '../../../shared/contracts/scan.ts';
import { first, run } from '../../platform/db.ts';
import type { Pass } from '../passes/repo-map.ts';
import {
  clearScanRetentionDeleteStmt,
  stageScanRetentionDeleteStmt,
} from './repo-scan-retention.ts';
import { prepareScanRetentionDelete } from './scan-retention-proof.ts';
import { codeOf, key, type ScanKit, setupScanKit } from './test-kit.ts';

let kit: ScanKit;
let templateId: string;

beforeAll(async () => {
  kit = await setupScanKit();
  templateId = await kit.scanTemplate('Historical capacity', {
    actions: [{ id: 'check_in', label: 'Check in', kind: 'check_in', repeat: 'always' }],
  });
});

interface Scenario {
  eventId: string;
  scanner: ScannerFixture;
  first: Pass;
  next: Pass;
}

async function scenario(reentry: boolean): Promise<Scenario> {
  const event = await kit.event({ templateIds: [templateId] });
  await run(kit.env.DB, 'UPDATE scan_events SET capacity=1,reentry=? WHERE id=?', [
    reentry,
    event.id,
  ]);
  const scanner = await kit.scanner({
    eventId: event.id,
    settings: { checkIn: { mode: 'in_out' }, direction: 'in' },
  });
  const firstPass = await kit.scanPass(templateId);
  const next = await kit.scanPass(templateId);
  return { eventId: event.id, scanner, first: firstPass, next };
}

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

describe('historical occupancy at the admission gate', () => {
  for (const reentry of [false, true]) {
    it.each(['deleted', 'removed', 'voided', 'expired', 'malformed wallet'] as const)(
      `keeps a %s entrant in a full ${reentry ? 'reentry' : 'single-entry'} event`,
      async (change) => {
        const s = await scenario(reentry);
        expect(await action(s.scanner, s.first)).toMatchObject({ kind: 'ok' });
        if (change === 'deleted')
          await run(kit.env.DB, 'UPDATE passes SET deleted_at=1 WHERE id=?', [s.first.id]);
        if (change === 'removed')
          await run(kit.env.DB, 'UPDATE passes SET removed_at=1 WHERE id=?', [s.first.id]);
        if (change === 'voided')
          await run(kit.env.DB, "UPDATE passes SET status='voided' WHERE id=?", [s.first.id]);
        if (change === 'expired')
          await run(
            kit.env.DB,
            "UPDATE pass_versions SET pass_json=json_set(pass_json,'$.expirationDate',?) WHERE pass_id=? AND version=?",
            [new Date(kit.clock.now() - 60_000).toISOString(), s.first.id, s.first.version],
          );
        if (change === 'malformed wallet')
          await run(
            kit.env.DB,
            "UPDATE pass_versions SET pass_json='{}' WHERE pass_id=? AND version=?",
            [s.first.id, s.first.version],
          );
        const result = await action(s.scanner, s.next);
        expect(result).toMatchObject({
          kind: 'heads_up',
          reason: 'capacity_full',
          counts: { event: { arrived: 1 } },
        });
        expect(
          await first(kit.env.DB, 'SELECT pass_id FROM scan_gates WHERE pass_id=?', [s.next.id]),
        ).toBeNull();
        expect(
          await first(kit.env.DB, 'SELECT pass_id FROM scan_presence WHERE pass_id=?', [s.next.id]),
        ).toBeNull();
      },
    );

    it(`keeps a proven hard-deleted entrant in a full ${reentry ? 'reentry' : 'single-entry'} event`, async () => {
      const s = await scenario(reentry);
      const entered = await action(s.scanner, s.first);
      expect(entered).toMatchObject({ kind: 'ok' });
      if (!entered.scanId) throw new Error('Missing entry scan');
      const db = kit.env.DB;
      const deletion = await prepareScanRetentionDelete(kit.env, s.first);
      await db.batch([
        stageScanRetentionDeleteStmt(db, s.first.id, deletion),
        db.prepare('DELETE FROM passes WHERE id=?').bind(s.first.id),
        clearScanRetentionDeleteStmt(db, deletion),
      ]);
      expect(
        await first(db, 'SELECT state,presence_state FROM scan_retained_gates WHERE scan_id=?', [
          entered.scanId,
        ]),
      ).toEqual({ state: 'in', presence_state: 'in' });
      expect(await action(s.scanner, s.next)).toMatchObject({
        kind: 'heads_up',
        reason: 'capacity_full',
        counts: { event: { arrived: 1 } },
      });
      expect(
        await first(db, 'SELECT pass_id FROM scan_gates WHERE pass_id=?', [s.next.id]),
      ).toBeNull();
    });

    it(`excludes quarantined hard-deleted entrants from ${reentry ? 'reentry' : 'single-entry'} capacity`, async () => {
      const s = await scenario(reentry);
      const entered = await action(s.scanner, s.first);
      expect(entered).toMatchObject({ kind: 'ok' });
      if (!entered.scanId) throw new Error('Missing entry scan');
      const db = kit.env.DB;
      await run(db, 'UPDATE passes SET test_data_quarantined=1 WHERE id=?', [s.first.id]);
      const deletion = await prepareScanRetentionDelete(kit.env, s.first);
      await db.batch([
        stageScanRetentionDeleteStmt(db, s.first.id, deletion),
        db.prepare('DELETE FROM passes WHERE id=?').bind(s.first.id),
        clearScanRetentionDeleteStmt(db, deletion),
      ]);
      expect(
        await first(db, 'SELECT scan_id FROM scan_retained_gates WHERE scan_id=?', [
          entered.scanId,
        ]),
      ).toBeNull();
      expect(await action(s.scanner, s.next)).toMatchObject({
        kind: 'ok',
        counts: { event: { arrived: 1 } },
      });
    });

    it.each(['quarantined', 'cross-scope gate', 'invalid issued pin'] as const)(
      `excludes %s entrant from a ${reentry ? 'reentry' : 'single-entry'} event`,
      async (change) => {
        const s = await scenario(reentry);
        expect(await action(s.scanner, s.first)).toMatchObject({ kind: 'ok' });
        if (change === 'quarantined') {
          await run(kit.env.DB, 'UPDATE passes SET test_data_quarantined=1 WHERE id=?', [
            s.first.id,
          ]);
        } else if (change === 'cross-scope gate') {
          await run(kit.env.DB, 'DELETE FROM scan_presence WHERE pass_id=?', [s.first.id]);
          await run(
            kit.env.DB,
            "UPDATE scan_gates SET org_id='other-organization' WHERE pass_id=?",
            [s.first.id],
          );
        } else {
          const otherTemplate = await kit.scanTemplate('Foreign issued pin', {
            actions: [{ id: 'check_in', label: 'Check in', kind: 'check_in' }],
          });
          const other = await kit.scanPass(otherTemplate);
          if (!other.releaseId) throw new Error('Missing issued release fixture');
          await run(kit.env.DB, 'UPDATE passes SET release_id=? WHERE id=?', [
            other.releaseId,
            s.first.id,
          ]);
        }
        const result = await action(s.scanner, s.next);
        expect(result).toMatchObject({ kind: 'ok', counts: { event: { arrived: 1 } } });
        expect(
          await first(
            kit.env.DB,
            'SELECT last_scan_id FROM scan_gates WHERE pass_id=? AND scope=?',
            [s.next.id, `event:${s.eventId}`],
          ),
        ).toEqual({ last_scan_id: result.scanId });
      },
    );
  }
});

describe('event capacity independent of the action gate scope', () => {
  for (const reentry of [false, true]) {
    it.each([
      ['once', 'already_done'],
      ['daily', 'already_done'],
      ['cooldown', 'cooldown'],
      ['always', null],
    ] as const)(
      `reports the %s gate correctly for an existing ${reentry ? 'inside' : 'arrived'} entrant at full capacity`,
      async (repeat, reason) => {
        const template = await kit.scanTemplate(`Full existing ${repeat}`, {
          actions: [
            { id: 'check_in', label: 'Check in', kind: 'check_in', repeat, cooldownMinutes: 5 },
          ],
        });
        const event = await kit.event({ templateIds: [template] });
        await run(kit.env.DB, 'UPDATE scan_events SET capacity=1,reentry=? WHERE id=?', [
          reentry,
          event.id,
        ]);
        const scanner = await kit.scanner({ eventId: event.id });
        const existing = await kit.scanPass(template);
        const newcomer = await kit.scanPass(template);
        expect(await action(scanner, existing)).toMatchObject({ kind: 'ok' });
        const repeated = await action(scanner, existing);
        expect(repeated).toMatchObject(reason ? { kind: 'heads_up', reason } : { kind: 'ok' });
        expect(await action(scanner, newcomer)).toMatchObject({
          kind: 'heads_up',
          reason: 'capacity_full',
        });
      },
    );

    it.each(['always', 'daily'] as const)(
      `counts a %s gate toward ${reentry ? 'inside' : 'arrived'} capacity`,
      async (repeat) => {
        const template = await kit.scanTemplate(`Capacity ${repeat}`, {
          actions: [{ id: 'check_in', label: 'Check in', kind: 'check_in', repeat }],
        });
        const event = await kit.event({ templateIds: [template] });
        await run(kit.env.DB, 'UPDATE scan_events SET capacity=1,reentry=? WHERE id=?', [
          reentry,
          event.id,
        ]);
        const scanner = await kit.scanner({ eventId: event.id });
        const firstPass = await kit.scanPass(template);
        const next = await kit.scanPass(template);
        expect(await action(scanner, firstPass)).toMatchObject({
          kind: 'ok',
          counts: { event: { arrived: 1, inside: reentry ? 1 : null } },
        });
        const gate = await first<{ scope: string }>(
          kit.env.DB,
          'SELECT scope FROM scan_gates WHERE pass_id=? AND action_id=?',
          [firstPass.id, 'check_in'],
        );
        if (repeat === 'always') expect(gate?.scope).toBe('');
        else expect(gate?.scope).toMatch(/^day:/);
        expect(
          await first(kit.env.DB, 'SELECT scope,state FROM scan_presence WHERE pass_id=?', [
            firstPass.id,
          ]),
        ).toEqual({ scope: `event:${event.id}`, state: 'in' });
        if (repeat === 'daily')
          expect(await action(scanner, firstPass)).toMatchObject({
            kind: 'heads_up',
            reason: 'already_done',
          });
        expect(await action(scanner, next)).toMatchObject({
          kind: 'heads_up',
          reason: 'capacity_full',
          counts: { event: { arrived: 1, inside: reentry ? 1 : null } },
        });
        expect(
          await first(kit.env.DB, 'SELECT pass_id FROM scan_gates WHERE pass_id=?', [next.id]),
        ).toBeNull();
      },
    );

    it(`does not count the same entrant twice against ${reentry ? 'inside' : 'arrived'} capacity`, async () => {
      const event = await kit.event({ templateIds: [templateId] });
      await run(kit.env.DB, 'UPDATE scan_events SET capacity=1,reentry=? WHERE id=?', [
        reentry,
        event.id,
      ]);
      const scanner = await kit.scanner({ eventId: event.id });
      const pass = await kit.scanPass(templateId);
      const next = await kit.scanPass(templateId);
      expect(await action(scanner, pass)).toMatchObject({ kind: 'ok' });
      expect(await action(scanner, pass)).toMatchObject({
        kind: 'ok',
        counts: { event: { arrived: 1, inside: reentry ? 1 : null } },
      });
      expect(await action(scanner, next)).toMatchObject({
        kind: 'heads_up',
        reason: 'capacity_full',
      });
    });

    it(`allows a counted entrant after ${reentry ? 'inside' : 'arrived'} capacity is lowered`, async () => {
      const event = await kit.event({ templateIds: [templateId] });
      await run(kit.env.DB, 'UPDATE scan_events SET capacity=2,reentry=? WHERE id=?', [
        reentry,
        event.id,
      ]);
      const scanner = await kit.scanner({ eventId: event.id });
      const firstPass = await kit.scanPass(templateId);
      const second = await kit.scanPass(templateId);
      const next = await kit.scanPass(templateId);
      expect(await action(scanner, firstPass)).toMatchObject({ kind: 'ok' });
      expect(await action(scanner, second)).toMatchObject({ kind: 'ok' });
      await run(kit.env.DB, 'UPDATE scan_events SET capacity=1 WHERE id=?', [event.id]);
      expect(await action(scanner, firstPass)).toMatchObject({ kind: 'ok' });
      expect(await action(scanner, next)).toMatchObject({
        kind: 'heads_up',
        reason: 'capacity_full',
      });
    });

    it(`keeps valid presence when the action gate has a different tenant for ${reentry ? 'inside' : 'arrived'} capacity`, async () => {
      const s = await scenario(reentry);
      expect(await action(s.scanner, s.first)).toMatchObject({ kind: 'ok' });
      await run(kit.env.DB, "UPDATE scan_gates SET org_id='other-organization' WHERE pass_id=?", [
        s.first.id,
      ]);
      expect(await action(s.scanner, s.next)).toMatchObject({
        kind: 'heads_up',
        reason: 'capacity_full',
        counts: { event: { arrived: 1, inside: reentry ? 1 : null } },
      });
    });
  }
});
