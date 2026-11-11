import { batch } from '../../platform/db.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { requireCredentialRefKeyset } from '../passes/credential-keyset.ts';
import { snapshotWalletCredentialContext } from './account-service.ts';
import { requestWalletRetirement, retireUnissuedWalletPlaceholder } from './instance.ts';
import type {
  WalletCredentialKeysetProof,
  WalletInstance,
  WalletMode,
  WalletOperationKind,
  WalletProvider,
} from './instance-types.ts';
import { isCredentialKeysetCommitment } from './instance-types.ts';
import { type ScheduleResult, scheduleInstance } from './lifecycle-instance-schedule.ts';
import { getInstanceByPass, readPassSnapshot } from './repo-instance.ts';
import { walletRetirementIntentStatements } from './repo-instance-retirement.ts';

/** Captured after the pass write. A stale notification cannot enqueue work for a later revision. */
export interface WalletPassRevision extends WalletCredentialKeysetProof {
  orgId: string;
  mode: WalletMode;
  passId: string;
  passVersion: number;
  passRevision: number;
  passCredentialGeneration: number;
  lifecycleGeneration: number;
}

export interface WalletLifecycleScheduleResult {
  scheduled: number;
  blocked: number;
  stale: boolean;
}

/** Internal dirty-trigger consumer; the same path is used by explicit integration hooks. */
export async function reconcileWalletInstance(
  ctx: ServiceContext,
  instance: WalletInstance,
  expected?: WalletPassRevision,
  forceRetirement = false,
  expectedCredentialKeysetCommitment?: string,
): Promise<ScheduleResult | 'stale'> {
  ctx = snapshotWalletCredentialContext(ctx);
  instance = { ...instance };
  if (expected) expected = { ...expected };
  const credentialKeysetCommitment = instance.credentialKeysetCommitment;
  if (
    !isCredentialKeysetCommitment(credentialKeysetCommitment) ||
    (expected && expected.credentialKeysetCommitment !== credentialKeysetCommitment) ||
    (expectedCredentialKeysetCommitment !== undefined &&
      expectedCredentialKeysetCommitment !== credentialKeysetCommitment) ||
    (await requireCredentialRefKeyset(ctx.env.DB, ctx.env)) !== credentialKeysetCommitment
  )
    return 'blocked';
  const pass = await readPassSnapshot(ctx.env.DB, instance);
  if (
    !pass ||
    (expected &&
      (pass.orgId !== expected.orgId ||
        pass.mode !== expected.mode ||
        pass.passId !== expected.passId ||
        pass.passVersion !== expected.passVersion ||
        pass.passRevision !== expected.passRevision ||
        pass.lifecycleGeneration !== expected.lifecycleGeneration ||
        pass.credentialGeneration !== expected.passCredentialGeneration))
  ) {
    return 'stale';
  }
  if (instance.credentialGeneration > pass.credentialGeneration) return 'blocked';
  const priorHolder = instance.credentialGeneration < pass.credentialGeneration;
  // The target generation is staged but cannot be retired or issued while its transfer is pending.
  if (pass.transferPending !== 0 && !priorHolder && pass.deletedAt === null && !forceRetirement)
    return 'blocked';
  if (instance.lifecycle === 'blocked' || instance.lifecycle === 'ready') {
    if (!priorHolder && pass.deletedAt === null && instance.retirementRequestedAt === null)
      return 'blocked';
    const retired = await retireUnissuedWalletPlaceholder(ctx.env.DB, {
      instanceId: instance.id,
      orgId: instance.orgId,
      mode: instance.mode,
      provider: instance.provider,
      credentialGeneration: instance.credentialGeneration,
      passCredentialGeneration: pass.credentialGeneration,
      credentialKeysetCommitment,
      now: ctx.clock.now(),
    });
    return retired ? 'unchanged' : 'blocked';
  }
  if (
    (pass.deletedAt !== null || priorHolder || pass.transferPending !== 0) &&
    instance.retirementRequestedAt === null
  ) {
    const staged = await requestWalletRetirement(ctx.env.DB, {
      orgId: instance.orgId,
      mode: instance.mode,
      provider: instance.provider,
      instanceId: instance.id,
      version: instance.desiredVersion,
      now: ctx.clock.now(),
      passVersion: pass.passVersion,
      passRevision: pass.passRevision,
      lifecycleGeneration: pass.lifecycleGeneration,
      passCredentialGeneration: pass.credentialGeneration,
      issuingReleaseId: pass.issuingReleaseId,
      credentialKeysetCommitment,
    });
    if (!staged) return 'blocked';
  }
  const kind: WalletOperationKind =
    forceRetirement ||
    priorHolder ||
    pass.transferPending !== 0 ||
    instance.retirementRequestedAt !== null ||
    pass.status !== 'active' ||
    pass.removedAt !== null ||
    pass.deletedAt !== null ||
    pass.quarantined !== 0
      ? 'revoke'
      : 'upsert';
  return scheduleInstance(ctx, instance, pass, kind);
}

