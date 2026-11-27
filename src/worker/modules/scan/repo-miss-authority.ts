import type { GrantCond } from '../../platform/authority-cond.ts';
import { AuthorityError } from '../../platform/authority-error.ts';
import { type GrantPart, writePart } from '../../platform/authority-include.ts';
import { type SqlValue, stmt } from '../../platform/db.ts';
import type { ScanActor } from './actor.ts';
import { RACE_MISS_COUNTER } from './race-tags.ts';

/** Misses for one actor are independent across tenants and live/test modes. */
export function missCounterKey(actor: ScanActor): string {
  // A key's misses count apart from the terminal's own, so a key cannot lock the physical till out.
  const who = actor.apiKeyId ? `k:${actor.apiKeyId}:${actor.actorKey}` : actor.actorKey;
  return `scan:miss:${JSON.stringify([actor.orgId, actor.mode, who])}`;
}

const INCREMENT = (when: string) =>
  `INSERT INTO counters (key, window_start, count) SELECT ?, ?, 1 WHERE ${when}{grant}
    ON CONFLICT (key, window_start) DO UPDATE SET count=count+excluded.count RETURNING count`;

/** The increment of a stop grant's miss: it applies only when the statement before it changed a row (the scan closed here). */
export const missIncrementPart = (key: string, window: number): GrantPart =>
  writePart(INCREMENT('changes()=1 AND '), [key, window], RACE_MISS_COUNTER);

/** The increment of a read miss: the grant's own checks are the condition, nothing precedes it. */
export const readMissIncrementPart = (key: string, window: number): GrantPart =>
  writePart(INCREMENT(''), [key, window], RACE_MISS_COUNTER);

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

/** The counter row of an actor's window: one read, in the first batch of a read that could be a miss. */
export const missCountStmt = (db: D1Database, key: string, window: number) =>
  stmt(db, 'SELECT count FROM counters WHERE key = ? AND window_start = ?', [key, window]);

declare const windowBrand: unique symbol;

/**
 * What a read saw when it found nothing, as SQL a grant can assert: it holds while no pass the read
 * could have returned matches the input. It names the tenant only as `{org}` and `{mode}` (the
 * grant's own). Made by `missWindow`, which refuses SQL that could name another tenant, write, or
 * bind the wrong number of values; only `repo-search.ts` and `resolve-passless-read.ts` make one.
 */
export interface MissWindow {
  readonly sql: string;
  readonly params: readonly SqlValue[];
  readonly [windowBrand]: true;
}

export function missWindow(sql: string, params: readonly SqlValue[]): MissWindow {
  const marks = sql.match(/\?/g)?.length ?? 0;
  const bad = (message: string) => new AuthorityError('GRANT_SCOPE_OVERRIDE', message);
  if (marks !== params.length) throw bad('A miss window binds as many values as it has marks.');
  if (/\b(?:org_id|mode)\s*(?:=|IS)\s*\?/i.test(sql) || /\b[ag]\./.test(sql))
    throw bad('A miss window names its tenant only as {org} and {mode}.');
  if (/;|--|\/\*|\b(?:insert|update|delete|replace|attach|pragma|drop|create|alter)\b/i.test(sql))
    throw bad('A miss window is read-only fixed SQL.');
  return Object.freeze({ sql, params: Object.freeze([...params]) }) as MissWindow;
}
