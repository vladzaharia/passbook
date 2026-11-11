import type { SqlValue } from '../../platform/db.ts';
import type { ScanActor } from './actor.ts';
import { DEVICE_IDLE_MS } from './auth-store.ts';
import { appendEventTemplateProofs } from './repo-actor-event-authority.ts';
import { appendLegacyScannerAuthority } from './repo-actor-legacy-authority.ts';
import { scanConjunction } from './repo-secret-binds.ts';
import { scanEpochsOf } from './scan-epochs.ts';
import { STAFF_IDLE_MS, STAFF_MAX_MS } from './staff-binding.ts';

export const CSRF_PROOF = /^[A-Za-z0-9_-]{43}$/;

/** Append scanner and session authority in the same predicate and parameter order. */
export function appendScannerAuthority(
  actor: ScanActor,
  scanner: ScanActor['scanner'],
  now: number,
  templateId: string | undefined,
  parts: string[],
  params: SqlValue[],
): void {
  if (scanner) {
    const captured = scanEpochsOf(actor);
    if (!captured) {
      appendLegacyScannerAuthority(actor, scanner, now, templateId, parts, params);
      return;
    }
    // An unassigned scanner or session-backed screen cannot read arbitrary templates.
    // A standalone monitor may instead follow a separately validated watched source.
    if (
      templateId &&
      actor.templateIds.length === 0 &&
      actor.settings.acceptAllTemplates !== true &&
      (scanner.deviceRole === 'scan' || (actor.scanningSession && !actor.event))
    )
      parts.push('0');
    if (scanner.eventId && !actor.scanningSession && !actor.event) parts.push('0');
    if (scanner.eventId && actor.event?.id !== scanner.eventId) {
      parts.push(`EXISTS (SELECT 1 FROM scan_events pinned
        WHERE pinned.id=?/* scan-ephemeral-event-id */ AND pinned.org_id=? AND pinned.mode=? AND pinned.archived_at IS NULL)`);
      params.push(scanner.eventId, actor.orgId, actor.mode);
      if (!templateId)
        appendEventTemplateProofs(scanner.eventId, actor.orgId, actor.mode, parts, params);
    }
    // Credential, config and staff changes are epoch comparisons; the epochs were captured with the
    // rows the actor derived from (guard.ts), so a mismatch means the actor is stale.
    const epochs = captured.scanner;
    if (!epochs || epochs.id !== scanner.id) parts.push('0');
    const scannerParts = [
      's.id=?/* scan-ephemeral-scanner-id */',
      's.org_id=?',
      's.mode=?',
      's.revoked_at IS NULL',
      's.config_epoch=?',
    ];
    params.push(scanner.id, actor.orgId, actor.mode, epochs?.config ?? null);
    if (actor.principal === 'scanner') {
      if (
        actor.actor.type !== 'scanner' ||
        actor.actor.id !== scanner.id ||
        actor.actorKey !== `s:${scanner.id}` ||
        actor.terminal !== (scanner.kind === 'terminal')
      )
        parts.push('0');
      if (
        actor.terminal
          ? actor.scannerCsrfProof !== null
          : !CSRF_PROOF.test(actor.scannerCsrfProof ?? '')
      )
        parts.push('0');
      if (epochs?.credential === null || epochs?.credential === undefined) parts.push('0');
      scannerParts.push(
        's.credential_epoch=?',
        's.token_hash IS NOT NULL',
        '(s.expires_at IS NULL OR s.expires_at>?)',
        "(s.kind='terminal' OR COALESCE(s.last_seen_at,s.paired_at,?)+?>?)",
      );
      params.push(epochs?.credential ?? null, now, now, DEVICE_IDLE_MS, now);
      if (!actor.terminal) {
        const staffValid = `COALESCE(s.staff_seen_at>=?,0) AND COALESCE(s.staff_since>=?,0)
          AND EXISTS (SELECT 1 FROM scan_staff st WHERE st.id=s.staff_id AND st.org_id=s.org_id
          AND st.disabled_at IS NULL`;
        if (actor.staff) {
          const staffEpoch = captured.staff;
          if (staffEpoch?.id !== actor.staff.id) parts.push('0');
          scannerParts.push('s.staff_id=?', `${staffValid} AND st.auth_epoch=?)`);
          params.push(
            actor.staff.id,
            now - STAFF_IDLE_MS,
            now - STAFF_MAX_MS,
            staffEpoch?.auth ?? null,
          );
        } else {
          scannerParts.push(`NOT (${staffValid}))`);
          params.push(now - STAFF_IDLE_MS, now - STAFF_MAX_MS);
        }
      }
    } else {
      scannerParts.push('s.credential_epoch=?');
      params.push(epochs?.credential ?? null);
      scannerParts.push(`EXISTS (SELECT 1 FROM scanner_setups m WHERE m.scanner_id=s.id
        AND m.org_id=s.org_id AND m.admin_session=1 AND m.admin_user_id=?)`);
      params.push(actor.actor.id);
    }
    parts.push(`EXISTS (SELECT 1 FROM scanners s WHERE ${scanConjunction(scannerParts)})`);

    if (actor.scanningSession) {
      // The session's accepts, settings and the device overrides move config epochs, so only the
      // scanned template's membership is evaluated here, not every configured template.
      const selectedTemplates = !actor.event && actor.templateIds.length > 0;
      const acceptedTemplate = !!templateId && selectedTemplates;
      const acceptAll =
        !!templateId &&
        !actor.event &&
        !actor.templateIds.length &&
        actor.settings.acceptAllTemplates === true;
      const sessionEpoch = captured.session;
      if (sessionEpoch?.id !== actor.scanningSession.id) parts.push('0');
      parts.push(`EXISTS (SELECT 1 FROM scanning_devices d JOIN scanning_sessions ss
        ON ss.id=d.session_id AND ss.org_id=d.org_id AND ss.mode=d.mode
        WHERE d.scanner_id=?/* scan-ephemeral-scanner-id */ AND d.org_id=? AND d.mode=?
          AND ss.id=?/* scan-ephemeral-session-id */
        AND ss.status='active' AND ss.config_epoch=?
        ${acceptedTemplate ? "AND EXISTS (SELECT 1 FROM json_each(ss.accepts,'$.templateIds') t WHERE t.type='text' AND t.value=?/* scan-ephemeral-template-id */)" : ''}
        ${acceptAll ? "AND (ss.accepts IS NULL OR json_type(ss.accepts)='null') AND json_extract(ss.settings,'$.acceptAllTemplates')=1" : ''})`);
      params.push(
        scanner.id,
        actor.orgId,
        actor.mode,
        actor.scanningSession.id,
        sessionEpoch?.config ?? null,
        ...(acceptedTemplate ? [templateId] : []),
      );
    } else {
      parts.push(
        'NOT EXISTS (SELECT 1 FROM scanning_devices d WHERE d.scanner_id=?/* scan-ephemeral-scanner-id */)',
      );
      params.push(scanner.id);
    }

    if (!actor.scanningSession && !actor.event) {
      if (actor.templateIds.length) {
        parts.push(`(SELECT COUNT(*) FROM scanner_templates st WHERE st.scanner_id=?/* scan-ephemeral-scanner-id */)=?
          AND NOT EXISTS (SELECT 1 FROM scanner_templates st WHERE st.scanner_id=?/* scan-ephemeral-scanner-id */
            AND st.template_id NOT IN (SELECT value FROM json_each(?/* scan-ephemeral-template-ids */)))`);
        params.push(
          scanner.id,
          actor.templateIds.length,
          scanner.id,
          JSON.stringify(actor.templateIds),
        );
      } else {
        parts.push(
          'NOT EXISTS (SELECT 1 FROM scanner_templates st WHERE st.scanner_id=?/* scan-ephemeral-scanner-id */)',
        );
        params.push(scanner.id);
      }
    }
  } else if (actor.principal !== 'admin') {
    parts.push('0');
  }
}
