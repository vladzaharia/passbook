import type { z } from 'zod';
import {
  type ScanFeedRowSchema,
  ScanReasonSchema,
  type ScanRecordDto,
  ScanRecordKindSchema,
} from '../../../shared/contracts/index.ts';
import { DEFAULT_TIME_ZONE } from '../../../shared/time-zone.ts';
import type { SessionAuth } from '../../platform/auth.ts';
import { ForbiddenError, UnauthenticatedError } from '../../platform/errors.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import type { TenantPassWrite } from '../passes/http.ts';
import { adminActor, captureScanTenantAuthority, tenantScanRole } from './actor.ts';
import { effectValue, projectScanRecord } from './feed-projection-history.ts';
import type { ScanActor } from './guard.ts';
import type { HistoryPolicy } from './history-policy.ts';
import type { HistoryRow } from './history-row.ts';
import {
  checkProvenance,
  type HistoryEvidenceCache,
  historyEvidenceOf,
  withKeyset,
} from './history-row-evidence.ts';
import type { ScanLogFilter } from './repo-feed.ts';
import { recordedRoleProjected } from './scan-event-proof-recorded.ts';

export type ConsoleAuthority = Extract<TenantPassWrite, { kind: 'session' }>;

export type Feed = z.infer<typeof ScanFeedRowSchema>;

/** The verified event proof signs which roles may see the action; a key may see what the door may. */
function doorSeesAction(row: HistoryRow): boolean {
  try {
    const data: unknown = JSON.parse(row.ledger?.data ?? 'null');
    const door = (
      data as { authority?: { eventProjection?: { roles?: { door?: unknown } } } } | null
    )?.authority?.eventProjection?.roles?.door as { action?: unknown } | undefined;
    return !!door && typeof door.action === 'object' && door.action !== null;
  } catch {
    // A proof whose data cannot be read grants no action detail.
    return false;
  }
}

/** As the console: a pass shows only when the event projected its recorded role. */
function passProjected(row: HistoryRow): boolean {
  try {
    const data: unknown = JSON.parse(row.ledger?.data ?? 'null');
    return recordedRoleProjected((data as { authority?: unknown } | null)?.authority);
  } catch {
    // A proof whose data cannot be read projects no pass.
    return false;
  }
}

/**
 * API keys have no scan role: names stay out, and action detail follows the door's event-time view.
 * Effect values pass the door's history policy, the filter the console applies for its viewer.
 */
export function toFeed(row: HistoryRow, door: HistoryPolicy | null): Feed {
  const reason = ScanReasonSchema.safeParse(row.reason);
  const noPolicy = !row.policyAvailable;
  const passHidden = noPolicy || (row.passId !== null && !passProjected(row));
  const detail = !passHidden && doorSeesAction(row);
  const kind = detail ? ScanRecordKindSchema.safeParse(row.actionKind) : null;
  return {
    id: row.id,
    at: row.at,
    passId: passHidden ? null : row.passId,
    externalId: null,
    templateId: passHidden ? null : row.templateId,
    eventId: !noPolicy || row.passlessProofCandidate ? row.eventId : null,
    actionId: detail ? row.actionId : null,
    kind: kind?.success ? kind.data : null,
    outcome: row.outcome ?? 'refused',
    reason: reason.success ? reason.data : null,
    amount: detail ? row.amount : null,
    before: detail && door ? effectValue(row.before, door) : null,
    after: detail && door ? effectValue(row.after, door) : null,
    method: row.method,
    scannerId: noPolicy ? null : row.scannerId,
    scannerName: null,
    undoneAt: row.undoneAt,
  };
}

export function assertFeedKey(status: 'ok' | 'invalid' | 'forbidden'): void {
  if (status === 'invalid')
    throw new UnauthenticatedError('The API key is invalid or expired.', 'INVALID_API_KEY');
  if (status === 'forbidden')
    throw new ForbiddenError('The API key lacks the scans:read scope.', 'MISSING_SCOPE');
}

/**
 * Event, scanner and staff filters also run in SQL, which narrows the candidates. Only a projected
 * record whose provenance was verified may match them, and pass IDs and titles match here alone.
 */
export function recordMatches(record: ScanRecordDto, filter: ScanLogFilter): boolean {
  return (
    (!filter.passId || record.passId === filter.passId) &&
    (!filter.eventId || record.eventId === filter.eventId) &&
    (!filter.templateId || record.templateId === filter.templateId) &&
    (!filter.scannerId || record.scannerId === filter.scannerId) &&
    (!filter.staffId || record.staffId === filter.staffId) &&
    (!filter.q ||
      record.passId === filter.q ||
      !!record.passTitle?.toLowerCase().startsWith(filter.q.toLowerCase()))
  );
}

/** The viewer's tenant grants, not the scanner that recorded a row, determine visibility. */
export async function consoleFeedActor(
  ctx: ServiceContext,
  session: SessionAuth,
  authority: ConsoleAuthority,
): Promise<ScanActor> {
  const actor = adminActor(session, authority.mode, {
    orgId: authority.orgId,
    event: null,
    templateIds: [],
    timeZone: DEFAULT_TIME_ZONE,
  });
  actor.tenantAuthority = await captureScanTenantAuthority(ctx, session, authority);
  actor.platformSessionId = session.sessionId;
  actor.role = tenantScanRole(authority);
  return actor;
}
export interface ProjectedRecord {
  record: ScanRecordDto;
  row: HistoryRow;
}

/**
 * Check each row's provenance, evaluate the viewer's policy on the same snapshot, and project. The
 * rows, the pass state and the names were read together, so nothing is re-asserted afterwards.
 */
export async function recordsOf(
  ctx: ServiceContext,
  rows: readonly HistoryRow[],
  actor: ScanActor,
  cache: HistoryEvidenceCache,
): Promise<ProjectedRecord[]> {
  const { checked, evidence } = await withKeyset(ctx, rows, async () => {
    const marked = await checkProvenance(ctx, rows, cache);
    const found = await historyEvidenceOf(ctx, marked, {
      role: actor.role,
      cache,
      requireAvailable: true,
    });
    return { checked: marked, evidence: found };
  });
  return checked.map((row) => {
    const found = evidence.get(row.id);
    return {
      record: projectScanRecord(
        row,
        found?.sources.currentTitle ?? null,
        actor,
        found?.policy ?? null,
      ),
      row,
    };
  });
}
