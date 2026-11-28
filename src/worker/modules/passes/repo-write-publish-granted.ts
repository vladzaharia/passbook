import { type Grant, grant } from '../../platform/authority.ts';
import type { AfterRead } from '../../platform/authority-after.ts';
import {
  type Check,
  noReleaseHead,
  passRow,
  rawCheck,
  releaseHead,
  rowIs,
} from '../../platform/authority-checks.ts';
import type { GrantCond } from '../../platform/authority-cond.ts';
import type { SetValue } from '../../platform/authority-expr.ts';
import { AppError } from '../../platform/errors.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { RACE_PASS_PUBLISH } from '../scan/race-tags.ts';
import type { TenantPassWrite } from './http.ts';
import { capabilityChecks, tenantPrincipal } from './repo-authority.ts';
import type { PassReleaseSnapshot } from './repo-release.ts';
import { addRotationMark, type ScanCodeRotation } from './repo-write-publish-rotation.ts';
import type { PublishPassSnapshot } from './repo-write-publish-snapshot.ts';

/**
 * A scanner's rows that commit with the pass write (the scan row, its gate and ledger event): the
 * hook's grant replaces the tenant's, so every statement shares one batch and one set of checks.
 */
export interface PublishCommit {
  /** The scan's grant with the pass checks added; its code for `stale` must be `PASS_CONFLICT`. */
  open(passChecks: Check[]): Grant;
  /** Conditions on the pass write itself: when one fails the write is skipped and the batch declines. */
  when: GrantCond[];
  /** Adds the statements that follow the pass write (`objectKey` is empty for a metadata write); it runs once per attempt. */
  add(g: Grant, w: { objectKey: string; version: number }): Promise<PublishCommitDone>;
}

export interface PublishCommitDone {
  reads?: readonly AfterRead[];
  /** Sees the batch's results, whether or not the pass write applied. */
  settle(r: { writes: D1Result[]; after: D1Result[] }, g: Grant): void;
}

/** The batch committed without the pass write: a condition of the hook's failed, and its rows closed the scan. */
export class PublishDeclined extends Error {}

export interface GrantedPublish {
  authority?: TenantPassWrite;
  commit?: PublishCommit;
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
  extraChecks?: readonly Check[] | undefined;
  /** A new scan code: its mark is written before the update, in the same batch. */
  rotation?: ScanCodeRotation | undefined;
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
    ...(w.authority ? capabilityChecks(w.authority) : []),
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
  checks.push(...(w.extraChecks ?? []));
  if (!w.authority && !w.commit) throw new Error('A publish needs a tenant authority or a commit.');
  const g =
    w.commit?.open(checks) ??
    grant(ctx, {
      purpose: 'org_mode.pass.publish',
      principal: tenantPrincipal(w.authority as TenantPassWrite),
      target: w.id,
      checks,
      codes: { stale: PUBLISH_STALE, release: 'TEMPLATE_RELEASE_CONFLICT' },
    });
  if (w.rotation) addRotationMark(g, ctx.requestId ?? null, w.id, w.expectedVersion, w.rotation);
  const update = g.update('passes', {
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
    ...(w.commit?.when.length ? { when: w.commit.when } : {}),
    returning: ['version'],
    tag: RACE_PASS_PUBLISH,
  });
  try {
    if (w.commit) {
      const done = await w.commit.add(g, {
        objectKey: String(w.set.object_key ?? ''),
        version: w.expectedVersion + 1,
      });
      const committed = await g.commitWith(done.reads ?? []);
      done.settle(committed, g);
      const written = (
        committed.writes[g.indexOf(update)]?.results as { version: number }[] | undefined
      )?.[0];
      if (!written) throw new PublishDeclined();
      return written.version;
    }
    const result = (await g.commit())[g.indexOf(update)];
    const row = (result?.results as { version: number }[] | undefined)?.[0];
    return row?.version ?? null;
  } catch (error) {
    if (error instanceof AppError && error.code === PUBLISH_STALE) return null;
    throw error;
  }
}
