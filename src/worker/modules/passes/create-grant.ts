import { type Grant, grant, jobGrant } from '../../platform/authority.ts';
import { type Check, exactlyOne, releaseHead } from '../../platform/authority-checks.ts';
import { AppError, type DenyReason } from '../../platform/errors.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { connectionIs } from '../connections/repo-grants.ts';
import { sampleScannerScopeFence } from '../scan/sample-scope-fence.ts';
import { capabilityChecks, tenantPrincipal } from './repo-authority.ts';
import {
  fenceHolds,
  releaseOrgCheck,
  releaseSnapshotCheck,
  scannerHasNoDevicesCheck,
  scannerTemplatesCheck,
  templateHeadCheck,
} from './repo-create-checks.ts';
import { type RetainedIssuanceScope, retainedIssuanceChecks } from './repo-write-retained.ts';
import type { NewPassRow } from './repo-write-types.ts';

/** Refusal codes of the create grant. Every one is a lost race the caller diagnoses, except `org` and `actor`. */
export const CREATE_CODES = {
  org: 'ORG_ACCESS_CHANGED',
  actor: 'ACTOR_CHANGED',
  staff: 'CREATE_STAFF',
  config: 'CREATE_CONNECTION',
  lineage: 'CREATE_LINEAGE',
  release: 'CREATE_RELEASE',
  retention: 'CREATE_RETENTION',
  stale: 'CREATE_STALE',
} as const satisfies Record<DenyReason, string>;

const REASON_OF = new Map<string, DenyReason>(
  (Object.entries(CREATE_CODES) as [DenyReason, string][]).map(([reason, code]) => [code, reason]),
);

export const createRefusal = (error: unknown): DenyReason | null =>
  error instanceof AppError ? (REASON_OF.get(error.code) ?? null) : null;

/** The scan module's whole sample-scope fence, read immediately before the create commits. */
export async function sampleScopeCurrent(db: D1Database, row: NewPassRow): Promise<boolean> {
  const ex = row.execution;
  if (ex.kind !== 'tenant' || ex.sampleScannerScope === undefined) return true;
  const fence = sampleScannerScopeFence(ex.sampleScannerScope, row.orgId, row.mode, row.templateId);
  return fenceHolds(db, fence);
}

/** The grant of a pass create: its principal, the checks that hold at commit, and the table bound. */
export function createGrant(
  ctx: ServiceContext,
  row: NewPassRow,
  retained: RetainedIssuanceScope | undefined,
): Grant {
  const ex = row.execution;
  const checks: Check[] = [
    releaseHead(row.templateId, row.mode, 'apple', row.release.id),
    releaseSnapshotCheck(row),
    releaseOrgCheck(row.release),
  ];
  if (row.connectionId !== null)
    checks.push(
      connectionIs({
        id: row.connectionId,
        ...(row.connectionGeneration === null ? {} : { generation: row.connectionGeneration }),
        ...(row.expectedConnectionMode === undefined
          ? {}
          : { syncMode: row.expectedConnectionMode }),
        enabled: true,
      }),
    );
  if (retained) checks.push(...retainedIssuanceChecks(retained));
  if (ex.kind === 'tenant' && ex.sampleScannerScope !== undefined) {
    // The scanner row and its scope are proved in the grant; the rest of the scan module's fence
    // (session, event, template usability) is read by `sampleScopeCurrent` just before the commit.
    const { scanner, scannerScope } = ex.sampleScannerScope;
    checks.push(
      exactlyOne(
        'scanners',
        {
          id: scanner.id,
          kind: scanner.kind,
          device_role: scanner.deviceRole,
          event_id: scanner.eventId,
          settings: scanner.settings,
          time_zone: scanner.timeZone,
          revoked_at: scanner.revokedAt,
        },
        undefined,
        'config',
      ),
      scannerTemplatesCheck(scanner.id, scannerScope.templateIds),
    );
    // Every template the scanner (or its session) may scan keeps an effective release head.
    const scoped = ex.sampleScannerScope.session?.scope.templateIds ?? scannerScope.templateIds;
    for (const templateId of scoped) checks.push(templateHeadCheck(templateId, row.orgId));
    const { event } = scannerScope;
    if (event)
      checks.push(
        exactlyOne(
          'scan_events',
          { id: event.id, updated_at: event.updatedAt, archived_at: null },
          undefined,
          'config',
        ),
      );
    const session = ex.sampleScannerScope.session;
    if (session === null) checks.push(scannerHasNoDevicesCheck(scanner.id));
    else
      checks.push(
        exactlyOne(
          'scanning_sessions',
          {
            id: session.row.id,
            status: session.row.status,
            accepts: session.row.accepts,
            settings: session.row.settings,
            time_zone: session.row.time_zone,
            updated_at: session.row.updated_at,
          },
          undefined,
          'config',
        ),
        exactlyOne(
          'scanning_devices',
          {
            scanner_id: scanner.id,
            session_id: session.row.id,
            surface: session.device.surface,
            effective_surface: session.device.effective_surface,
            overrides: session.device.overrides,
            admin_user_id: session.device.admin_user_id,
            device_key: session.device.device_key,
          },
          undefined,
          'config',
        ),
      );
  }
  if (ex.kind === 'connection' || ex.kind === 'system')
    return jobGrant(ctx, {
      purpose:
        ex.kind === 'connection'
          ? 'org_mode.job.connection.pass_create'
          : 'org_mode.job.pass.create',
      job: ex.kind === 'connection' ? 'connection-sync' : 'pass-create',
      orgId: row.orgId,
      mode: row.mode,
      checks,
      codes: CREATE_CODES,
      target: row.id,
      tables: CREATE_TABLES,
    });
  return grant(ctx, {
    purpose: 'org_mode.pass.create',
    principal: tenantPrincipal(ex.authority),
    target: row.id,
    checks: [
      ...capabilityChecks(ex.authority),
      ...(ex.additionalAuthority ? capabilityChecks(ex.additionalAuthority) : []),
      ...checks,
    ],
    codes: CREATE_CODES,
    tables: CREATE_TABLES,
  });
}

const CREATE_TABLES = ['passes', 'pass_events', 'pass_issuance_deliveries'] as const;
