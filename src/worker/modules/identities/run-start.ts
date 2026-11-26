import { ConflictError, NotFoundError } from '../../platform/errors.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { PLATFORM_SLOTS, type PlatformSlot, platformTarget } from './provision-platform.ts';
import { getManagedState, identityCertByPassType } from './repo-provision.ts';
import { findOpenRun, finishRun, insertRun, type RunKind, type RunRow } from './repo-runs.ts';

export interface StartedRun {
  runId: string;
  /** False when an open run for the same target and kind already existed. */
  created: boolean;
}

/** Params of the `IdentityProvision` Workflow. The instance id is the run id. */
export interface IdentityProvisionParams {
  runId: string;
}

/**
 * Starts a run, or returns the open one: the unique index lets one run per target and kind be open, and
 * the Workflow instance id is the run id, so creating the instance twice is a no-op.
 */
async function startRun(
  ctx: ServiceContext,
  input: {
    kind: RunKind;
    targetType: RunRow['target_type'];
    targetId: string;
    orgId: string | null;
    createdBy: string | null;
    ref?: Record<string, unknown>;
  },
): Promise<StartedRun> {
  const db = ctx.env.DB;
  const id = ctx.ids.id();
  const inserted = await insertRun(db, {
    id,
    orgId: input.orgId,
    kind: input.kind,
    targetType: input.targetType,
    targetId: input.targetId,
    createdBy: input.createdBy,
    ref: input.ref ?? {},
    now: ctx.clock.now(),
  });
  if (!inserted) {
    const open = await findOpenRun(db, input.targetType, input.targetId, input.kind);
    if (open) return { runId: open.id, created: false };
    // The open run finished between the insert and the read: start again.
    return startRun(ctx, input);
  }
  try {
    await ctx.env.IDENTITY_PROVISION.create({ id, params: { runId: id } });
  } catch (error) {
    // No instance will ever pick this run up; closing it frees the unique index for the next start.
    await finishRun(db, id, 'failed', 'IDENTITY_RUN_CREATE', ctx.clock.now());
    ctx.log.error('identity.run_create_failed', { runId: id, code: 'IDENTITY_RUN_CREATE', error });
    throw error;
  }
  ctx.log.info('identity.run_started', { runId: id, kind: input.kind });
  return { runId: id, created: true };
}

/** Managed Apple identity for an org: pass type, certificate and org default. */
export function startProvision(
  ctx: ServiceContext,
  input: { orgId: string; handle?: string; createdBy: string | null },
): Promise<StartedRun> {
  return startRun(ctx, {
    kind: 'provision',
    targetType: 'org',
    targetId: input.orgId,
    orgId: input.orgId,
    createdBy: input.createdBy,
    ref: input.handle ? { requestedHandle: input.handle } : {},
  });
}

/**
 * One of the platform's own identities (`root`: pass.mobile.passbook, `devtest`): pass type, key and
 * certificate, with no org. It opens to new passes but never becomes the default.
 */
export async function startPlatformProvision(
  ctx: ServiceContext,
  input: { slot: PlatformSlot; createdBy: string | null },
): Promise<StartedRun> {
  const held = await identityCertByPassType(ctx.env.DB, PLATFORM_SLOTS[input.slot].passType);
  if (held?.cert_pem)
    throw new ConflictError(
      'This platform identity is already set up.',
      'IDENTITY_ALREADY_PROVISIONED',
    );
  return startRun(ctx, {
    kind: 'provision',
    targetType: 'identity',
    targetId: platformTarget(input.slot),
    orgId: null,
    createdBy: input.createdBy,
    ref: { platformSlot: input.slot },
  });
}

/** A new certificate for an existing identity. The planner and a manual "rotate now" both come here. */
export async function startRotation(
  ctx: ServiceContext,
  input: { identityId: string; createdBy: string | null },
): Promise<StartedRun> {
  const row = await getManagedState(ctx.env.DB, input.identityId);
  if (!row) throw new NotFoundError('Signing identity not found.', 'IDENTITY_NOT_FOUND');
  if (row.rotation !== 'auto' || row.cert_pem === null)
    throw new ConflictError(
      'This identity does not rotate automatically.',
      'IDENTITY_NOT_ROTATABLE',
    );
  return startRun(ctx, {
    kind: 'rotate',
    targetType: 'identity',
    targetId: row.id,
    orgId: row.org_id,
    createdBy: input.createdBy,
  });
}

/** Revokes one superseded certificate through the workflow, so Apple sees a run id and the ledger names it. */
export function startRevocation(
  ctx: ServiceContext,
  input: { identityId: string; orgId: string | null; certId: string; createdBy: string | null },
): Promise<StartedRun> {
  return startRun(ctx, {
    kind: 'revoke',
    targetType: 'identity',
    targetId: input.identityId,
    orgId: input.orgId,
    createdBy: input.createdBy,
    ref: { certId: input.certId },
  });
}
