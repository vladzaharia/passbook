import type { AppleRpc } from '../../../../workers/passbook-apple-connector/src/types.ts';
import { MANAGED_PREFIX } from '../../../shared/identity-handle.ts';
import { ConflictError } from '../../platform/errors.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { passTypeOf } from './handles.ts';
import { auditOnce, beginStep, type LoadedRun, patchRef, type RunRef } from './provision-run.ts';
import { getCertificateRow } from './repo-certificates.ts';
import { identityCertByPassType, openIdentity } from './repo-provision.ts';
import { handleOwner, type RunRow } from './repo-runs.ts';

export type PlatformSlot = 'root' | 'devtest';

/** The platform's own pass types: the connector orders exactly these two, by slot, never by free text. */
export const PLATFORM_SLOTS = {
  root: { passType: 'pass.mobile.passbook', label: 'PassBook', handle: null, purpose: 'passes' },
  devtest: {
    passType: `${MANAGED_PREFIX}devtest`,
    label: 'PassBook device test',
    handle: 'devtest',
    purpose: 'device_test',
  },
} as const;

/** `target_id` of a platform run: one open run per slot (`identity_runs_one_open`). */
export const platformTarget = (slot: PlatformSlot): string => `platform:${slot}`;

/** A provision run that targets an identity slot instead of an org. */
export const isPlatformRun = (run: RunRow): boolean =>
  run.kind === 'provision' && run.target_type === 'identity';

function slotOf({ run, ref }: LoadedRun): PlatformSlot {
  const slot = ref.platformSlot;
  if (!slot || !Object.hasOwn(PLATFORM_SLOTS, slot) || run.target_id !== platformTarget(slot))
    throw new ConflictError('The run has no platform slot.', 'IDENTITY_RUN_INCOMPLETE');
  return slot;
}

/** What a provision run builds: the org's managed identity, or one of the platform slots. */
export function provisionTarget(run: RunRow, ref: RunRef) {
  if (!isPlatformRun(run))
    return {
      orgId: run.target_id as string | null,
      passType: passTypeOf(ref.handle ?? ''),
      label: `Managed ${ref.handle}`,
      handle: (ref.handle ?? '') as string | null,
      provenance: 'managed' as 'managed' | 'platform',
      purpose: 'passes' as 'passes' | 'device_test',
    };
  const spec = PLATFORM_SLOTS[slotOf({ run, ref })];
  return {
    orgId: null,
    passType: spec.passType,
    label: spec.label,
    handle: spec.handle,
    provenance: 'platform' as const,
    purpose: spec.purpose,
  };
}

/** `devtest` is reserved for the platform in `identity_handles`: an org that holds it blocks the run. */
async function assertHandleHeld(db: D1Database, handle: string | null): Promise<void> {
  if (handle === null) return;
  const owner = await handleOwner(db, handle);
  if (owner?.orgId !== null)
    throw new ConflictError(
      'This handle is not reserved for the platform.',
      'IDENTITY_HANDLE_TAKEN',
    );
}

export async function loadPlatform(ctx: ServiceContext, loaded: LoadedRun): Promise<void> {
  const slot = slotOf(loaded);
  const spec = PLATFORM_SLOTS[slot];
  const existing = await identityCertByPassType(ctx.env.DB, spec.passType);
  if (existing && existing.org_id !== null)
    throw new ConflictError('This pass type belongs to another identity.', 'IDENTITY_PTI_TAKEN');
  if (existing?.cert_pem)
    throw new ConflictError(
      'This platform identity is already set up.',
      'IDENTITY_ALREADY_PROVISIONED',
    );
  await assertHandleHeld(ctx.env.DB, spec.handle);
  await auditOnce(ctx, loaded, 'identity.provision_requested', { platformSlot: slot });
}

/** Finds the pass type (a retry adopts one an earlier attempt created), else asks the connector to create the slot's. */
export async function resolvePlatformPassType(
  ctx: ServiceContext,
  rpc: AppleRpc,
  loaded: LoadedRun,
): Promise<void> {
  const runId = loaded.run.id;
  const slot = slotOf(loaded);
  const spec = PLATFORM_SLOTS[slot];
  await assertHandleHeld(ctx.env.DB, spec.handle);
  const found = await rpc.findPassType(spec.passType, runId);
  const made = found ? null : await rpc.createPlatformPassType(slot, runId);
  const passType = found ?? made;
  if (passType?.identifier !== spec.passType) {
    ctx.log.error('identity.pass_type_mismatch', {
      runId,
      code: 'IDENTITY_PASS_TYPE_MISMATCH',
      slot,
    });
    throw new ConflictError(
      'Apple returned a different pass type than the platform slot.',
      'IDENTITY_PASS_TYPE_MISMATCH',
    );
  }
  await patchRef(ctx, runId, { ascPassTypeId: passType.ascId });
  await auditOnce(ctx, loaded, 'identity.pass_type_created', {
    passTypeIdentifier: spec.passType,
    outcome: made?.outcome === 'created' ? 'created' : 'found',
  });
}

/** Opens the activated identity to new passes. It does not become the default: that is a separate, checked step. */
export async function stepOpen(ctx: ServiceContext, runId: string): Promise<void> {
  const { ref } = await beginStep(ctx, runId, 'open');
  if (!ref.identityId)
    throw new ConflictError('The run has no identity.', 'IDENTITY_RUN_INCOMPLETE');
  const cert = ref.certId ? await getCertificateRow(ctx.env.DB, ref.certId) : null;
  if (cert?.state !== 'active' || cert.identity_id !== ref.identityId)
    throw new ConflictError('The identity was not activated by this run.', 'IDENTITY_CHANGED');
  await openIdentity(ctx.env.DB, ref.identityId);
}