async function schedulePass(
  ctx: ServiceContext,
  revision: WalletPassRevision,
  action: 'current' | 'retire',
): Promise<WalletLifecycleScheduleResult> {
  ctx = snapshotWalletCredentialContext(ctx);
  revision = { ...revision };
  const credentialKeysetCommitment = revision.credentialKeysetCommitment;
  if (
    !isCredentialKeysetCommitment(credentialKeysetCommitment) ||
    (await requireCredentialRefKeyset(ctx.env.DB, ctx.env)) !== credentialKeysetCommitment
  )
    return { scheduled: 0, blocked: 0, stale: true };
  const pass = await readPassSnapshot(ctx.env.DB, { ...revision, credentialKeysetCommitment });
  if (
    !pass ||
    pass.passVersion !== revision.passVersion ||
    pass.passRevision !== revision.passRevision ||
    pass.lifecycleGeneration !== revision.lifecycleGeneration ||
    pass.credentialGeneration !== revision.passCredentialGeneration
  )
    return { scheduled: 0, blocked: 0, stale: true };
  if (action === 'retire') {
    // Stage all generations atomically, including never-issued placeholders.
    await batch(
      ctx.env.DB,
      walletRetirementIntentStatements(
        ctx.env.DB,
        {
          passId: pass.passId,
          orgId: pass.orgId,
          mode: pass.mode,
          passVersion: pass.passVersion,
          passRevision: pass.passRevision,
          lifecycleGeneration: pass.lifecycleGeneration,
          passCredentialGeneration: pass.credentialGeneration,
          issuingReleaseId: pass.issuingReleaseId,
          credentialKeysetCommitment,
          now: ctx.clock.now(),
        },
        { sql: '1 = 1', params: [] },
      ),
    );
  }
  const result: WalletLifecycleScheduleResult = { scheduled: 0, blocked: 0, stale: false };
  for (const provider of ['google', 'samsung'] as const satisfies readonly WalletProvider[]) {
    const instance = await getInstanceByPass(ctx.env.DB, { ...revision, provider });
    if (!instance) continue;
    const outcome = await reconcileWalletInstance(
      ctx,
      instance,
      revision,
      action !== 'current',
      credentialKeysetCommitment,
    );
    if (outcome === 'stale') result.stale = true;
    else if (outcome === 'blocked') result.blocked++;
    else if (outcome === 'scheduled') result.scheduled++;
  }
  return result;
}

/** After any successfully committed publication, including refresh, reissue, void and unvoid. */
export function onWalletPassUpdated(ctx: ServiceContext, revision: WalletPassRevision) {
  return schedulePass(ctx, revision, 'current');
}

/** Before hard deletion, including sandbox expiry of a still-active pass. */
export function onWalletPassRetired(ctx: ServiceContext, revision: WalletPassRevision) {
  return schedulePass(ctx, revision, 'retire');
}
