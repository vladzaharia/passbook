import type { SqlValue } from '../../platform/db.ts';
import type { ScanActor } from './actor.ts';
import { DEVICE_IDLE_MS } from './auth-store.ts';
import { usableScanTemplateSql } from './repo-scope-releases.ts';
import { scanConjunction } from './repo-secret-binds.ts';
import { STAFF_IDLE_MS, STAFF_MAX_MS } from './staff-binding.ts';

/*
 * Column-equality actor fences for actors that carry no captured epochs: sealed and restored
 * actors (live source proofs, undo and approval envelopes) and pairing actors, whose snapshots
 * predate epochs. Guard actors and their clones use the epoch comparisons in
 * repo-actor-scanner-authority.ts. Delete this file when WP6 and WP7 carry epochs in their
 * envelopes (docs/design/authority-epochs.md, section 7.2).
 */

const PROOF = /^[A-Za-z0-9_-]{43}$/;

/** Scanner, staff and session part of the original actor predicate. */
export function appendLegacyScannerAuthority(
  actor: ScanActor,
  scanner: NonNullable<ScanActor['scanner']>,
  now: number,
  templateId: string | undefined,
  parts: string[],
  params: SqlValue[],
): void {
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
        WHERE pinned.id=?/* scan-ephemeral-event-id */ AND pinned.org_id=? AND pinned.mode=? AND pinned.archived_at IS NULL
        AND (SELECT COUNT(*) FROM scan_event_templates et WHERE et.event_id=pinned.id) BETWEEN 1 AND 20
        AND NOT EXISTS (SELECT 1 FROM scan_event_templates et
          LEFT JOIN templates t ON t.id=et.template_id
            AND (t.org_id=pinned.org_id OR t.org_id IS NULL) AND t.status!='deleted'
          WHERE et.event_id=pinned.id AND (t.id IS NULL OR NOT ${usableScanTemplateSql({
            templateIdSql: 't.id',
            orgIdSql: 'pinned.org_id',
            modeSql: 'pinned.mode',
            providerSql: "'apple'",
          })})))`);
    params.push(scanner.eventId, actor.orgId, actor.mode);
  }
  const scannerParts = [
    's.device_role=?',
    's.id=?/* scan-ephemeral-scanner-id */',
    's.org_id=?',
    's.mode=?',
    's.kind=?',
    's.revoked_at IS NULL',
    's.updated_at=?',
    's.event_id IS ?/* scan-ephemeral-event-id */',
    's.settings=?/* scan-ephemeral-scanner-settings */',
    's.time_zone=?/* scan-ephemeral-scanner-time-zone */',
  ];
  params.push(
    scanner.deviceRole,
    scanner.id,
    actor.orgId,
    actor.mode,
    scanner.kind,
    scanner.updatedAt,
    scanner.eventId,
    scanner.settings,
    scanner.timeZone,
  );
  if (actor.principal === 'scanner') {
    if (
      actor.actor.type !== 'scanner' ||
      actor.actor.id !== scanner.id ||
      actor.actorKey !== `s:${scanner.id}` ||
      actor.terminal !== (scanner.kind === 'terminal')
    )
      parts.push('0');
    if (
      actor.terminal ? actor.scannerCsrfProof !== null : !PROOF.test(actor.scannerCsrfProof ?? '')
    )
      parts.push('0');
    scannerParts.push(
      's.token_hash IS ?/* scan-ephemeral-scanner-token-hash */',
      's.token_hash IS NOT NULL',
      's.token_prefix IS ?/* scan-ephemeral-scanner-token-prefix */',
      's.paired_at IS ?',
      's.expires_at IS ?',
      '(s.expires_at IS NULL OR s.expires_at>?)',
      "(s.kind='terminal' OR COALESCE(s.last_seen_at,s.paired_at,?)+?>?)",
    );
    params.push(
      scanner.tokenHash,
      scanner.tokenPrefix,
      scanner.pairedAt,
      scanner.expiresAt,
      now,
      now,
      DEVICE_IDLE_MS,
      now,
    );
    if (!actor.terminal) {
      const staffValid = `COALESCE(s.staff_seen_at>=?,0) AND COALESCE(s.staff_since>=?,0)
          AND EXISTS (SELECT 1 FROM scan_staff st WHERE st.id=s.staff_id AND st.org_id=s.org_id
          AND st.disabled_at IS NULL`;
      if (actor.staff) {
        scannerParts.push(
          's.staff_id=?',
          's.staff_since IS ?',
          `${staffValid} AND st.role=? AND st.updated_at=?)`,
        );
        params.push(
          actor.staff.id,
          scanner.staffSince,
          now - STAFF_IDLE_MS,
          now - STAFF_MAX_MS,
          actor.staff.role,
          actor.staff.updatedAt,
        );
      } else {
        scannerParts.push(`NOT (${staffValid}))`);
        params.push(now - STAFF_IDLE_MS, now - STAFF_MAX_MS);
      }
    }
  } else {
    scannerParts.push(`EXISTS (SELECT 1 FROM scanner_setups m WHERE m.scanner_id=s.id
        AND m.org_id=s.org_id AND m.admin_session=1 AND m.admin_user_id=?)`);
    params.push(actor.actor.id);
  }
  parts.push(`EXISTS (SELECT 1 FROM scanners s WHERE ${scanConjunction(scannerParts)})`);

  if (actor.scanningSession) {
    const bindEvent =
      !!actor.event || !!actor.settings.acceptAllTemplates || actor.templateIds.length > 0;
    const selectedTemplates = !actor.event && actor.templateIds.length > 0;
    const acceptedTemplate = !!templateId && selectedTemplates;
    const acceptAll =
      !!templateId &&
      !actor.event &&
      !actor.templateIds.length &&
      actor.settings.acceptAllTemplates === true;
    const effective = `json_remove(json_patch(CASE
        WHEN json_type(d.overrides,'$.checkIn') IS NOT NULL THEN json_remove(ss.settings,'$.checkIn')
        ELSE ss.settings END,d.overrides),'$.acceptAllTemplates')`;
    const expected = "json_remove(?/* scan-ephemeral-effective-settings */,'$.acceptAllTemplates')";
    const knownSettings = `fullkey='$' OR fullkey IN (
        '$.checkIn','$.direction','$.showPhoto','$.flow','$.defaultActionId',
        '$.roleWithoutSignIn','$.staffSignIn','$.letInAgain','$.reader','$.lookup',
        '$.offline','$.dailyAmount') OR fullkey GLOB '$.checkIn.*'`;
    const settings = JSON.stringify(actor.settings);
    parts.push(`EXISTS (SELECT 1 FROM scanning_devices d JOIN scanning_sessions ss
        ON ss.id=d.session_id AND ss.org_id=d.org_id AND ss.mode=d.mode
        WHERE d.scanner_id=?/* scan-ephemeral-scanner-id */ AND d.org_id=? AND d.mode=?
          AND ss.id=?/* scan-ephemeral-session-id */
        AND ss.status='active' AND ss.updated_at=?${bindEvent ? " AND json_extract(ss.accepts,'$.eventId') IS ?/* scan-ephemeral-event-id */" : ''}
        AND NOT EXISTS (SELECT fullkey,type,atom FROM json_tree(${effective}) WHERE ${knownSettings}
          EXCEPT SELECT fullkey,type,atom FROM json_tree(${expected}))
        AND NOT EXISTS (SELECT fullkey,type,atom FROM json_tree(${expected})
          EXCEPT SELECT fullkey,type,atom FROM json_tree(${effective}) WHERE ${knownSettings})
        ${actor.event ? `AND json_type(ss.accepts)='object' AND (SELECT COUNT(*) FROM json_each(ss.accepts))=1` : ''}
        ${
          selectedTemplates
            ? `AND json_type(ss.accepts)='object'
          AND (SELECT COUNT(*) FROM json_each(ss.accepts))=1
          AND json_type(ss.accepts,'$.templateIds')='array'
          AND (SELECT COUNT(*) FROM json_each(ss.accepts,'$.templateIds'))=?
          AND (SELECT COUNT(DISTINCT value) FROM json_each(ss.accepts,'$.templateIds') WHERE type='text')=?
          AND NOT EXISTS (SELECT 1 FROM json_each(ss.accepts,'$.templateIds') selected
            LEFT JOIN templates t ON t.id=selected.value
              AND (t.org_id=ss.org_id OR t.org_id IS NULL) AND t.status!='deleted'
            WHERE selected.type!='text' OR selected.value NOT IN (SELECT value FROM json_each(?/* scan-ephemeral-template-ids */))
              OR t.id IS NULL OR NOT ${usableScanTemplateSql({
                templateIdSql: 't.id',
                orgIdSql: 'ss.org_id',
                modeSql: 'ss.mode',
                providerSql: "'apple'",
              })})`
            : ''
        }
        ${acceptedTemplate ? "AND EXISTS (SELECT 1 FROM json_each(ss.accepts,'$.templateIds') t WHERE t.type='text' AND t.value=?/* scan-ephemeral-template-id */)" : ''}
        ${acceptAll ? "AND (ss.accepts IS NULL OR json_type(ss.accepts)='null') AND json_extract(ss.settings,'$.acceptAllTemplates')=1" : ''})`);
    params.push(
      scanner.id,
      actor.orgId,
      actor.mode,
      actor.scanningSession.id,
      actor.scanningSession.updatedAt,
      ...(bindEvent ? [actor.event?.id ?? null] : []),
      settings,
      settings,
      ...(selectedTemplates
        ? [actor.templateIds.length, actor.templateIds.length, JSON.stringify(actor.templateIds)]
        : []),
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
          AND NOT EXISTS (SELECT 1 FROM scanner_templates st
            JOIN scanners scoped_s ON scoped_s.id=st.scanner_id
            LEFT JOIN templates t ON t.id=st.template_id AND (t.org_id=? OR t.org_id IS NULL) AND t.status!='deleted'
            WHERE st.scanner_id=?/* scan-ephemeral-scanner-id */ AND (st.template_id NOT IN (SELECT value FROM json_each(?/* scan-ephemeral-template-ids */))
              OR t.id IS NULL OR NOT ${usableScanTemplateSql({
                templateIdSql: 't.id',
                orgIdSql: 'scoped_s.org_id',
                modeSql: 'scoped_s.mode',
                providerSql: "'apple'",
              })}))`);
      params.push(
        scanner.id,
        actor.templateIds.length,
        actor.orgId,
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
}
