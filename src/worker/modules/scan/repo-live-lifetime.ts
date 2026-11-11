import type { ScanActor, ScanTenantAuthority } from './actor.ts';
import { DEVICE_IDLE_MS } from './auth-store.ts';
import type { ScannerRow } from './repo-device.ts';
import type { OutputPredicate } from './repo-output-predicates.ts';
import { scanEpochsOf } from './scan-epochs.ts';
import { STAFF_IDLE_MS, STAFF_MAX_MS } from './staff-binding.ts';

export function liveAdminLifetimePredicate(sessionId: string, idle: number): OutputPredicate {
  return {
    sql: `EXISTS (SELECT 1 FROM sessions live_lifetime_session
        WHERE live_lifetime_session.id_hash=?/* scan-ephemeral-session-id-hash */
          AND live_lifetime_session.idle_expires_at>=?)`,
    params: [sessionId, idle],
  };
}

export function liveTerminalLifetimePredicate(): OutputPredicate {
  return { sql: '1', params: [] };
}

export function liveScannerLifetimePredicate(
  actor: ScanActor,
  scanner: ScannerRow,
  seen: number,
  staffSeen: number | null,
): OutputPredicate {
  return {
    sql: `EXISTS (SELECT 1 FROM scanners live_lifetime_scanner
      WHERE live_lifetime_scanner.id=?/* scan-ephemeral-scanner-id */
        AND live_lifetime_scanner.org_id=? AND live_lifetime_scanner.mode=?
        AND COALESCE(live_lifetime_scanner.last_seen_at,live_lifetime_scanner.paired_at)>=?
        ${actor.staff ? 'AND live_lifetime_scanner.staff_seen_at>=?' : ''})`,
    params: [scanner.id, actor.orgId, actor.mode, seen, ...(actor.staff ? [staffSeen] : [])],
  };
}

export function liveAdminFreshLifetimePredicate(
  authority: ScanTenantAuthority,
  now: number,
): OutputPredicate {
  return {
    sql: `EXISTS (SELECT 1 FROM sessions live_fresh_session
        WHERE live_fresh_session.id_hash=?/* scan-ephemeral-session-id-hash */
          AND live_fresh_session.user_id=? AND live_fresh_session.created_at=?
          AND live_fresh_session.expires_at=? AND live_fresh_session.revoked_at IS NULL
          AND live_fresh_session.expires_at>? AND live_fresh_session.idle_expires_at>?)`,
    params: [
      authority.sessionId,
      authority.userId,
      authority.sessionCreatedAt,
      authority.sessionExpiresAt,
      now,
      now,
    ],
  };
}

export function liveScannerFreshLifetimePredicate(
  actor: ScanActor,
  scanner: ScannerRow,
  now: number,
): OutputPredicate {
  // Credential and configuration changes are epoch comparisons; the actor carries the epochs read
  // with the rows it derived from (an actor the guard never captured is refused).
  const epochs = scanEpochsOf(actor)?.scanner;
  if (!epochs || epochs.id !== scanner.id) return { sql: '0', params: [] };
  return {
    sql: `EXISTS (SELECT 1 FROM scanners live_fresh_scanner
      WHERE live_fresh_scanner.id=?/* scan-ephemeral-scanner-id */
        AND live_fresh_scanner.org_id=? AND live_fresh_scanner.mode=?
        AND live_fresh_scanner.credential_epoch=? AND live_fresh_scanner.config_epoch=?
        AND live_fresh_scanner.token_hash IS NOT NULL
        AND live_fresh_scanner.revoked_at IS NULL
        AND (live_fresh_scanner.expires_at IS NULL OR live_fresh_scanner.expires_at>?)
        ${actor.terminal ? '' : `AND COALESCE(live_fresh_scanner.last_seen_at,live_fresh_scanner.paired_at,?)+?>?`}
        ${
          actor.staff
            ? `AND live_fresh_scanner.staff_id=?/* scan-ephemeral-staff-id */
          AND live_fresh_scanner.staff_since IS ? AND live_fresh_scanner.staff_seen_at>=?
          AND live_fresh_scanner.staff_since>=?`
            : ''
        })`,
    params: [
      scanner.id,
      actor.orgId,
      actor.mode,
      epochs.credential,
      epochs.config,
      now,
      ...(actor.terminal ? [] : [now, DEVICE_IDLE_MS, now]),
      ...(actor.staff
        ? [actor.staff.id, scanner.staffSince, now - STAFF_IDLE_MS, now - STAFF_MAX_MS]
        : []),
    ],
  };
}
