import { type Grant, grant, jobGrant } from '../../platform/authority.ts';
import { type Check, exactlyOne, rawCheck, releaseHead } from '../../platform/authority-checks.ts';
import { tenantCheck } from '../../platform/authority-cond.ts';
import type { Principal } from '../../platform/authority-principal.ts';
import { first } from '../../platform/db.ts';
import { AppError, type DenyReason } from '../../platform/errors.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { connectionIs } from '../connections/repo-grants.ts';
import { sampleScannerScopeFence } from '../scan/sample-scope-fence.ts';
import type { TenantPassWrite } from './http.ts';
import { capabilityChecks, tenantPrincipal } from './repo-authority.ts';
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
  return (await first(db, `SELECT 1 AS ok WHERE ${fence.sql}`, fence.params)) !== null;
}

/** The tenant principal of a request; a platform key (no org of its own) names the org it acts on. */
export function actingPrincipal(authority: TenantPassWrite): Principal {
  const principal = tenantPrincipal(authority);
  if (principal.kind === 'api_key' && authority.kind === 'api_key' && authority.keyOrgId === null)
    principal.orgId = authority.orgId;
  return principal;
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
    rawCheck(
      'release',
      `EXISTS (SELECT 1 FROM template_releases r WHERE r.id = ? AND r.generation = ?
        AND r.version = ? AND r.candidate_hash IS ? AND r.provider = ?)`,
      [
        row.release.id,
        row.release.generation,
        row.templateVersion,
        row.release.candidateHash,
        row.release.provider,
      ],
    ),
    // An org release belongs to the grant's org; a platform release has no org.
    tenantCheck(
      'release',
      `EXISTS (SELECT 1 FROM template_releases r WHERE r.id = ? AND ${
        row.release.orgId === null ? 'r.org_id IS NULL' : 'r.org_id = {org}'
      })`,
      [row.release.id],
    ),
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
      rawCheck(
        'config',
        `(SELECT json_group_array(template_id) FROM
          (SELECT template_id FROM scanner_templates WHERE scanner_id = ? ORDER BY template_id)) = ?`,
        [scanner.id, JSON.stringify([...scannerScope.templateIds].sort())],
      ),
    );
    // Every template the scanner (or its session) may scan keeps an effective release head.
    const scoped = ex.sampleScannerScope.session?.scope.templateIds ?? scannerScope.templateIds;
    for (const templateId of scoped)
      checks.push(
        tenantCheck(
          'config',
          `EXISTS (SELECT 1 FROM template_release_heads h JOIN templates owner ON owner.id = h.template_id
            WHERE h.template_id = ? AND h.mode = {mode} AND h.provider = 'apple'
              AND owner.status != 'deleted'
              AND (h.org_scope = ? OR (h.org_scope = '' AND owner.org_id IS NULL AND owner.origin = 'baked')))`,
          [templateId, row.orgId],
        ),
      );
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
    if (session === null)
      checks.push(
        rawCheck('config', 'NOT EXISTS (SELECT 1 FROM scanning_devices d WHERE d.scanner_id = ?)', [
          scanner.id,
        ]),
      );
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
    principal: actingPrincipal(ex.authority),
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
