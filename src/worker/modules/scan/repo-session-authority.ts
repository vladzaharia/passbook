import { ScannerSettingsSchema } from '../../../shared/contracts/scan.ts';
import { first, type SqlValue, stmt } from '../../platform/db.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { credentialRefKeysetSql } from '../passes/repo-credential-keyset.ts';
import type { ScanActor } from './actor.ts';
import type { ScanEventRow } from './repo-scope.ts';
import {
  type SessionLegacyStamp,
  type SessionReleaseStamp,
  sessionTemplateStampsPredicate,
} from './repo-scope-releases.ts';
import { packScanPredicate } from './repo-secret-binds.ts';
import {
  appendCapturedHistoryEvents,
  appendSessionHistoryScope,
} from './repo-session-history-scope.ts';
import { readAuthorityPredicate } from './repo-session-read-predicate.ts';
import { observedScanningSession } from './scanning-workspace-observation.ts';

type Predicate = { sql: string; params: SqlValue[] };
const denied = (): Predicate => ({ sql: '0', params: [] });

/** Pack generated actor/assignment metadata while keeping labeled values as scalar binds. */
export function packedScanAuthorityPredicate(actor: ScanActor, predicate: Predicate): Predicate {
  if (predicate.sql === '0' && predicate.params.length === 0) return predicate;
  if (
    actor.principal === 'scanner' &&
    !actor.terminal &&
    (typeof actor.scannerCsrfProof !== 'string' ||
      !/^[A-Za-z0-9_-]{43}$/.test(actor.scannerCsrfProof))
  )
    return denied();
  if (
    actor.principal === 'admin' &&
    (typeof actor.tenantAuthority?.sessionCsrfProof !== 'string' ||
      !/^[A-Za-z0-9_-]{43}$/.test(actor.tenantAuthority.sessionCsrfProof))
  )
    return denied();
  let alias = 'scan_authority_snapshot';
  let suffix = 0;
  while (predicate.sql.includes(alias)) alias = `scan_authority_snapshot_${++suffix}`;
  return packScanPredicate(predicate.sql, predicate.params, alias) ?? denied();
}

export function sessionReadAuthorityPredicate(actor: ScanActor, now: number): Predicate {
  return readAuthorityPredicate(actor, now, false);
}

export async function sessionReadAuthorityCurrent(
  ctx: ServiceContext,
  actor: ScanActor,
  now: number,
): Promise<boolean> {
  const predicate = packedScanAuthorityPredicate(
    actor,
    sessionReadAuthorityPredicate(actor, Math.max(now, ctx.clock.now())),
  );
  const row = await first<{ current: number }>(
    ctx.env.DB,
    `SELECT (${predicate.sql}) AS current`,
    predicate.params,
  );
  return row?.current === 1;
}

/**
 * Observe DTO release stamps and actor authority in one D1 transaction snapshot.
 * scopeRedacted is only for a DTO that omits all event and template scope data.
 */
export async function sessionReadFencesCurrent(
  ctx: ServiceContext,
  actor: ScanActor,
  now: number,
  releases: readonly SessionReleaseStamp[],
  legacy: readonly SessionLegacyStamp[],
  options?: { scopeRedacted: boolean; credentialKeysetCommitment?: string },
): Promise<{ authorityCurrent: boolean; stampsCurrent: boolean }> {
  const keyset = options?.credentialKeysetCommitment;
  if (keyset !== undefined && !/^[a-f0-9]{64}$/.test(keyset))
    return { authorityCurrent: false, stampsCurrent: false };
  const redacted = options?.scopeRedacted === true;
  const authority = readAuthorityPredicate(actor, Math.max(now, ctx.clock.now()), redacted);
  const stampIds = new Set<string>();
  for (const stamp of releases) stampIds.add(stamp.templateId);
  for (const stamp of legacy) stampIds.add(stamp.templateId);
  const stampCount = releases.length + legacy.length;
  const complete = redacted
    ? stampCount === 0
    : stampCount === actor.templateIds.length &&
      stampIds.size === stampCount &&
      actor.templateIds.every((id) => stampIds.has(id));
  const stamps = complete
    ? sessionTemplateStampsPredicate(releases, legacy, 'scope.org_id', 'scope.mode')
    : denied();
  const scope =
    !redacted && !actor.invalidScannerScope && actor.scanningSession
      ? observedScanningSession(actor)?.scope
      : null;
  const additional =
    scope?.stamps.map((stamp) =>
      sessionTemplateStampsPredicate(stamp.releases, stamp.legacy, 'scope.org_id', 'scope.mode'),
    ) ?? [];
  const packedAuthority = packedScanAuthorityPredicate(actor, authority);
  const db = ctx.env.DB;
  const statements = [
    stmt(
      db,
      `SELECT ((${packedAuthority.sql})${keyset === undefined ? '' : ` AND (${credentialRefKeysetSql})`}) AS authority_current`,
      [...packedAuthority.params, ...(keyset === undefined ? [] : [keyset])],
    ),
    ...[stamps, ...additional].map((predicate) =>
      stmt(
        db,
        `SELECT (${predicate.sql}) AS stamps_current FROM (SELECT ? AS org_id, ? AS mode) scope`,
        [...predicate.params, actor.orgId, actor.mode],
      ),
    ),
  ];
  // Each stamp predicate is a separate statement: nesting the release head in a
  // packed stamp EXISTS exceeds D1's expression-depth limit. D1 batches execute
  // in one transaction, so these observations cannot straddle a concurrent
  // scope or authority change.
  const results = await db.batch<{ authority_current?: unknown; stamps_current?: unknown }>(
    statements,
  );
  if (results.length !== statements.length)
    return { authorityCurrent: false, stampsCurrent: false };
  let authorityCurrent = false;
  let stampsCurrent = true;
  for (let index = 0; index < statements.length; index++) {
    const result = results[index];
    if (result?.success !== true || !Array.isArray(result.results) || result.results.length !== 1)
      return { authorityCurrent: false, stampsCurrent: false };
    const value =
      index === 0 ? result.results[0]?.authority_current : result.results[0]?.stamps_current;
    if (value !== 0 && value !== 1) return { authorityCurrent: false, stampsCurrent: false };
    if (index === 0) authorityCurrent = value === 1;
    else if (value === 0) stampsCurrent = false;
  }
  return { authorityCurrent, stampsCurrent };
}

