import { PlainLineSchema } from '../../../shared/contracts/common.ts';
import type { SessionAuth } from '../../platform/auth.ts';
import { ConflictError, UnauthenticatedError } from '../../platform/errors.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import type { ScanActor } from './actor.ts';
import { captureCredentialKeyset } from './credential-keyset-authority.ts';
import {
  type ConsoleAuthority,
  consoleFeedActor,
  consoleFeedAuthorityPredicate,
} from './feed-projection.ts';
import { historyPolicy } from './history-policy.ts';
import {
  historyProofPolicySources,
  historyProofSnapshotsForOrg,
  type VerifiedHistoryProof,
} from './history-proof.ts';
import {
  listAdminStaff,
  prepareStaffActivity,
  type StaffCsrfFence,
} from './repo-staff-activity.ts';
import type { StaffPage } from './repo-staff-page.ts';

const scannerNameSchema = PlainLineSchema(40);
const PROOF_BATCH = 32;

/**
 * Prepare signed-name evidence without trusting it until the final D1 snapshot. Without a keyset
 * (or an actor to prove it for) the list still renders; scanner names then read as "Scanner".
 */
export async function staffViewProofs(
  ctx: ServiceContext,
  session: SessionAuth,
  authority: ConsoleAuthority,
  page: StaffPage,
) {
  const db = ctx.env.DB;
  const prepared = await prepareStaffActivity(db, authority, ctx.clock.now(), page);
  const bare = {
    zones: prepared.zones,
    proofs: [] as VerifiedHistoryProof[],
    credentialKeysetCommitment: null as string | null,
    actorFence: null as StaffCsrfFence | null,
  };
  let actor: ScanActor;
  try {
    actor = await consoleFeedActor(ctx, session, authority);
  } catch (error) {
    if (error instanceof UnauthenticatedError) return bare;
    throw error;
  }
  const actorFence = await consoleFeedAuthorityPredicate(ctx, actor);
  const credentialKeysetCommitment = await captureCredentialKeyset(ctx, actorFence);
  if (credentialKeysetCommitment === null) return bare;
  const snapshots = await historyProofSnapshotsForOrg(
    ctx,
    { orgId: authority.orgId, mode: authority.mode, credentialKeysetCommitment },
    prepared.scanIds,
    new Map(),
  );
  const role = actor.role;
  const visible: VerifiedHistoryProof[] = [];
  const proofs = [...snapshots.values()];
  for (let start = 0; start < proofs.length; start += PROOF_BATCH) {
    const checked = await Promise.all(
      proofs.slice(start, start + PROOF_BATCH).map(async (proof) => {
        if (!proof.projectionCurrent) return null;
        const source = historyProofPolicySources(proof);
        if (!source?.currentScannerName) return null;
        const name = scannerNameSchema.safeParse(source.currentScannerName);
        if (!name.success || name.data !== source.currentScannerName) return null;
        const policy = await historyPolicy(ctx.env, { ...source, role });
        return policy?.scannerNameVisible(source.currentScannerName) ? proof : null;
      }),
    );
    for (const proof of checked) if (proof) visible.push(proof);
  }
  return { zones: prepared.zones, proofs: visible, credentialKeysetCommitment, actorFence };
}

/** Return only an atomic, current staff/activity snapshot. */
export async function staffViews(
  ctx: ServiceContext,
  session: SessionAuth,
  authority: ConsoleAuthority,
  page: StaffPage,
) {
  const prepared = await staffViewProofs(ctx, session, authority, page);
  const result = await listAdminStaff(
    ctx.env.DB,
    authority,
    prepared.zones,
    prepared.credentialKeysetCommitment,
    prepared.actorFence,
    prepared.proofs,
    ctx.clock.now(),
    page,
  );
  if (result.authorized && !result.snapshotCurrent)
    throw new ConflictError('Scanner activity changed. Reload and retry.', 'SCAN_STAFF_CHANGED');
  return result;
}
