import type { SqlValue } from '../../platform/db.ts';
import type { ScanActor } from './actor.ts';
import { DEVICE_IDLE_MS } from './auth-store.ts';
import {
  liveAdminFreshLifetimePredicate,
  liveAdminLifetimePredicate,
  liveScannerFreshLifetimePredicate,
  liveScannerLifetimePredicate,
  liveTerminalLifetimePredicate,
} from './repo-live-lifetime.ts';
import { STAFF_IDLE_MS, STAFF_MAX_MS } from './staff-binding.ts';

export const LIVE_ROW_TTL_MS = 15 * 60_000;

/** Keep the originally observed absolute and idle deadlines through every async live fence. */
export function liveActorDeadline(actor: ScanActor, csrf: D1Result | undefined): number {
  const scanner = actor.scanner;
  const idle = (csrf?.results?.[0] as { session_idle?: unknown } | undefined)?.session_idle;
  let expiresAt =
    actor.principal === 'admin'
      ? Math.min(
          actor.tenantAuthority?.sessionExpiresAt ?? 0,
          typeof idle === 'number' && Number.isSafeInteger(idle) && idle >= 0 ? idle : 0,
        )
      : scanner
        ? (scanner.expiresAt ?? Infinity)
        : 0;
  if (actor.principal === 'scanner' && !actor.terminal && scanner) {
    expiresAt = Math.min(expiresAt, (scanner.lastSeenAt ?? scanner.pairedAt ?? 0) + DEVICE_IDLE_MS);
    if (actor.staff)
      expiresAt = Math.min(
        expiresAt,
        (scanner.staffSeenAt ?? 0) + STAFF_IDLE_MS,
        (scanner.staffSince ?? 0) + STAFF_MAX_MS,
      );
  }
  return expiresAt;
}

/** A later idle shortening cannot outlive the deadline checked after the final read. */
export function liveActorLifetimeFence(
  actor: ScanActor,
  csrf: D1Result | undefined,
): { sql: string; params: readonly SqlValue[] } | null {
  if (csrf?.success !== true || csrf.results?.length !== 1) return null;
  if (actor.principal === 'admin') {
    const idle = (csrf?.results?.[0] as { session_idle?: unknown } | undefined)?.session_idle;
    if (
      typeof actor.platformSessionId !== 'string' ||
      typeof idle !== 'number' ||
      !Number.isSafeInteger(idle) ||
      idle < 0
    )
      return null;
    return liveAdminLifetimePredicate(actor.platformSessionId, idle);
  }
  const scanner = actor.scanner;
  if (!scanner) return null;
  if (actor.terminal) return liveTerminalLifetimePredicate();
  const seen = scanner.lastSeenAt ?? scanner.pairedAt;
  if (seen === null || !Number.isSafeInteger(seen)) return null;
  const staffSeen = actor.staff ? scanner.staffSeenAt : null;
  if (actor.staff && (staffSeen === null || !Number.isSafeInteger(staffSeen))) return null;
  return liveScannerLifetimePredicate(actor, scanner, seen, staffSeen);
}

/** Rebind the current lifetime of the original actor at the common final batch time. */
export function liveActorFreshLifetimeFence(
  actor: ScanActor,
  now: number,
): { sql: string; params: readonly SqlValue[] } | null {
  if (!Number.isSafeInteger(now) || now < 0) return null;
  if (actor.principal === 'admin') {
    const authority = actor.tenantAuthority;
    if (
      !authority ||
      authority.sessionId !== actor.platformSessionId ||
      authority.userId !== actor.actor.id
    )
      return null;
    return liveAdminFreshLifetimePredicate(authority, now);
  }
  const scanner = actor.scanner;
  if (!scanner) return null;
  return liveScannerFreshLifetimePredicate(actor, scanner, now);
}
