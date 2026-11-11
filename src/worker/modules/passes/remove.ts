import { REMOVE_MESSAGE_MAX } from '../../../shared/contracts/events.ts';
import { ConflictError } from '../../platform/errors.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { recordAudit } from '../audit/service.ts';
import { recordPassEvent } from '../events/record.ts';
import { currentSummary } from './detail.ts';
import type { TenantPassWrite } from './http.ts';
import { getPassForWrite } from './pass-access.ts';
import { publishPass } from './publish.ts';
import type { Pass } from './repo.ts';
import { getPass } from './repo-read-pass.ts';
import {
  claimRemoval,
  claimRestore,
  getPassLifecycle,
  type RemovalState,
  reinstateRemoval,
  releaseRemoval,
} from './repo-remove.ts';
import type { ScopeArg } from './scope.ts';
import type { Actor } from './service.ts';

const causeOf = (actor: Actor) => (actor.type === 'api_key' ? 'api' : 'admin');

function assertStagedPass(current: Pass, pass: Pass, removedAt: number | null): void {
  if (
    current.orgId !== pass.orgId ||
    current.mode !== pass.mode ||
    current.version !== pass.version ||
    current.templateId !== pass.templateId ||
    current.templateVersion !== pass.templateVersion ||
    current.serial !== pass.serial ||
    current.authToken !== pass.authToken ||
    current.holderEmail !== pass.holderEmail ||
    current.ownerUserId !== pass.ownerUserId ||
    current.linkGeneration !== pass.linkGeneration ||
    current.status !== pass.status ||
    current.objectKey !== pass.objectKey ||
    current.removedAt !== removedAt
  )
    throw new ConflictError('The pass changed. Reload and retry.', 'PASS_CONFLICT');
}

/**
 * Publishes the final version (voided, expired now, stripped; see remove-build.ts) and pushes it.
 * Wallet has no call that deletes a pass: the device files it under Expired passes and the holder
 * deletes it there. A proven removal is a no-op; a pending claim is recovered only if its exact
 * pass snapshot is still current. Legacy removals without a proof require a restore first.
 */
export async function removePass(
  ctx: ServiceContext,
  actor: Actor,
  passId: string,
  input: { message?: string | undefined },
  scope: ScopeArg,
  authority?: TenantPassWrite,
) {
  const db = ctx.env.DB;
  const pass = await getPassForWrite(db, passId, scope);
  const lifecycle = await getPassLifecycle(db, pass);
  if (!lifecycle) throw new ConflictError('The pass changed. Reload and retry.', 'PASS_CONFLICT');
  let claimed: {
    state: Pick<RemovalState, 'at' | 'message' | 'priorStatus'>;
    generation: number;
  } | null = null;
  let staged: Pick<RemovalState, 'at' | 'message' | 'rawPriorStatus' | 'generation'>;
  if (pass.removedAt !== null) {
    const removal = lifecycle.removal;
    if (!removal) throw new ConflictError('The pass changed. Reload and retry.', 'PASS_CONFLICT');
    if (removal.publishedGeneration === removal.generation && pass.status === 'voided')
      return currentSummary(ctx, pass, authority);
    if (
      removal.claimVersion === null ||
      removal.claimStatus === null ||
      removal.claimObjectKey === null ||
      removal.claimLinkGeneration === null
    )
      throw new ConflictError(
        'This removal predates recovery tracking. Restore the pass before removing it again.',
        'PASS_CONFLICT',
      );
    if (
      removal.claimVersion !== pass.version ||
      removal.claimStatus !== pass.status ||
      removal.claimObjectKey !== pass.objectKey ||
      removal.claimLinkGeneration !== pass.linkGeneration
    )
      throw new ConflictError(
        'The pass changed after removal was claimed. Reload.',
        'PASS_CONFLICT',
      );
    staged = removal;
  } else {
    const text = input.message?.trim().slice(0, REMOVE_MESSAGE_MAX) || null;
    const at = ctx.clock.now();
    const state = { at, message: text, priorStatus: pass.status };
    const generation = await claimRemoval(ctx, pass.id, state, {
      pass,
      generation: lifecycle.generation,
      now: at,
      authority,
    });
    if (generation === null) {
      // A racing remove (or a lost-response retry) already claimed it: the requested state holds, so answer 200.
      const fresh = await getPass(db, passId, scope);
      if (fresh && fresh.removedAt !== null && fresh.orgId === pass.orgId)
        return currentSummary(ctx, fresh, authority);
      throw new ConflictError('The pass changed. Reload and retry.', 'PASS_CONFLICT');
    }
    claimed = { state, generation };
    staged = { ...state, rawPriorStatus: state.priorStatus, generation };
  }
  let published: Awaited<ReturnType<typeof publishPass>>;
  try {
    published = await publishPass(ctx, {
      passId,
      orgScope: scope,
      cause: causeOf(actor),
      source: 'remove',
      actor,
      authority,
      expectedPass: pass,
      expectedRemoval: {
        at: staged.at,
        message: staged.message,
        priorStatus: staged.rawPriorStatus,
        generation: staged.generation,
      },
      force: true,
      mutate: (current) => {
        assertStagedPass(current, pass, staged.at);
        return { status: 'voided' };
      },
    });
  } catch (error) {
    if (claimed) await releaseRemoval(db, pass.id, { pass, ...claimed });
    throw error;
  }
  await recordPassEvent(ctx, {
    orgId: pass.orgId,
    passId,
    mode: pass.mode,
    kind: 'pass.removed',
    actor,
    data: { version: published.pass.version, message: staged.message !== null },
  });
  await recordAudit(ctx, {
    orgId: pass.orgId,
    actorType: actor.type,
    actorId: actor.id,
    action: 'pass.remove',
    targetType: 'pass',
    targetId: passId,
  });
  return currentSummary(ctx, (await getPass(db, passId, scope)) ?? published.pass, authority);
}

