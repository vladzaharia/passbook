// Who may let in whose refusal (SA §20.6). The device that refused may; a monitor may for its own session
// or event; an admin for any device of the org. Everyone else gets the answer of an unknown id.
import { classifyD1Error } from '../../platform/db.ts';
import type { ScanActor } from './guard.ts';
import { type CoveredRow, watchCovers, watchCoversSql } from './repo-watch-cover.ts';

/** The monitor's live window: a refusal older than this can no longer be let through (SA 10 widens to 15). */
export const OVERRIDE_WINDOW_MS = 15 * 60_000;

export interface OverrideTarget extends CoveredRow {
  actorKey: string;
}

/** Whether the actor's own scope reaches beyond its own scans: a monitor's watch, or an admin. */
export const actsForOthers = (actor: ScanActor): boolean =>
  actor.principal === 'admin' || actor.scanner?.deviceRole === 'monitor';

export function mayOverrideScan(actor: ScanActor, target: OverrideTarget): boolean {
  if (target.actorKey === actor.actorKey) return true;
  // Act evaluates at the actor's own session and places, so only scans of that session can be let in there.
  if (actor.principal === 'admin') return !target.sessionId;
  if (actor.scanner?.deviceRole !== 'monitor') return false;
  return (
    (!!actor.scanningSession && target.sessionId === actor.scanningSession.id) ||
    watchCovers(actor.watchCover, target)
  );
}

/** The same rule in SQL over `scans q`: own scans, a monitor's own session, an admin's session-less scans. */
export function overrideScopeSql(actor: ScanActor): {
  sql: string;
  params: (string | number | null)[];
} {
  const monitor = actor.scanner?.deviceRole === 'monitor';
  const session = monitor ? (actor.scanningSession?.id ?? null) : null;
  const watch = watchCoversSql(monitor ? actor.watchCover : null);
  return {
    sql: `(q.actor_key = ? OR (? = 1 AND q.session_id IS NULL) OR (? IS NOT NULL AND q.session_id = ?) OR ${watch.sql})`,
    params: [
      actor.actorKey,
      actor.principal === 'admin' ? 1 : 0,
      session,
      session,
      ...watch.params,
    ],
  };
}

/** The one device told that its refusal was let in: the refusing one, and never the device that did it. */
export const resolvedTarget = (
  actor: ScanActor,
  target: { scannerId: string | null },
): string | null =>
  target.scannerId && target.scannerId !== actor.scanner?.id ? target.scannerId : null;

/** A claim met `scans_override_once`: another scan holds this heads-up or refusal, pending or won. */
export function isOverrideOnceViolation(error: unknown): boolean {
  const info = classifyD1Error(error);
  return info?.kind === 'unique' && /scans_override_once|scans\.override_of/.test(info.detail);
}
