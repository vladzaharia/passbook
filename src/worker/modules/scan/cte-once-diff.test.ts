import { beforeAll, describe, expect, it } from 'vitest';
import type { Mode } from '../../../shared/contracts/common.ts';
import { run } from '../../platform/db.ts';
import { heldGateCapacityStmt } from './repo-act-gate-preflight.ts';
import { eventTotalsStmt, liveEventPresenceSql } from './repo-event-attendance.ts';
import { scanLedgerCommonScopeSql, scanLedgerSuccessfulCandidateSql } from './repo-feed-scope.ts';
import { capacityFullPredicate } from './repo-gates.ts';
import { retainedEventCountSql } from './repo-scan-retention.ts';
import { codeOf, key, type ScanKit, setupScanKit } from './test-kit.ts';

// Differential: the statements as they read before each CTE was referenced once.
const sub = (cte: string) => ({
  org: `(SELECT org_id FROM ${cte})`,
  mode: `(SELECT mode FROM ${cte})`,
  event: `(SELECT event_id FROM ${cte})`,
});
const oldChain = (cte: string, capacity: boolean) => {
  const s = sub(cte);
  const witness = `SELECT witness.id AS witness_id FROM scans witness JOIN ${cte} scope
    ON witness.org_id=scope.org_id AND witness.mode=scope.mode AND witness.event_id=scope.event_id
    WHERE (witness.state='done' AND witness.outcome='ok' AND witness.action_kind='check_in'
      AND witness.undone_by IS NULL AND witness.pass_id IS NOT NULL
      AND witness.id IN (SELECT witness_id FROM live))`;
  return `live AS MATERIALIZED (
      ${liveEventPresenceSql(s.org, s.mode, s.event, '1', true, capacity)}
    ), common AS MATERIALIZED (
      ${witness} AND ${scanLedgerCommonScopeSql('witness')}
    ), candidate AS MATERIALIZED (
      ${witness} AND ${scanLedgerSuccessfulCandidateSql('witness')}
    ), verified AS MATERIALIZED (
      SELECT live.pass_id,live.state FROM live
      JOIN common USING(witness_id) JOIN candidate USING(witness_id)
    )`;
};
const oldTotals = `WITH scope AS MATERIALIZED (SELECT ? AS org_id, ? AS mode, ? AS event_id),
  ${oldChain('scope', false)}, totals AS MATERIALIZED (
    SELECT COUNT(DISTINCT verified.pass_id) AS arrived,
      COUNT(DISTINCT CASE WHEN verified.state='in' THEN verified.pass_id END) AS inside
    FROM verified)
  SELECT totals.arrived + ${retainedEventCountSql('scope.org_id', 'scope.mode', 'scope.event_id', false)} AS arrived,
    totals.inside + ${retainedEventCountSql('scope.org_id', 'scope.mode', 'scope.event_id', true)} AS inside
  FROM totals CROSS JOIN scope`;
const oldHeld = `WITH scope AS MATERIALIZED (
    SELECT org_id,mode,id AS event_id,capacity,reentry,? AS pass_id
    FROM scan_events WHERE id=? AND org_id=? AND mode=?
  ), ${oldChain('scope', true)}, totals AS MATERIALIZED (
    SELECT COUNT(DISTINCT verified.pass_id) AS arrived,
      COUNT(DISTINCT CASE WHEN verified.state='in' THEN verified.pass_id END) AS inside,
      COALESCE(MAX(CASE WHEN verified.pass_id=scope.pass_id THEN 1 ELSE 0 END),0) AS has_arrived,
      COALESCE(MAX(CASE WHEN verified.pass_id=scope.pass_id AND verified.state='in'
        THEN 1 ELSE 0 END),0) AS has_inside
    FROM verified CROSS JOIN scope)
  SELECT CASE WHEN scope.capacity IS NULL THEN 0 WHEN scope.reentry=1 THEN
    (totals.inside + ${retainedEventCountSql('scope.org_id', 'scope.mode', 'scope.event_id', true)}
      >=scope.capacity AND NOT totals.has_inside)
    ELSE (totals.arrived + ${retainedEventCountSql('scope.org_id', 'scope.mode', 'scope.event_id', false)}
      >=scope.capacity AND NOT totals.has_arrived) END AS full
  FROM scope CROSS JOIN totals`;