/** Republishes the current input as it was before the removal. */
export async function restorePass(
  ctx: ServiceContext,
  actor: Actor,
  passId: string,
  scope: ScopeArg,
  authority?: TenantPassWrite,
) {
  const db = ctx.env.DB;
  const pass = await getPassForWrite(db, passId, scope);
  const lifecycle = await getPassLifecycle(db, pass);
  if (!lifecycle) throw new ConflictError('The pass changed. Reload and retry.', 'PASS_CONFLICT');
  const removal = lifecycle.removal;
  if (!removal) return currentSummary(ctx, pass, authority);
  const generation = await claimRestore(ctx, pass.id, removal, {
    pass,
    generation: lifecycle.generation,
    now: ctx.clock.now(),
    authority,
  });
  if (generation === null) {
    const current = await getPassForWrite(db, passId, scope);
    if (current.removedAt !== null)
      throw new ConflictError('The pass changed. Reload and retry.', 'PASS_CONFLICT');
    return currentSummary(ctx, current, authority);
  }
  let published: Awaited<ReturnType<typeof publishPass>>;
  try {
    published = await publishPass(ctx, {
      passId,
      orgScope: scope,
      cause: causeOf(actor),
      source: 'restore',
      actor,
      authority,
      expectedPass: pass,
      expectedRemoval: { at: null, message: null, priorStatus: null, generation },
      force: true,
      mutate: (current) => {
        assertStagedPass(current, pass, null);
        return { status: removal.priorStatus };
      },
    });
  } catch (error) {
    await reinstateRemoval(db, pass.id, removal, { pass, generation });
    throw error;
  }
  await recordPassEvent(ctx, {
    orgId: pass.orgId,
    passId,
    mode: pass.mode,
    kind: 'pass.restored',
    actor,
    data: { version: published.pass.version },
  });
  await recordAudit(ctx, {
    orgId: pass.orgId,
    actorType: actor.type,
    actorId: actor.id,
    action: 'pass.restore',
    targetType: 'pass',
    targetId: passId,
  });
  return currentSummary(ctx, (await getPass(db, passId, scope)) ?? published.pass, authority);
}