export type HistoryEventSnapshot = Pick<
  ScanEventRow,
  'id' | 'orgId' | 'mode' | 'updatedAt' | 'archivedAt'
>;

export interface MinimalHistoryAuthority {
  /** Trusted SQL identifiers; the caller separately proves the original ledger entry. */
  scanAlias: string;
  ledgerAlias?: string;
  /** Current event rows observed in a bounded read before the final fenced SELECT. */
  events: readonly HistoryEventSnapshot[];
}

/**
 * Credential and exact assignment authority for a minimal receipt/history row only.
 * This is not pass authority and must not authorize pass data, an operation, or a
 * mutation. Callers must independently verify the original scan's ledger proof.
 */
export function minimalHistoryAuthorityPredicate(
  actor: ScanActor,
  now: number,
  input: MinimalHistoryAuthority,
): Predicate {
  const identifier = /^[A-Za-z_][A-Za-z0-9_]*$/;
  if (
    !identifier.test(input.scanAlias) ||
    (input.ledgerAlias !== undefined && !identifier.test(input.ledgerAlias)) ||
    actor.role === null ||
    (actor.scanner && actor.scanner.deviceRole !== 'scan')
  )
    return denied();
  const scan = input.scanAlias;
  const base = readAuthorityPredicate(actor, now, true);
  const parts = [
    `(${base.sql})`,
    `${scan}.org_id=?`,
    `${scan}.mode=?`,
    `${scan}.actor_key=?/* scan-ephemeral-actor-key */`,
    `${scan}.actor_type=?`,
    `${scan}.actor_id=?/* scan-ephemeral-actor-id */`,
    `${scan}.scanner_id IS ?/* scan-ephemeral-scanner-id */`,
  ];
  const params: SqlValue[] = [
    ...base.params,
    actor.orgId,
    actor.mode,
    actor.actorKey,
    actor.actor.type,
    actor.actor.id,
    actor.scanner?.id ?? null,
  ];

  if (input.ledgerAlias) {
    const ledger = input.ledgerAlias;
    parts.push(`((${scan}.pass_id IS NULL AND ${scan}.template_id IS NULL AND ${ledger}.id IS NULL)
      OR (${ledger}.id IS NOT NULL AND ${ledger}.org_id=${scan}.org_id AND ${ledger}.mode=${scan}.mode
        AND ${ledger}.pass_id=${scan}.pass_id AND json_extract(${ledger}.data,'$.scanId')=${scan}.id
        AND json_extract(${ledger}.data,'$.eventId') IS ${scan}.event_id
        AND json_extract(${ledger}.data,'$.authority.eventId') IS ${scan}.event_id
        AND json_extract(${ledger}.data,'$.authority.templateId') IS ${scan}.template_id
        AND json_extract(${ledger}.data,'$.authority.sessionId') IS ?/* scan-ephemeral-session-id */))`);
    params.push(actor.scanningSession?.id ?? null);
  }

  if (!appendCapturedHistoryEvents(actor, scan, input.events, parts, params)) return denied();

  const scanner = actor.scanner;
  if (!scanner) {
    if (actor.principal !== 'admin') return denied();
    if (actor.event) {
      const event = actor.event;
      if (event.orgId !== actor.orgId || event.mode !== actor.mode || event.archivedAt !== null)
        return denied();
      parts.push(
        `${scan}.event_id IS ?/* scan-ephemeral-event-id */`,
        `EXISTS (SELECT 1 FROM scan_events assigned_event
        WHERE assigned_event.id=?/* scan-ephemeral-event-id */ AND assigned_event.org_id=? AND assigned_event.mode=?
          AND assigned_event.archived_at IS NULL)`,
      );
      params.push(event.id, event.id, actor.orgId, actor.mode);
      if (actor.adminEventTemplates) {
        parts.push(`(SELECT json_group_array(template_id) FROM
          (SELECT template_id FROM scan_event_templates WHERE event_id=?/* scan-ephemeral-event-id */ ORDER BY template_id))=?/* scan-ephemeral-template-ids */`);
        params.push(event.id, JSON.stringify([...actor.templateIds].sort()));
      }
    }
    if (actor.templateIds.length) {
      parts.push(
        `(${scan}.template_id IS NULL OR ${scan}.template_id IN (SELECT value FROM json_each(?/* scan-ephemeral-template-ids */)))`,
      );
      params.push(JSON.stringify(actor.templateIds));
    }
    return { sql: parts.join(' AND '), params };
  }

  const assignment = actor.scannerAssignment;
  if (
    !assignment?.structurallyValid ||
    assignment.scannerId !== scanner.id ||
    assignment.orgId !== actor.orgId ||
    assignment.mode !== actor.mode ||
    assignment.eventId !== scanner.eventId
  )
    return denied();
  const assignedIds = JSON.stringify([...assignment.templateIds].sort());
  if (assignment.eventId !== null) {
    const event = assignment.event;
    if (
      !event ||
      event.id !== assignment.eventId ||
      event.orgId !== actor.orgId ||
      event.mode !== actor.mode ||
      event.archivedAt !== null
    )
      return denied();
    parts.push(`EXISTS (SELECT 1 FROM scan_events assigned_event
      WHERE assigned_event.id=?/* scan-ephemeral-event-id */ AND assigned_event.org_id=? AND assigned_event.mode=?
        AND assigned_event.archived_at IS NULL
        AND assigned_event.name=?/* scan-ephemeral-event-name */
        AND assigned_event.match_input IS ?/* scan-ephemeral-event-match-input */
        AND assigned_event.match_values IS ?/* scan-ephemeral-event-match-values */
        AND assigned_event.opens_at=? AND assigned_event.closes_at=?
        AND assigned_event.time_zone=?/* scan-ephemeral-event-time-zone */
        AND assigned_event.capacity IS ? AND assigned_event.reentry=?
        AND assigned_event.note IS ?/* scan-ephemeral-event-note */)
      AND (SELECT json_group_array(json_array(template_id,scoped_template_id,scoped_org_id,scoped_status))
        FROM (SELECT et.template_id,t.id AS scoped_template_id,t.org_id AS scoped_org_id,t.status AS scoped_status
          FROM scan_event_templates et LEFT JOIN templates t
            ON t.id=et.template_id AND (t.org_id=? OR t.org_id IS NULL) AND t.status!='deleted'
          WHERE et.event_id=?/* scan-ephemeral-event-id */ ORDER BY et.template_id))=?/* scan-ephemeral-scope-template-rows */`);
    params.push(
      event.id,
      event.orgId,
      event.mode,
      event.name,
      event.matchInput,
      event.matchValues,
      event.opensAt,
      event.closesAt,
      event.timeZone,
      event.capacity,
      event.reentry,
      event.note,
      actor.orgId,
      event.id,
      assignment.templateRows,
    );
  } else {
    parts.push(`(SELECT json_group_array(json_array(template_id,scoped_template_id,scoped_org_id,scoped_status))
      FROM (SELECT st.template_id,t.id AS scoped_template_id,t.org_id AS scoped_org_id,t.status AS scoped_status
        FROM scanner_templates st LEFT JOIN templates t
          ON t.id=st.template_id AND (t.org_id=? OR t.org_id IS NULL) AND t.status!='deleted'
        WHERE st.scanner_id=?/* scan-ephemeral-scanner-id */ ORDER BY st.template_id))=?/* scan-ephemeral-scope-template-rows */`);
    params.push(actor.orgId, scanner.id, assignment.templateRows);
  }

  if (actor.scanningSession) {
    if (!appendSessionHistoryScope(actor, assignment, scan, parts, params)) return denied();
  } else if (assignment.eventId !== null) {
    parts.push(
      `${scan}.event_id IS ?/* scan-ephemeral-event-id */`,
      `(${scan}.template_id IS NULL OR ${scan}.template_id IN (SELECT value FROM json_each(?/* scan-ephemeral-template-ids */)))`,
    );
    params.push(assignment.eventId, assignedIds);
  } else if (assignment.templateIds.length) {
    parts.push(
      `(${scan}.template_id IS NULL OR ${scan}.template_id IN (SELECT value FROM json_each(?/* scan-ephemeral-template-ids */)))`,
    );
    params.push(assignedIds);
  } else {
    let acceptsAll = false;
    try {
      const settings = ScannerSettingsSchema.safeParse(JSON.parse(scanner.settings));
      if (!settings.success) return denied();
      acceptsAll = settings.data.acceptAllTemplates === true;
    } catch {
      return denied();
    }
    if (!acceptsAll) parts.push(`${scan}.template_id IS NULL`, `${scan}.event_id IS NULL`);
  }
  return { sql: parts.join(' AND '), params };
}
