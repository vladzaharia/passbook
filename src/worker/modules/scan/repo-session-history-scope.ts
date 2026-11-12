import { ScannerSettingsSchema } from '../../../shared/contracts/scan.ts';
import { ScannerAcceptsSchema } from '../../../shared/contracts/scanners.ts';
import type { SqlValue } from '../../platform/db.ts';
import type { ScanActor } from './actor.ts';
import {
  configurationScopeRowsPredicate,
  configurationScopeTemplatesPredicate,
} from './repo-scanner-configuration-scope.ts';
import type { ScanEventRow } from './repo-scope.ts';
import { observedScanningSession } from './scanning-workspace-observation.ts';

type HistoryEvent = Pick<ScanEventRow, 'id' | 'orgId' | 'mode' | 'updatedAt' | 'archivedAt'>;

/** Retain the exact observed event set for the minimal history fence. */
export function appendCapturedHistoryEvents(
  actor: ScanActor,
  scan: string,
  events: readonly HistoryEvent[],
  parts: string[],
  params: SqlValue[],
): boolean {
  if (
    new Set(events.map((event) => event.id)).size !== events.length ||
    events.some(
      (event) =>
        event.orgId !== actor.orgId ||
        event.mode !== actor.mode ||
        event.archivedAt !== null ||
        !Number.isSafeInteger(event.updatedAt),
    )
  )
    return false;
  parts.push(`(${scan}.event_id IS NULL OR EXISTS (
    SELECT 1 FROM scan_events observed_event JOIN json_each(?/* scan-ephemeral-event-scope */) captured
      ON observed_event.id=json_extract(captured.value,'$.id')
    WHERE observed_event.id=${scan}.event_id AND observed_event.org_id=? AND observed_event.mode=?
      AND observed_event.archived_at IS NULL
      AND observed_event.updated_at=json_extract(captured.value,'$.updatedAt')))`);
  params.push(
    JSON.stringify(events.map(({ id, updatedAt }) => ({ id, updatedAt }))),
    actor.orgId,
    actor.mode,
  );
  return true;
}

/** Retain the observed session scope without widening a scanner assignment. */
export function appendSessionHistoryScope(
  actor: ScanActor,
  assignment: NonNullable<ScanActor['scannerAssignment']>,
  scan: string,
  parts: string[],
  params: SqlValue[],
): boolean {
  const observed = observedScanningSession(actor);
  if (!observed?.scope) return false;
  try {
    const ids: unknown = JSON.parse(observed.scope.templateIds);
    const rows: unknown = JSON.parse(observed.scope.templateRows);
    if (
      !Array.isArray(ids) ||
      !Array.isArray(rows) ||
      ids.length !== rows.length ||
      rows.some(
        (row, index) =>
          !Array.isArray(row) ||
          row.length !== 4 ||
          typeof ids[index] !== 'string' ||
          row[0] !== ids[index] ||
          row[1] !== ids[index] ||
          (row[2] !== null && row[2] !== actor.orgId) ||
          (row[3] !== 'active' && row[3] !== 'archived'),
      )
    )
      return false;
  } catch {
    return false;
  }
  const structural = configurationScopeTemplatesPredicate(observed.scope, actor.orgId, actor.mode);
  parts.push(`(${structural.sql})`);
  params.push(...structural.params);
  const captured = configurationScopeRowsPredicate(observed.scope, actor.orgId, actor.mode);
  parts.push(`(${captured.sql})`);
  params.push(...captured.params);
  let raw: unknown = null;
  try {
    if (observed.parent.accepts !== null) raw = JSON.parse(observed.parent.accepts);
  } catch {
    return false;
  }
  if (observed.parent.accepts !== null) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw) || Object.keys(raw).length !== 1)
      return false;
    const accepted = ScannerAcceptsSchema.safeParse(raw);
    if (!accepted.success) return false;
    if ('eventId' in accepted.data) {
      parts.push(
        `${scan}.event_id IS ?/* scan-ephemeral-event-id */`,
        `(${scan}.template_id IS NULL OR EXISTS (SELECT 1 FROM scan_event_templates et
            WHERE et.event_id=?/* scan-ephemeral-event-id */ AND et.template_id=${scan}.template_id))`,
        `(SELECT COUNT(*) FROM scan_event_templates et WHERE et.event_id=?/* scan-ephemeral-event-id */) BETWEEN 1 AND 20`,
        `NOT EXISTS (SELECT 1 FROM scan_event_templates et LEFT JOIN templates t
            ON t.id=et.template_id AND (t.org_id=? OR t.org_id IS NULL) AND t.status!='deleted'
            WHERE et.event_id=?/* scan-ephemeral-event-id */ AND t.id IS NULL)`,
      );
      params.push(
        accepted.data.eventId,
        accepted.data.eventId,
        accepted.data.eventId,
        actor.orgId,
        accepted.data.eventId,
      );
    } else {
      const acceptedIds = JSON.stringify([...new Set(accepted.data.templateIds)]);
      parts.push(
        `(${scan}.template_id IS NULL OR ${scan}.template_id IN (SELECT value FROM json_each(?/* scan-ephemeral-template-ids */)))`,
        `NOT EXISTS (SELECT 1 FROM json_each(?/* scan-ephemeral-template-ids */) wanted LEFT JOIN templates t
            ON t.id=wanted.value AND (t.org_id=? OR t.org_id IS NULL) AND t.status!='deleted'
            WHERE t.id IS NULL)`,
      );
      params.push(acceptedIds, acceptedIds, actor.orgId);
    }
  } else {
    let acceptsAll = false;
    try {
      const settings = ScannerSettingsSchema.safeParse(JSON.parse(observed.parent.settings));
      if (!settings.success) return false;
      acceptsAll = settings.data.acceptAllTemplates === true;
    } catch {
      return false;
    }
    if (acceptsAll) {
      // A session-wide grant cannot erase a pre-existing scanner restriction.
      if (assignment.eventId !== null || assignment.templateIds.length !== 0) return false;
    } else {
      parts.push(`${scan}.template_id IS NULL`, `${scan}.event_id IS NULL`);
    }
  }
  return true;
}
