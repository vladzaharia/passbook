import { type Grant, grant, jobGrant } from '../../platform/authority.ts';
import { type Check, releaseHead } from '../../platform/authority-checks.ts';
import { condCheck, notExists } from '../../platform/authority-cond.ts';
import { AppError, type DenyReason } from '../../platform/errors.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { connectionIs } from '../connections/repo-grants.ts';
import { JOIN_CODES, joinCreateGrant } from '../join/grant.ts';
import { sampleScannerScopeCheck } from '../scan/sample-scope-fence.ts';
import {
  capabilityChecks,
  keyScope,
  membershipCapability,
  tenantPrincipal,
} from './repo-authority.ts';
import { reissuePrincipalCheck, starterPrincipal } from './repo-bulk-principal.ts';
import { notBlueprintCheck, releaseOrgCheck, releaseSnapshotCheck } from './repo-create-checks.ts';
import { externalIdFreeCheck } from './repo-external-id.ts';
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
} as const satisfies Record<Exclude<DenyReason, 'proof'>, string>;

const REASON_OF = new Map<string, DenyReason>(
  ([...Object.entries(CREATE_CODES), ...Object.entries(JOIN_CODES)] as [DenyReason, string][]).map(
    ([reason, code]) => [code, reason],
  ),
);

export const createRefusal = (error: unknown): DenyReason | null =>
  error instanceof AppError ? (REASON_OF.get(error.code) ?? null) : null;

/** The grant of a pass create: its principal, the checks that hold at commit, and the table bound. */
export function createGrant(
  ctx: ServiceContext,
  row: NewPassRow,
  retained: RetainedIssuanceScope | undefined,
): Grant {
  const ex = row.execution;
  const checks: Check[] = [
    releaseHead(row.templateId, row.mode, 'apple', row.release.id),
    notBlueprintCheck(row.templateId),
    releaseSnapshotCheck(row),
    releaseOrgCheck(row.release),
  ];
  if (row.uniqueExternalId && row.externalId !== null)
    checks.push(externalIdFreeCheck(row.templateId, row.externalId));
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
  // The scan module's whole sample-scope fence, evaluated in the grant against its own tenant.
  if (ex.kind === 'tenant' && ex.sampleScannerScope !== undefined)
    checks.push(
      sampleScannerScopeCheck(ex.sampleScannerScope, row.orgId, row.mode, row.templateId),
    );
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
  if (ex.kind === 'deferred') {
    const s = ex.starter;
    return grant(ctx, {
      purpose: 'org_mode.pass.create',
      principal: starterPrincipal(s, row.orgId, row.mode),
      target: row.id,
      checks: [
        s.kind === 'membership'
          ? membershipCapability(s.membershipId, 'passes:operate')
          : keyScope(s.keyId, 'passes:write'),
        reissuePrincipalCheck(row.orgId, s, row.now),
        ...checks,
        // A pass made by hand or by API since the check took the External ID: this row fails, not the run.
        ...(ex.guard
          ? [
              condCheck(
                'stale',
                notExists('passes', {
                  external_id: ex.guard.externalId,
                  removed_at: null,
                  deleted_at: null,
                  test_data_quarantined: 0,
                }),
              ),
            ]
          : []),
      ],
      codes: CREATE_CODES,
      tables: CREATE_TABLES,
    });
  }
  if (ex.kind === 'join')
    return joinCreateGrant(ctx, {
      linkId: ex.linkId,
      generation: ex.generation,
      orgDailyCap: ex.orgDailyCap,
      orgId: row.orgId,
      templateId: row.templateId,
      passId: row.id,
      holderEmail: row.holderEmail,
      now: row.now,
      checks,
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

const CREATE_TABLES = [
  'passes',
  'pass_events',
  'pass_issuance_deliveries',
  'pass_token_seals',
  'pass_auth_seals',
] as const;
