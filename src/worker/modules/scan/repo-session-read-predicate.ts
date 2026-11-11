import type { SqlValue } from '../../platform/db.ts';
import { tenantPassAuthorityParams, tenantPassAuthoritySql } from '../passes/repo-authority.ts';
import { type ScanActor, tenantScanRole } from './actor.ts';
import { DEVICE_IDLE_MS } from './auth-store.ts';
import { scanConjunction } from './repo-secret-binds.ts';
import { appendSessionReadEventPredicate } from './repo-session-read-event.ts';
import { ROLE_RANK } from './rules.ts';
import { scanEpochsOf } from './scan-epochs.ts';
import { observedScanningSession } from './scanning-workspace-observation.ts';
import { STAFF_IDLE_MS, STAFF_MAX_MS } from './staff-binding.ts';

type Predicate = { sql: string; params: SqlValue[] };
const denied = (): Predicate => ({ sql: '0', params: [] });

/**
 * Authority for the session DTO only. Unlike the pass/action fence, this allows
 * an unchanged paused session, a staff sign-in screen, and a redacted invalid
 * scope. It must never be used to authorize a pass read or an operation.
 *
 * All parameters come from the original guard actor and its captured workspace,
 * not from a row reloaded while the DTO was being built.
 */
export function readAuthorityPredicate(
  actor: ScanActor,
  now: number,
  scopeRedacted: boolean,
): Predicate {
  const parts = ["EXISTS (SELECT 1 FROM orgs o WHERE o.id=? AND o.status='active')"];
  const params: SqlValue[] = [actor.orgId];
  const scanner = actor.scanner;
  const binding = actor.scanningSession;

  if (new Set(actor.templateIds).size !== actor.templateIds.length) return denied();
  if (
    actor.invalidScannerScope &&
    (actor.event !== null ||
      actor.templateIds.length !== 0 ||
      actor.settings.acceptAllTemplates === true)
  )
    return denied();

  if (actor.principal === 'admin') {
    const authority = actor.tenantAuthority;
    const allowed = authority?.kind === 'session' ? tenantScanRole(authority) : null;
    if (
      authority?.kind !== 'session' ||
      authority.orgId !== actor.orgId ||
      authority.mode !== actor.mode ||
      authority.userId !== actor.actor.id ||
      actor.actor.type !== 'user' ||
      authority.sessionId !== actor.platformSessionId ||
      typeof authority.sessionCsrfProof !== 'string' ||
      !/^[A-Za-z0-9_-]{43}$/.test(authority.sessionCsrfProof) ||
      !Number.isSafeInteger(authority.sessionCreatedAt) ||
      !Number.isSafeInteger(authority.sessionExpiresAt) ||
      authority.sessionExpiresAt <= authority.sessionCreatedAt ||
      !allowed ||
      actor.role === null ||
      !Object.hasOwn(ROLE_RANK, actor.role) ||
      ROLE_RANK[actor.role] > ROLE_RANK[allowed] ||
      (authority.capability !== 'scanning:read' &&
        authority.capability !== 'scanning:manage' &&
        authority.capability !== 'passes:operate')
    )
      return denied();
    parts.push(`(${tenantPassAuthoritySql(authority)})`);
    params.push(...tenantPassAuthorityParams(authority, now));
    parts.push(`EXISTS (SELECT 1 FROM sessions captured_session
      WHERE captured_session.id_hash=?/* scan-ephemeral-session-id-hash */ AND captured_session.user_id=?
        AND captured_session.created_at=? AND captured_session.expires_at=?)`);
    params.push(
      authority.sessionId,
      authority.userId,
      authority.sessionCreatedAt,
      authority.sessionExpiresAt,
    );
  } else if (
    !scanner ||
    actor.actor.type !== 'scanner' ||
    actor.actor.id !== scanner.id ||
    actor.actorKey !== `s:${scanner.id}` ||
    actor.terminal !== (scanner.kind === 'terminal')
  ) {
    return denied();
  } else {
    const role = actor.terminal
      ? actor.settings.roleWithoutSignIn
      : actor.settings.staffSignIn
        ? (actor.staff?.role ?? null)
        : actor.settings.roleWithoutSignIn;
    if (
      actor.role !== role ||
      (actor.staff !== null && (actor.terminal || !actor.settings.staffSignIn))
    )
      return denied();
  }

  if (scanner) {
    if (scanner.orgId !== actor.orgId || scanner.mode !== actor.mode || scanner.revokedAt !== null)
      return denied();
    if (
      actor.principal === 'admin' &&
      (actor.scannerCsrfProof === undefined ||
        (actor.scannerCsrfProof !== null &&
          (typeof actor.scannerCsrfProof !== 'string' ||
            !/^[A-Za-z0-9_-]{43}$/.test(actor.scannerCsrfProof))))
    )
      return denied();
    // Credential, configuration and staff changes are epoch comparisons; the epochs were read with
    // the rows the actor derived from. An actor the guard never captured is refused.
    const epochs = scanEpochsOf(actor);
    const captured = epochs?.scanner;
    if (!captured || captured.id !== scanner.id) return denied();
    const scannerParts = [
      's.id=?/* scan-ephemeral-scanner-id */',
      's.org_id=?',
      's.mode=?',
      's.revoked_at IS NULL',
      's.config_epoch=?',
      's.credential_epoch=?',
    ];
    params.push(scanner.id, actor.orgId, actor.mode, captured.config, captured.credential);
    if (actor.principal === 'scanner') {
      if (
        !scanner.tokenHash ||
        !scanner.tokenPrefix ||
        (!actor.terminal &&
          (typeof actor.scannerCsrfProof !== 'string' ||
            !/^[A-Za-z0-9_-]{43}$/.test(actor.scannerCsrfProof)))
      )
        return denied();
      scannerParts.push(
        's.token_hash IS NOT NULL',
        '(s.expires_at IS NULL OR s.expires_at>?)',
        "(s.kind='terminal' OR COALESCE(s.last_seen_at,s.paired_at,?)+?>?)",
      );
      params.push(now, now, DEVICE_IDLE_MS, now);
      if (actor.staff) {
        if (
          scanner.staffId !== actor.staff.id ||
          scanner.staffSince === null ||
          epochs?.staff?.id !== actor.staff.id
        )
          return denied();
        scannerParts.push(`s.staff_id=?/* scan-ephemeral-staff-id */ AND s.staff_since IS ?
          AND COALESCE(s.staff_seen_at>=?,0) AND COALESCE(s.staff_since>=?,0)
          AND EXISTS (SELECT 1 FROM scan_staff st WHERE st.id=s.staff_id AND st.org_id=s.org_id
            AND st.disabled_at IS NULL AND st.auth_epoch=?)`);
        params.push(
          actor.staff.id,
          scanner.staffSince,
          now - STAFF_IDLE_MS,
          now - STAFF_MAX_MS,
          epochs.staff.auth,
        );
      } else if (scanner.staffId === null) {
        scannerParts.push('s.staff_id IS NULL', 's.staff_since IS ?');
        params.push(scanner.staffSince);
      } else if (actor.terminal && actor.settings.staffSignIn) {
        // Terminals ignore staff; the guard does not clear this binding in this case.
        scannerParts.push('s.staff_id IS ?/* scan-ephemeral-staff-id */', 's.staff_since IS ?');
        params.push(scanner.staffId, scanner.staffSince);
      } else {
        // The guard clears expired, disabled, or unwanted staff using this snapshot.
        // Accept that deliberate unbind, but never a replacement binding.
        scannerParts.push('s.staff_id IS NULL', 's.staff_since IS NULL');
      }
    } else {
      scannerParts.push(`EXISTS (SELECT 1 FROM scanner_setups m WHERE m.scanner_id=s.id
        AND m.org_id=s.org_id AND m.admin_session=1 AND m.admin_user_id=?)`);
      params.push(actor.actor.id);
    }
    parts.push(`EXISTS (SELECT 1 FROM scanners s WHERE ${scanConjunction(scannerParts)})`);

    if (binding) {
      const observed = observedScanningSession(actor);
      const parent = observed?.parent;
      const device = observed?.device;
      const scope = observed?.scope;
      if (
        !parent ||
        !device ||
        !scope ||
        parent.id !== binding.id ||
        parent.status !== binding.status ||
        parent.updated_at !== binding.updatedAt ||
        parent.org_id !== actor.orgId ||
        parent.mode !== actor.mode ||
        device.scanner_id !== scanner.id ||
        device.session_id !== parent.id ||
        device.org_id !== actor.orgId ||
        device.mode !== actor.mode ||
        device.updated_at !== scanner.updatedAt ||
        device.name !== scanner.name ||
        device.kind !== scanner.kind ||
        device.settings !== scanner.settings ||
        device.token_hash !== scanner.tokenHash ||
        scope.scannerId !== scanner.id ||
        scope.orgId !== actor.orgId ||
        scope.mode !== actor.mode
      )
        return denied();
      // Accepts, settings, name, time zone and the device's surface and overrides all move a config
      // epoch (the scanner's above, the session's here), so the scope is not compared column by column.
      const sessionEpoch = epochs?.session;
      if (!sessionEpoch || sessionEpoch.id !== parent.id) return denied();
      const sessionParts = [
        'd.scanner_id=?/* scan-ephemeral-scanner-id */',
        'd.session_id=?/* scan-ephemeral-session-id */',
        'd.org_id=?',
        'd.mode=?',
        'p.id=?/* scan-ephemeral-session-id */',
        'p.org_id=?',
        'p.mode=?',
        'p.status=?',
        'p.config_epoch=?',
      ];
      params.push(
        device.scanner_id,
        device.session_id,
        device.org_id,
        device.mode,
        parent.id,
        parent.org_id,
        parent.mode,
        parent.status,
        sessionEpoch.config,
      );
      parts.push(`EXISTS (SELECT 1 FROM scanning_devices d JOIN scanning_sessions p
        ON p.id=d.session_id AND p.org_id=d.org_id AND p.mode=d.mode
        WHERE ${scanConjunction(sessionParts)})`);
    } else {
      parts.push(
        'NOT EXISTS (SELECT 1 FROM scanning_devices d WHERE d.scanner_id=?/* scan-ephemeral-scanner-id */)',
      );
      params.push(scanner.id);
      if (!actor.invalidScannerScope && !scopeRedacted) {
        if (scanner.eventId !== null && actor.event?.id !== scanner.eventId) return denied();
        if (!actor.event) {
          parts.push(`(SELECT json_group_array(template_id) FROM
            (SELECT template_id FROM scanner_templates WHERE scanner_id=?/* scan-ephemeral-scanner-id */ ORDER BY template_id))=?/* scan-ephemeral-template-ids */`);
          params.push(scanner.id, JSON.stringify([...actor.templateIds].sort()));
        }
      }
    }
  } else if (binding) {
    return denied();
  }

  if (!appendSessionReadEventPredicate(actor, scanner, scopeRedacted, parts, params))
    return denied();
  return { sql: parts.join(' AND '), params };
}
