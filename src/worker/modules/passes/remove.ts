import { NotFoundError } from '../../platform/errors.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { recordAudit } from '../audit/service.ts';
import { recordPassEvent } from '../events/record.ts';
import { toSummary } from './detail.ts';
import { publishPass } from './publish.ts';
import { getPass } from './repo.ts';
import { getRemoval, setRemoval } from './repo-remove.ts';
import type { Actor } from './service.ts';

const MESSAGE_MAX = 200;
const causeOf = (actor: Actor) => (actor.type === 'api_key' ? 'api' : 'admin');

async function required(ctx: ServiceContext, passId: string, scope: string | null) {
  const pass = await getPass(ctx.env.DB, passId, scope);
  if (!pass) throw new NotFoundError('Pass not found.', 'PASS_NOT_FOUND');
  return pass;
}

/**
 * Publishes the final version (voided, expired now, stripped; see remove-build.ts) and pushes it.
 * Wallet has no call that deletes a pass: the device files it under Expired passes and the holder
 * deletes it there. Removing a removed pass changes nothing.
 */
export async function removePass(
  ctx: ServiceContext,
  actor: Actor,
  passId: string,
  input: { message?: string | undefined },
  scope: string | null,
) {
  const pass = await required(ctx, passId, scope);
  if (pass.removedAt !== null) return toSummary(pass);
  const message = input.message?.trim().slice(0, MESSAGE_MAX) || null;
  const db = ctx.env.DB;
  await setRemoval(db, pass.id, { at: ctx.clock.now(), message, priorStatus: pass.status });
  let published;
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
    await setRemoval(db, pass.id, null);
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
  scope: string | null,
) {
  const pass = await required(ctx, passId, scope);
  const db = ctx.env.DB;
  const removal = await getRemoval(db, pass.id);
  if (!removal) return toSummary(pass);
  await setRemoval(db, pass.id, null);
  let published;
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
    await setRemoval(db, pass.id, removal);
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
