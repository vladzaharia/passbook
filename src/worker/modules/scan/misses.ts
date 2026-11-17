import { type Grant, type GrantedStatement, grant } from '../../platform/authority.ts';
import type { GrantCond } from '../../platform/authority-cond.ts';
import type { SqlValue } from '../../platform/db.ts';
import { AppError, DENY_REASONS } from '../../platform/errors.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import type { ScanActor } from './actor.ts';
import { scanActorChecks, scanPrincipal } from './authority-checks.ts';
import {
  auditedAtCap,
  crossedCap,
  missCounterKey,
  missIncrementPart,
  readMissIncrementPart,
} from './repo-miss-authority.ts';
import { credentialRefChecks } from './repo-scan-checks.ts';

const WINDOW_MS = 10 * 60_000;
export const MISSES_PER_WINDOW = 30;

export type MissResult = 'not_committed' | 'counted' | 'capped';

/** `counted`, `capped` or `not_committed` from the increment's returned row. */
function missResultOf(row: unknown): MissResult {
  const count = row && typeof row === 'object' && 'count' in row ? row.count : undefined;
  if (typeof count !== 'number' || !Number.isInteger(count) || count < 1) return 'not_committed';
  return count > MISSES_PER_WINDOW ? 'capped' : 'counted';
}

function throwCapped(result: MissResult, window: number, now: number): void {
  if (result !== 'capped') return;
  throw new AppError('SCAN_TOO_MANY_MISSES', 429, 'Too many codes not found. Wait a few minutes.', {
    headers: { 'retry-after': String(Math.ceil((window + WINDOW_MS - now) / 1000)) },
  });
}

/**
 * The miss of a finalized `not_found` stop, counted in the stop's own grant: call right after the
 * statement that closes the scan. The increment applies only if that statement changed its row
 * (`changes()`), so a claim counts once; the audit row follows the increment that crossed the cap.
 */
export function grantMiss(
  g: Grant,
  closing: GrantedStatement,
  ctx: ServiceContext,
  actor: ScanActor,
  now: number,
) {
  const window = now - (now % WINDOW_MS);
  const key = missCounterKey(actor);
  const threshold = MISSES_PER_WINDOW + 1;
  const [increment] = g.include(missIncrementPart(key, window));
  // `changes()` reads the statement before it: anything between them would silently stop the count.
  if (!increment || g.indexOf(increment) !== g.indexOf(closing) + 1)
    throw new Error('The miss increment must follow the statement that closes the scan.');
  g.audit(
    {
      at: now,
      orgId: actor.orgId,
      actorType: actor.actor.type,
      actorId: actor.actor.id,
      action: 'scan.misses_capped',
      targetType: actor.scanner ? 'scanner' : null,
      targetId: actor.scanner?.id ?? null,
      requestId: ctx.requestId,
      ipPrefix: null,
      detail: null,
    },
    [crossedCap(key, window, threshold)],
  );
  return {
    /** From the grant's writes: nothing counted (the scan did not close here), counted, or past the cap. */
    result(writes: readonly D1Result[]): MissResult {
      return missResultOf(writes[g.indexOf(increment)]?.results?.[0]);
    },
    throwIfCapped: (result: MissResult) => throwCapped(result, window, now),
  };
}

const REFUSED = 'SCAN_READ_MISS_REFUSED';
/** A counted miss at the cap without its audit row: the effect is incomplete, so the count is rolled back. */
const INCOMPLETE = 'SCAN_MISS_INCOMPLETE';

/** The observation as an assert condition: `{org}` and `{mode}` are the grant row's. */
const unchangedCond = (observation: ReadMissObservation['unchanged']): GrantCond => ({
  render: (b, _scope, tenant) => {
    let at = 0;
    const sql = observation.sql
      .replace(/\{org\}/g, `${tenant}.org_id`)
      .replace(/\{mode\}/g, `${tenant}.mode`)
      .replace(/\?/g, () => b.bind(observation.params[at++]));
    return sql;
  },
});

/** What a read saw when it found nothing, to be true when the miss is counted. */
export interface ReadMissObservation {
  /** Keyed refs of the presented credential in the actor's mode: none may be retired by a transfer. */
  refs: readonly string[];
  /**
   * SQL that holds while what the read saw still holds (no pass it did not see matches the input). It
   * names the tenant as `{org}` and `{mode}`: the grant's own, never the request's.
   */
  unchanged: { sql: string; params: readonly SqlValue[] };
}

/**
 * The miss of a read that found nothing, counted in its own grant (`org_mode.scan.miss`) after the
 * read: the actor's checks, the credential's refs and the observation hold in the same transaction as
 * the increment, so a revoked actor, a retired credential or a pass that appeared counts nothing.
 * `counted` or `not_committed` (nothing counted, nothing to disclose: log `SCAN_MISS_UNCOUNTED`);
 * past the cap it throws `SCAN_TOO_MANY_MISSES` after the count, and the cap crossing is audited.
 */
export async function grantReadMiss(
  ctx: ServiceContext,
  actor: ScanActor,
  observation: ReadMissObservation,
): Promise<'counted' | 'not_committed'> {
  const now = ctx.clock.now();
  const window = now - (now % WINDOW_MS);
  const key = missCounterKey(actor);
  const threshold = MISSES_PER_WINDOW + 1;
  const g = grant(ctx, {
    purpose: 'org_mode.scan.miss',
    principal: scanPrincipal(actor),
    checks: [...scanActorChecks(actor, { now }), ...credentialRefChecks(observation.refs)],
    tables: ['counters'],
    // `release` names no check of a miss: it is the assert that its cap audit was written.
    codes: Object.fromEntries(
      DENY_REASONS.map((reason) => [reason, reason === 'release' ? INCOMPLETE : REFUSED]),
    ),
  });
  g.assert('stale', [unchangedCond(observation.unchanged)]);
  const [increment] = g.include(readMissIncrementPart(key, window));
  if (!increment) throw new Error('The miss increment is missing.');
  g.audit(
    {
      at: now,
      orgId: actor.orgId,
      actorType: actor.actor.type,
      actorId: actor.actor.id,
      action: 'scan.misses_capped',
      targetType: actor.scanner ? 'scanner' : null,
      targetId: actor.scanner?.id ?? null,
      requestId: ctx.requestId,
      ipPrefix: null,
      detail: null,
    },
    [crossedCap(key, window, threshold)],
  );
  g.assert('release', [auditedAtCap(actor, key, window, threshold, now)]);
  let result: MissResult = 'not_committed';
  try {
    result = missResultOf((await g.commit())[g.indexOf(increment)]?.results?.[0]);
  } catch (error) {
    if (error instanceof AppError && error.code === INCOMPLETE)
      throw new AppError(INCOMPLETE, 500, 'The count was not recorded. Try again.');
    if (!(error instanceof AppError && error.code === REFUSED)) throw error;
  }
  if (result === 'not_committed')
    ctx.log.warn('scan.miss_uncounted', { orgId: actor.orgId, code: 'SCAN_MISS_UNCOUNTED' });
  throwCapped(result, window, now);
  return result === 'not_committed' ? 'not_committed' : 'counted';
}
