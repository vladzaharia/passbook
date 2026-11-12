import { strictEmail } from '../../../shared/email.ts';
import {
  ConflictError,
  NotFoundError,
  RateLimitedError,
  ValidationError,
} from '../../platform/errors.ts';
import { checkRateLimit } from '../../platform/rate-limit.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { recordAudit } from '../audit/service.ts';
import { withinVerifyUserCap } from '../auth/magic-caps.ts';
import { processVerifyRequest } from '../auth/magic-service.ts';
import { revokeAllForUser, revokeOne } from '../auth/sessions.ts';
import * as repo from './repo.ts';

export async function listMyEmails(ctx: ServiceContext, userId: string) {
  const [user, emails] = await Promise.all([
    repo.getUser(ctx.env.DB, userId),
    repo.emailsOf(ctx.env.DB, userId),
  ]);
  const items = emails.map((e) => ({
    email: e.email,
    verifiedAt: e.verified_at as number | null,
    verifiedVia: e.verified_via as 'magic_link' | 'oidc' | 'admin' | null,
    primary: e.email === user?.primary_email,
  }));
  // The profile address can be unproven (OIDC without trusted email). Listed so it can be verified;
  // it is never in user_emails, so nothing that matches on verified emails sees it.
  if (user && !items.some((e) => e.primary)) {
    items.push({ email: user.primary_email, verifiedAt: null, verifiedVia: null, primary: true });
  }
  return { items };
}

/**
 * Asks for a verification link. The answer never depends on the address, and the lookup and send
 * run after it, so neither the body nor the latency reveals who is registered.
 */
export async function addMyEmail(ctx: ServiceContext, userId: string, rawEmail: string) {
  const email = strictEmail(rawEmail);
  if (!email) throw new ValidationError('Enter a valid email address.', [], 'EMAIL_INVALID');
  if (!(await checkRateLimit(ctx.env, 'RL_MAGIC_LINK', `verify:${userId}`))) {
    throw new RateLimitedError();
  }
  if (!(await withinVerifyUserCap(ctx, userId))) throw new RateLimitedError();
  ctx.waitUntil(processVerifyRequest(ctx, { userId, email }));
  return { ok: true as const };
}

export async function removeMyEmail(ctx: ServiceContext, userId: string, rawEmail: string) {
  const email = strictEmail(rawEmail);
  if (!email) throw new ValidationError('Enter a valid email address.', [], 'EMAIL_INVALID');
  const user = await repo.getUser(ctx.env.DB, userId);
  if (user?.primary_email === email) {
    throw new ConflictError('The primary email cannot be removed.', 'PRIMARY_EMAIL');
  }
  if (!(await repo.removeEmail(ctx.env.DB, userId, email))) {
    throw new NotFoundError('Email not found.', 'EMAIL_NOT_FOUND');
  }
  await recordAudit(ctx, {
    actorType: 'user',
    actorId: userId,
    action: 'user.email_remove',
    targetType: 'user',
    targetId: userId,
  });
  return listMyEmails(ctx, userId);
}

/** Sign-in emails go to another of my verified addresses. */
export async function makeMyEmailPrimary(ctx: ServiceContext, userId: string, rawEmail: string) {
  const email = strictEmail(rawEmail);
  if (!email) throw new ValidationError('Enter a valid email address.', [], 'EMAIL_INVALID');
  if (!(await repo.setPrimaryEmail(ctx.env.DB, userId, email))) {
    throw new NotFoundError('Email not found.', 'EMAIL_NOT_FOUND');
  }
  await recordAudit(ctx, {
    actorType: 'user',
    actorId: userId,
    action: 'user.email_primary',
    targetType: 'user',
    targetId: userId,
  });
  return listMyEmails(ctx, userId);
}

export async function listMySessions(ctx: ServiceContext, userId: string, currentId: string) {
  const rows = await repo.listLiveSessions(ctx.env.DB, userId, ctx.clock.now());
  return {
    items: rows.map((s) => ({
      id: s.id_hash,
      createdAt: s.created_at,
      lastSeenAt: s.last_seen_at,
      userAgent: s.user_agent,
      current: s.id_hash === currentId,
    })),
  };
}

export async function revokeMySession(ctx: ServiceContext, userId: string, sessionId: string) {
  const row = await repo.getSession(ctx.env.DB, sessionId);
  if (!row || row.user_id !== userId)
    throw new NotFoundError('Session not found.', 'SESSION_NOT_FOUND');
  await revokeOne(ctx, sessionId);
  await recordAudit(ctx, {
    actorType: 'user',
    actorId: userId,
    action: 'session.revoke',
    targetType: 'user',
    targetId: userId,
  });
  return { ok: true as const };
}

export async function revokeAllMySessions(ctx: ServiceContext, userId: string) {
  const count = await revokeAllForUser(ctx, userId);
  await recordAudit(ctx, {
    actorType: 'user',
    actorId: userId,
    action: 'user.sessions_revoke',
    targetType: 'user',
    targetId: userId,
    detail: { count },
  });
  return { ok: true as const };
}
