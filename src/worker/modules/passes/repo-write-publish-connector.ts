import { grant, jobGrant } from '../../platform/authority.ts';
import {
  type Check,
  noReleaseHead,
  passRow,
  rawCheck,
  releaseHead,
  rowIs,
} from '../../platform/authority-checks.ts';
import { tenantCheck } from '../../platform/authority-cond.ts';
import type { SetValue } from '../../platform/authority-expr.ts';
import type { HolderPrincipal } from '../../platform/authority-principal.ts';
import type { SqlValue } from '../../platform/db.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { connectionIs } from '../connections/repo-grants.ts';
import { CREATE_CODES, createRefusal } from './create-grant.ts';
import type { TenantPassWrite } from './http.ts';
import { capabilityChecks, tenantPrincipal } from './repo-authority.ts';
import type { ConnectionPassContext } from './repo-connection-context.ts';
import type { PassReleaseSnapshot } from './repo-release.ts';
import type { PublishPassSnapshot } from './repo-write-publish-snapshot.ts';

export interface ConnectorWrite {
  id: string;
  expectedVersion: number;
  expectedPass: PublishPassSnapshot;
  release: PassReleaseSnapshot | undefined;
  requireNoReleaseHistory: boolean;
  set: Record<string, SetValue>;
  /** Raises `version` (a publish); false for connector bookkeeping such as `sync_error_code`. */
  bumpVersion: boolean;
  context?: ConnectionPassContext | undefined;
  authority?: TenantPassWrite | undefined;
  /** A device holder (Apple personalize): the grant's principal in place of a job grant. */
  holder?: HolderPrincipal | undefined;
  /** A staged removal also pins the claim it made. */
  removalClaim?: boolean | undefined;
}

/** What the connector's captured context pins on the pass row, beyond the publish snapshot. */
function contextConditions(c: ConnectionPassContext): Record<string, SqlValue> {
  return {
    status: c.status,
    connection_id: c.connectionId,
    external_ref: c.externalRef,
    owner_user_id: c.ownerUserId,
    link_generation: c.linkGeneration,
    identity_id: c.identityId,
    removed_at: null,
    ...(c.retainedReleaseProof
      ? { release_id: c.retainedReleaseProof.id, template_version: c.retainedReleaseProof.version }
      : {}),
    ...(c.retainedBinding
      ? {
          template_id: c.retainedBinding.templateId,
          release_id: c.retainedBinding.releaseId,
          template_version: c.retainedBinding.templateVersion,
        }
      : {}),
  };
}

/**
 * The connector (or legacy no-principal) publish as a grant: a connection job grant, or the tenant's
 * own principal when a user refresh carries one. The pass row, its generations, the connection and the
 * release head are checks; rows are counted from RETURNING. Null when another writer moved the row.
 */
export async function casConnector(ctx: ServiceContext, w: ConnectorWrite): Promise<number | null> {
  const p = w.expectedPass;
  const c = w.context;
  const checks: Check[] = [
    ...(w.authority ? capabilityChecks(w.authority) : []),
    ...passRow(w.id, c?.expectedRowVersion ?? p.rowVersion),
    rowIs(
      'passes',
      w.id,
      {
        lifecycle_generation: p.lifecycleGeneration,
        credential_generation: p.credentialGeneration,
        link_generation: p.linkGeneration,
        test_data_quarantined: 0,
        deleted_at: null,
        ...(c ? contextConditions(c) : {}),
      },
      'lineage',
    ),
    rawCheck(
      'lineage',
      "NOT EXISTS (SELECT 1 FROM pass_credential_transfers t WHERE t.pass_id = ? AND t.state = 'pending')",
      [w.id],
    ),
  ];
  if (c)
    checks.push(
      connectionIs({
        id: c.connectionId,
        generation: c.generation,
        syncMode: c.expectedConnectionMode,
        enabled: true,
      }),
    );
  // A device re-signs under the pass's own template, which may be archived but not deleted (issued-release rule).
  if (w.holder)
    checks.push(
      tenantCheck(
        'release',
        `EXISTS (SELECT 1 FROM templates t WHERE t.id = ? AND (t.org_id IS NULL OR t.org_id = {org})
          AND t.status != 'deleted')`,
        [p.templateId],
      ),
    );
  if (w.requireNoReleaseHistory) checks.push(noReleaseHead(p.templateId));
  if (w.release) checks.push(releaseHead(p.templateId, p.mode, 'apple', w.release.id));
  const common = {
    target: w.id,
    checks,
    codes: CREATE_CODES,
    tables: ['passes'],
  };
  const g = w.holder
    ? grant(ctx, { ...common, purpose: 'org_mode.pass.personalize', principal: w.holder })
    : w.authority
      ? grant(ctx, {
          ...common,
          purpose: 'org_mode.pass.publish_connected',
          principal: tenantPrincipal(w.authority),
        })
      : jobGrant(ctx, {
          ...common,
          purpose: c ? 'org_mode.job.connection.pass_publish' : 'org_mode.job.pass.publish',
          job: c ? 'connection-sync' : 'pass-publish',
          orgId: p.orgId,
          mode: p.mode,
        });
  g.update('passes', {
    set: w.set,
    ...(w.bumpVersion ? { inc: ['version'] } : {}),
    where: {
      id: w.id,
      version: w.expectedVersion,
      ...(w.removalClaim
        ? {
            removal_claim_version: w.expectedVersion,
            removal_claim_status: p.status,
            removal_claim_object_key: p.objectKey,
            removal_claim_link_generation: p.linkGeneration,
          }
        : {}),
    },
    returning: ['version'],
  });
  try {
    const [result] = await g.commit();
    return (result?.results as { version: number }[] | undefined)?.[0]?.version ?? null;
  } catch (error) {
    const reason = createRefusal(error);
    if (reason === null || (w.authority && (reason === 'org' || reason === 'actor'))) throw error;
    return null;
  }
}
