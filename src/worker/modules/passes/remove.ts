import { REMOVE_MESSAGE_MAX } from '../../../shared/contracts/events.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { recordAudit } from '../audit/service.ts';
import { recordPassEvent } from '../events/record.ts';
import { toSummary } from './detail.ts';
import { getPassForWrite } from './pass-access.ts';
import { publishPass } from './publish.ts';
import { getPass } from './repo.ts';
import {
  claimRemoval,
  claimRestore,
  getRemoval,
  latestVersionSource,
  reinstateRemoval,
  releaseRemoval,
} from './repo-remove.ts';
import type { ScopeArg } from './scope.ts';
import type { Actor } from './service.ts';

const causeOf = (actor: Actor) => (actor.type === 'api_key' ? 'api' : 'admin');

/**
 * Publishes the final version (voided, expired now, stripped; see remove-build.ts) and pushes it.
 * Wallet has no call that deletes a pass: the device files it under Expired passes and the holder
 * deletes it there. Removing a removed pass changes nothing, unless a crash left it marked removed
 * with no removal version: then the publish runs again.
 */
export async function removePass(
  ctx: ServiceContext,
  actor: Actor,
  passId: string,
  input: { message?: string | undefined },
  scope: ScopeArg,
) {
  const db = ctx.env.DB;
  const pass = await getPassForWrite(db, passId, scope);
  let claimedAt: number | null = null;
  if (pass.removedAt !== null) {
    if ((await latestVersionSource(db, pass.id)) === 'remove') return toSummary(pass);
  } else {
    const text = input.message?.trim().slice(0, REMOVE_MESSAGE_MAX) || null;
    const at = ctx.clock.now();
    if (!(await claimRemoval(db, pass.id, { at, message: text, priorStatus: pass.status })))
      return toSummary((await getPass(db, passId)) ?? pass);
    claimedAt = at;
  }
  const message = (await getRemoval(db, pass.id))?.message ?? null;
  let published: Awaited<ReturnType<typeof publishPass>>;
  try {
    published = await publishPass(ctx, {
      passId,
      orgScope: scope,
      cause: causeOf(actor),
      source: 'remove',
      actor,
      force: true,
      mutate: () => ({ status: 'voided' }),
    });
  } catch (error) {
    if (claimedAt !== null) await releaseRemoval(db, pass.id, claimedAt);
    throw error;
  }
  await recordPassEvent(ctx, {
    orgId: pass.orgId,
    passId,
    mode: pass.mode,
    kind: 'pass.removed',
    actor,
    data: { version: published.pass.version, message: message !== null },
  });
  await recordAudit(ctx, {
    orgId: pass.orgId,
    actorType: actor.type,
    actorId: actor.id,
    action: 'pass.remove',
    targetType: 'pass',
    targetId: passId,
  });
  return toSummary((await getPass(db, passId)) ?? published.pass);
}

/** Republishes the current input as it was before the removal. */
export async function restorePass(
  ctx: ServiceContext,
  actor: Actor,
  passId: string,
  scope: ScopeArg,
) {
  const db = ctx.env.DB;
  const pass = await getPassForWrite(db, passId, scope);
  const removal = await getRemoval(db, pass.id);
  if (!removal) return toSummary(pass);
  if (!(await claimRestore(db, pass.id, removal.at)))
    return toSummary((await getPass(db, passId)) ?? pass);
  let published: Awaited<ReturnType<typeof publishPass>>;
  try {
    published = await publishPass(ctx, {
      passId,
      orgScope: scope,
      cause: causeOf(actor),
      source: 'restore',
      actor,
      force: true,
      mutate: () => ({ status: removal.priorStatus }),
    });
  } catch (error) {
    await reinstateRemoval(db, pass.id, removal);
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
  return toSummary((await getPass(db, passId)) ?? published.pass);
}
