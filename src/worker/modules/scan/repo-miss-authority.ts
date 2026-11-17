import type { GrantCond } from '../../platform/authority-cond.ts';
import { type GrantPart, writePart } from '../../platform/authority-include.ts';
import type { ScanActor } from './actor.ts';

/** Misses for one actor are independent across tenants and live/test modes. */
export function missCounterKey(actor: ScanActor): string {
  return `scan:miss:${JSON.stringify([actor.orgId, actor.mode, actor.actorKey])}`;
}

const INCREMENT = (when: string) =>
  `INSERT INTO counters (key, window_start, count) SELECT ?, ?, 1 WHERE ${when}{grant}
    ON CONFLICT (key, window_start) DO UPDATE SET count=count+excluded.count RETURNING count`;

/** The increment of a stop grant's miss: it applies only when the statement before it changed a row (the scan closed here). */
export const missIncrementPart = (key: string, window: number): GrantPart =>
  writePart(INCREMENT('changes()=1 AND '), [key, window]);

/** The increment of a read miss: the grant's own checks are the condition, nothing precedes it. */
export const readMissIncrementPart = (key: string, window: number): GrantPart =>
  writePart(INCREMENT(''), [key, window]);

/** The audit row's condition: the increment just before it crossed the cap. */
export const crossedCap = (key: string, window: number, threshold: number): GrantCond => ({
  render: (b) =>
    `changes()=1 AND EXISTS (SELECT 1 FROM counters WHERE key=${b.bind(key)} AND window_start=${b.bind(window)} AND count=${b.bind(threshold)})`,
});

/** The cap was crossed by this miss, or its audit row exists. */
export const auditedAtCap = (
  actor: ScanActor,
  key: string,
  window: number,
  threshold: number,
  at: number,
): GrantCond => ({
  render: (b, _scope, tenant) =>
    `NOT EXISTS (SELECT 1 FROM counters WHERE key=${b.bind(key)} AND window_start=${b.bind(window)} AND count=${b.bind(threshold)})
    OR EXISTS (SELECT 1 FROM audit_log WHERE org_id=${tenant}.org_id AND action='scan.misses_capped'
      AND actor_id IS ${b.bind(actor.actor.id)} AND at=${b.bind(at)})`,
});
