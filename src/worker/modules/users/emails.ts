import { strictEmail } from '../../../shared/email.ts';
import { ConflictError, NotFoundError, ValidationError } from '../../platform/errors.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { recordAudit } from '../audit/service.ts';
import { addUserEmail as insertUserEmail } from '../auth/repo.ts';
import { attachWaitingPassesForEmail } from '../holders/service.ts';
import * as repo from './repo.ts';
import { getUserDetail, requireUser, type UserDetailDto } from './service.ts';

function parseEmail(raw: string): string {
  const email = strictEmail(raw);
  if (!email) throw new ValidationError('Enter a valid email address.', [], 'INVALID_EMAIL');
  return email;
}

const audit = (ctx: ServiceContext, actorId: string, userId: string, action: string) =>
  recordAudit(ctx, { actorType: 'user', actorId, action, targetType: 'user', targetId: userId });

export async function addVerifiedEmail(
  ctx: ServiceContext,
  actorId: string,
  id: string,
  rawEmail: string,
  currentSessionId?: string,
): Promise<UserDetailDto> {
  const email = parseEmail(rawEmail);
  await requireUser(ctx, id);
  const { ownerId, added } = await insertUserEmail(ctx.env.DB, email, id, 'admin', ctx.clock.now());
  if (ownerId !== id) {
    throw new ConflictError('That address belongs to another account.', 'EMAIL_TAKEN');
  }
  if (added) {
    await audit(ctx, actorId, id, 'user.email_add');
    await attachWaitingPassesForEmail(ctx, id, email);
  }
  return getUserDetail(ctx, id, currentSessionId);
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
  return getUserDetail(ctx, id, currentSessionId);
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
  return getUserDetail(ctx, id, currentSessionId);
}
