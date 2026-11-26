import { strictEmail } from '../../../shared/email.ts';
import { ConflictError, NotFoundError, ValidationError } from '../../platform/errors.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { recordAudit } from '../audit/service.ts';
import { processVerifyRequest } from '../auth/magic-service.ts';
import { emailsOf } from '../auth/repo.ts';
import { isOwnedByOther } from '../auth/repo-magic.ts';
import * as repo from './repo.ts';
import { getUserDetail, requireUser, type UserDetailDto } from './service.ts';

function parseEmail(raw: string): string {
  const email = strictEmail(raw);
  if (!email) throw new ValidationError('Enter a valid email address.', [], 'EMAIL_INVALID');
  return email;
}

const audit = (ctx: ServiceContext, actorId: string, userId: string, action: string) =>
  recordAudit(ctx, { actorType: 'user', actorId, action, targetType: 'user', targetId: userId });

/**
 * Sends the address a verification link for this user. The address joins the account only when
 * its holder follows the link signed in as that user: an admin's word is not a mailbox proof, and
 * proof is what attaches waiting passes and accepts invitations.
 */
export async function requestEmailProof(
  ctx: ServiceContext,
  actorId: string,
  id: string,
  rawEmail: string,
  currentSessionId?: string,
): Promise<UserDetailDto> {
  const email = parseEmail(rawEmail);
  await requireUser(ctx, id);
  if (await isOwnedByOther(ctx.env.DB, email, id)) {
    throw new ConflictError('That address belongs to another account.', 'EMAIL_TAKEN');
  }
  const proven = (await emailsOf(ctx.env.DB, id)).some((e) => e.email === email);
  if (!proven) {
    await processVerifyRequest(ctx, { userId: id, email });
    await audit(ctx, actorId, id, 'user.email_proof_requested');
  }
  return getUserDetail(ctx, id, currentSessionId, actorId);
}

export async function removeEmail(
  ctx: ServiceContext,
  actorId: string,
  id: string,
  rawEmail: string,
  currentSessionId?: string,
): Promise<UserDetailDto> {
  const email = parseEmail(rawEmail);
  const user = await requireUser(ctx, id);
  if (user.primary_email === email) {
    throw new ConflictError('The primary email cannot be removed.', 'PRIMARY_EMAIL');
  }
  if (!(await repo.removeEmail(ctx.env.DB, id, email))) {
    throw new NotFoundError('Email not found.', 'EMAIL_NOT_FOUND');
  }
  await audit(ctx, actorId, id, 'user.email_remove');
  return getUserDetail(ctx, id, currentSessionId, actorId);
}

/** Sign-in emails go to the new primary; it must be one of the user's verified addresses. */
export async function makePrimaryEmail(
  ctx: ServiceContext,
  actorId: string,
  id: string,
  rawEmail: string,
  currentSessionId?: string,
): Promise<UserDetailDto> {
  const email = parseEmail(rawEmail);
  const user = await requireUser(ctx, id);
  if (user.primary_email !== email) {
    if (!(await repo.setPrimaryEmail(ctx.env.DB, id, email))) {
      throw new NotFoundError('Email not found.', 'EMAIL_NOT_FOUND');
    }
    await audit(ctx, actorId, id, 'user.email_primary');
  }
  return getUserDetail(ctx, id, currentSessionId, actorId);
}