const oldCapacity = (reentry: boolean) =>
  `SELECT (WITH capacity_scope AS MATERIALIZED (
    SELECT ? AS org_id, ? AS mode, ? AS event_id, ? AS pass_id, ? AS maximum
  ), ${oldChain('capacity_scope', true)}, totals AS MATERIALIZED (
    SELECT COUNT(DISTINCT verified.pass_id) AS occupied,
      COALESCE(MAX(CASE WHEN verified.pass_id=capacity_scope.pass_id THEN 1 ELSE 0 END),0) AS has_pass
    FROM verified CROSS JOIN capacity_scope ${reentry ? "WHERE verified.state='in'" : ''}
  )
  SELECT totals.occupied
    + ${retainedEventCountSql('capacity_scope.org_id', 'capacity_scope.mode', 'capacity_scope.event_id', reentry)}
    >= capacity_scope.maximum AND NOT totals.has_pass
  FROM capacity_scope CROSS JOIN totals) AS full`;

let kit: ScanKit;
let templateId: string;
beforeAll(async () => {
  kit = await setupScanKit();
  templateId = await kit.scanTemplate('CTE once', {
    actions: [{ id: 'check_in', label: 'Check in', kind: 'check_in', repeat: 'always' }],
  });
});

const one = async (sql: string, params: unknown[]) =>
  kit.env.DB.prepare(sql)
    .bind(...params)
    .first();

describe('capacity statements read each CTE once with identical results', () => {
  it('matches the previous statements across presence, undo, deletion and capacity', async () => {
    const event = await kit.event({ templateIds: [templateId] });
    const scanner = await kit.scanner({ eventId: event.id });
    const passes = [];
    const scans: string[] = [];
    for (let n = 0; n < 5; n++) {
      const pass = await kit.scanPass(templateId);
      passes.push(pass);
      const res = await kit.post(scanner.headers, '/actions', {
        input: codeOf(pass),
        idempotencyKey: key(),
        clientTs: kit.clock.now(),
        actionId: 'check_in',
      });
      expect(res.status).toBe(200);
      scans.push(((await res.json()) as { scanId: string }).scanId);
    }
    const stranger = await kit.scanPass(templateId);
    const subjects = [...passes, stranger];
    const mode = 'live' as Mode;
    const org = kit.org.id;
    const compare = async () => {
      const actor = { orgId: org, mode } as never;
      expect(await eventTotalsStmt(kit.env.DB, org, mode, event.id).first()).toEqual(
        await one(oldTotals, [org, mode, event.id]),
      );
      for (const [capacity, reentry] of [
        [null, 0],
        [1, 1],
        [3, 1],
        [3, 0],
        [5, 0],
      ] as const) {
        await run(kit.env.DB, 'UPDATE scan_events SET capacity=?, reentry=? WHERE id=?', [
          capacity,
          reentry,
          event.id,
        ]);
        for (const p of subjects) {
          const gate = { passId: p.id, actionId: 'check_in', scope: 'event' };
          expect(await heldGateCapacityStmt(kit.env.DB, actor, gate, event.id).first()).toEqual(
            await one(oldHeld, [p.id, event.id, org, mode]),
          );
          for (const re of [true, false]) {
            const max = capacity ?? 2;
            const now = capacityFullPredicate(org, mode, event.id, max, re, p.id);
            expect(await one(`SELECT ${now.sql} AS full`, now.params)).toEqual(
              await one(oldCapacity(re), [org, mode, event.id, p.id, max]),
            );
          }
        }
      }
    };
    await compare();
    expect(await eventTotalsStmt(kit.env.DB, org, mode, event.id).first()).toEqual({
      arrived: 5,
      inside: 5,
    });
    // One pass leaves, one scan is undone, one pass is deleted, one is removed.
    await run(kit.env.DB, "UPDATE scan_presence SET state='out' WHERE pass_id=?", [passes[0]?.id]);
    await run(kit.env.DB, "UPDATE scan_gates SET state='out' WHERE pass_id=?", [passes[0]?.id]);
    await compare();
    await run(kit.env.DB, 'UPDATE scans SET undone_by=?, undone_at=1 WHERE id=?', ['u', scans[1]]);
    await compare();
    await run(kit.env.DB, 'UPDATE passes SET deleted_at=1 WHERE id=?', [passes[2]?.id]);
    await run(kit.env.DB, 'UPDATE passes SET removed_at=1 WHERE id=?', [passes[3]?.id]);
    await compare();
  });
});
