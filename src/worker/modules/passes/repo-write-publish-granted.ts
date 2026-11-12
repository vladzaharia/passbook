import { grant } from '../../platform/authority.ts';
import {
  type Check,
  noReleaseHead,
  passRow,
  rawCheck,
  releaseHead,
  rowIs,
} from '../../platform/authority-checks.ts';
import type { SetValue } from '../../platform/authority-expr.ts';
import { AppError } from '../../platform/errors.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import type { TenantPassWrite } from './http.ts';
import { capabilityChecks, tenantPrincipal } from './repo-authority.ts';
import type { PassReleaseSnapshot } from './repo-release.ts';
import type { PublishPassSnapshot } from './repo-write-publish-snapshot.ts';

export interface GrantedPublish {
  authority: TenantPassWrite;
  id: string;
  expectedVersion: number;
  expectedPass: PublishPassSnapshot;
  /** The approved release the pass is written against; its head status is checked in the grant. */
  release: PassReleaseSnapshot | undefined;
  /** A legacy pass with no release history: the scope must still have no head. */
  requireNoReleaseHistory?: boolean | undefined;
  set: Record<string, SetValue>;
  /** A staged removal also pins the claim it made. */
  removalClaim?: boolean;
}

/**
 * A refusal the caller retries after re-reading: the row moved (`stale`). Everything else is a definite
 * refusal (`lineage`, `org`, `actor`, `release`) and surfaces with its own code.
 */
export const PUBLISH_STALE = 'PASS_CONFLICT';

/**
 * The tenant publish as one grant (authority-epochs.md F3): the principal is live, the pass row is the one the
 * build read (`row_version`), its credential, lifecycle and link generations are unchanged and no transfer is
 * pending, and the release is the head. Returns the new version, or null when another writer moved the row.
 */
export async function casGranted(ctx: ServiceContext, w: GrantedPublish): Promise<number | null> {
  const p = w.expectedPass;
  const checks: Check[] = [
    ...capabilityChecks(w.authority),
    ...passRow(w.id, p.rowVersion),
    rowIs(
      'passes',
      w.id,
      {
        lifecycle_generation: p.lifecycleGeneration,
        credential_generation: p.credentialGeneration,
        link_generation: p.linkGeneration,
        test_data_quarantined: 0,
        deleted_at: null,
      },
      'lineage',
    ),
    rawCheck(
      'lineage',
      "NOT EXISTS (SELECT 1 FROM pass_credential_transfers t WHERE t.pass_id = ? AND t.state = 'pending')",
      [w.id],
    ),
  ];
  if (w.requireNoReleaseHistory) checks.push(noReleaseHead(p.templateId));
  if (w.release) checks.push(releaseHead(p.templateId, p.mode, 'apple', w.release.id));
  const g = grant(ctx, {
    purpose: 'org_mode.pass.publish',
    principal: tenantPrincipal(w.authority),
    target: w.id,
    checks,
    codes: { stale: PUBLISH_STALE, release: 'TEMPLATE_RELEASE_CONFLICT' },
  });
  g.update('passes', {
    set: w.set,
    inc: ['version'],
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
    const row = (result?.results as { version: number }[] | undefined)?.[0];
    return row?.version ?? null;
  } catch (error) {
    if (error instanceof AppError && error.code === PUBLISH_STALE) return null;
    throw error;
  }
}
