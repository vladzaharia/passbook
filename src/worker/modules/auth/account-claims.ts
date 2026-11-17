import { ConflictError, ForbiddenError } from '../../platform/errors.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { recordAudit } from '../audit/service.ts';
import * as repo from './repo.ts';

export async function createUser(ctx: ServiceContext, email: string, name: string | null) {
  const id = ctx.ids.id();
  await repo.insertUser(ctx.env.DB, { id, name, email, now: ctx.clock.now() });
  const user = await repo.findUserByPrimaryEmail(ctx.env.DB, email);
  if (!user) throw new Error('user insert lost');
  // Another request took the address between our lookup and insert: do not sign into its account.
  if (user.id !== id) throw new ConflictError('Email conflict.', 'EMAIL_CONFLICT');
  return user;
}

/** Frees `email` from an account that holds it unproven; audits only when this call did it. */
async function releaseClaim(ctx: ServiceContext, holderId: string, email: string): Promise<void> {
  if (!(await repo.releaseUnprovenPrimary(ctx.env.DB, holderId, email))) return;
  await recordAudit(ctx, {
    actorType: 'system',
    action: 'auth.primary_email_unproven',
    targetType: 'user',
    targetId: holderId,
  });
}

/** Another account's unproven claim on an address that `userId` has just proven. */
export async function releaseClaimOtherThan(ctx: ServiceContext, userId: string, email: string) {
  const holder = await repo.findUserByPrimaryEmail(ctx.env.DB, email);
  if (holder && holder.id !== userId) await releaseClaim(ctx, holder.id, email);
}

/**
 * The account for an address whose holder just proved it (mail link, or a provider vouching for
 * it under `oidc.trustEmail`). An account that merely lists the address as a primary email and has
 * an external identity does not own it: it may be an unverified provider claim, so the proof must
 * not merge into it (that would hand it the holder's passes and memberships). Such an account
 * loses the address and keeps its identity; the holder gets a separate account. Two exceptions:
 * the proving browser is signed in as the claimant (it is the claimant's own address), and a
 * disabled claimant stays refused rather than being replaced by a fresh active account.
 */
export async function accountForProvenEmail(
  ctx: ServiceContext,
  email: string,
  name: string | null,
  sessionUserId?: string | null,
): Promise<repo.UserRow> {
  return (
    (await repo.findUserByProvenEmail(ctx.env.DB, email)) ??
    (await createUserForProvenEmail(ctx, email, name, sessionUserId))
  );
}

/** For an address with no proven owner: handles any unproven claimant, else creates the account. */
export async function createUserForProvenEmail(
  ctx: ServiceContext,
  email: string,
  name: string | null,
  sessionUserId?: string | null,
): Promise<repo.UserRow> {
  const claimant = await repo.findUserByPrimaryEmail(ctx.env.DB, email);
  if (claimant) {
    if (claimant.status !== 'active') {
      ctx.log.warn('auth.claimant_disabled', { code: 'CLAIMANT_DISABLED', userId: claimant.id });
      throw new ForbiddenError('Account disabled.', 'ACCOUNT_DISABLED');
    }
    if (claimant.id === sessionUserId) return claimant;
    await releaseClaim(ctx, claimant.id, email);
  }
  return createUser(ctx, email, name);
}

/** The account that owns an address its holder just proved by mail; the address is recorded on it. */
export async function accountProvenByMail(
  ctx: ServiceContext,
  email: string,
  sign: { sessionUserId?: string | null },
) {
  const db = ctx.env.DB;
  const user = await accountForProvenEmail(ctx, email, null, sign.sessionUserId);
  if (user.status !== 'active') throw new ForbiddenError('Account disabled.', 'ACCOUNT_DISABLED');
  const { ownerId } = await repo.addUserEmail(db, email, user.id, 'magic_link', ctx.clock.now());
  if (ownerId !== user.id) throw new ForbiddenError('Email conflict.', 'EMAIL_CONFLICT');
  await repo.adoptPrimaryEmail(db, user.id, email);
  return user;
}
