import { writeEvent } from '../../platform/analytics.ts';
import type { Amr, Role } from '../../platform/auth.ts';
import { envString } from '../../platform/env.ts';
import { ForbiddenError } from '../../platform/errors.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { recordAudit } from '../audit/service.ts';
import { attachWaitingPassesForEmail } from '../holders/service.ts';
import * as repo from './repo.ts';
import { createSession, hashSessionCookie, type NewSession, revokeOne } from './sessions.ts';

export const OIDC_PROVIDER = 'pocketid';

export interface OidcClaims {
  sub: string;
  email?: string;
  name?: string;
  emailVerified: boolean;
  groups: string[];
}

export interface SignInContext {
  ipPrefix: string | null;
  userAgent: string | null;
  /** Cookie value of a session the browser already holds; revoked on login. */
  previousCookie?: string;
  /** User of the live session the browser holds, if any. */
  sessionUserId?: string | null;
  /** Hash of a fresh browser-binding cookie, set by the caller if the proof mail is sent. */
  bindingHash?: string | null;
  next?: string | null;
}

/** A Pocket ID identity waiting for email proof before it is linked to an existing account. */
export interface PendingIdentity {
  provider: string;
  subject: string;
  emailClaim: string;
  emailVerified: boolean;
  groups: string[];
}

export interface SignInResult {
  userId: string;
  roles: Role[];
  session: NewSession;
}

/** Unset group variables grant nothing. */
export function rolesFromGroups(env: object, groups: readonly string[]): Role[] {
  const admin = envString(env, 'OIDC_ADMIN_GROUP');
  const user = envString(env, 'OIDC_USER_GROUP');
  if (admin && groups.includes(admin)) return ['admin', 'user'];
  if (user && groups.includes(user)) return ['user'];
  return [];
}

export async function startSession(
  ctx: ServiceContext,
  userId: string,
  roles: Role[],
  amr: Amr,
  name: string | null,
  sign: SignInContext,
): Promise<SignInResult> {
  if (sign.previousCookie) await revokeOne(ctx, await hashSessionCookie(sign.previousCookie));
  const session = await createSession(ctx, {
    userId,
    roles,
    amr,
    ipPrefix: sign.ipPrefix,
    userAgent: sign.userAgent,
  });
  await repo.recordLogin(ctx.env.DB, userId, roles, name, ctx.clock.now());
  writeEvent(ctx.env, { event: 'auth.sign_in', outcome: amr });
  await recordAudit(ctx, {
    actorType: 'user',
    actorId: userId,
    action: 'auth.sign_in',
    targetType: 'user',
    targetId: userId,
    ipPrefix: sign.ipPrefix,
    detail: { amr, roles },
  });
  return { userId, roles, session };
}

export async function auditIdentityLinked(
  ctx: ServiceContext,
  userId: string,
  via: 'trusted_email' | 'mail_proof' | 'new_user',
  emailVerified: boolean,
): Promise<void> {
  await recordAudit(ctx, {
    actorType: 'user',
    actorId: userId,
    action: 'auth.identity_linked',
    targetType: 'user',
    targetId: userId,
    detail: { provider: OIDC_PROVIDER, via, emailVerified },
  });
}

export async function createUser(ctx: ServiceContext, email: string, name: string | null) {
  await repo.insertUser(ctx.env.DB, { id: ctx.ids.id(), name, email, now: ctx.clock.now() });
  const user = await repo.findUserByPrimaryEmail(ctx.env.DB, email);
  if (!user) throw new Error('user insert lost');
  return user;
}

/** Magic-link sign-in for an email the browser just proved. Grants `user` only. */
export async function signInMagicLink(
  ctx: ServiceContext,
  email: string,
  sign: SignInContext,
  pending?: PendingIdentity,
): Promise<SignInResult> {
  const db = ctx.env.DB;
  let user =
    (await repo.findUserByEmail(db, email)) ?? (await repo.findUserByPrimaryEmail(db, email));
  if (!user) user = await createUser(ctx, email, null);
  if (user.status !== 'active') throw new ForbiddenError('Account disabled.', 'ACCOUNT_DISABLED');
  const { ownerId } = await repo.addUserEmail(db, email, user.id, 'magic_link', ctx.clock.now());
  if (ownerId !== user.id) throw new ForbiddenError('Email conflict.', 'EMAIL_CONFLICT');
  if (pending) {
    await repo.insertIdentity(db, { ...pending, userId: user.id, now: ctx.clock.now() });
    await auditIdentityLinked(ctx, user.id, 'mail_proof', pending.emailVerified);
  }
  const result = await startSession(ctx, user.id, ['user'], 'magic_link', null, sign);
  await attachWaitingPassesForEmail(ctx, user.id, email);
  return result;
}

/** Adds a proven email to the account that asked for it. */
export async function verifyEmailForUser(
  ctx: ServiceContext,
  userId: string,
  email: string,
): Promise<void> {
  const user = await repo.getUser(ctx.env.DB, userId);
  if (user?.status !== 'active') {
    throw new ForbiddenError('Account disabled.', 'ACCOUNT_DISABLED');
  }
  const { ownerId } = await repo.addUserEmail(
    ctx.env.DB,
    email,
    userId,
    'magic_link',
    ctx.clock.now(),
  );
  if (ownerId !== userId) {
    throw new ForbiddenError('That address belongs to another account.', 'EMAIL_TAKEN');
  }
  await recordAudit(ctx, {
    actorType: 'user',
    actorId: userId,
    action: 'user.email_verified',
    targetType: 'user',
    targetId: userId,
  });
  await attachWaitingPassesForEmail(ctx, userId, email);
}

export const BREAKGLASS_PROVIDER = 'breakglass';
const BREAKGLASS_EMAIL = 'breakglass@wallet.invalid';

/**
 * Admin sign-in that does not depend on Pocket ID. The token itself is checked by the handler;
 * this only resolves the dedicated user, refusing it when an admin has disabled it.
 */
export async function signInBreakglass(
  ctx: ServiceContext,
  sign: SignInContext,
): Promise<SignInResult> {
  const linked = await repo.findIdentity(ctx.env.DB, BREAKGLASS_PROVIDER, BREAKGLASS_PROVIDER);
  let userId = linked?.user_id;
  if (!userId) {
    const user =
      (await repo.findUserByPrimaryEmail(ctx.env.DB, BREAKGLASS_EMAIL)) ??
      (await createUser(ctx, BREAKGLASS_EMAIL, 'Break-glass admin'));
    await repo.insertIdentity(ctx.env.DB, {
      provider: BREAKGLASS_PROVIDER,
      subject: BREAKGLASS_PROVIDER,
      userId: user.id,
      emailClaim: null,
      emailVerified: false,
      groups: [],
      now: ctx.clock.now(),
    });
    userId = user.id;
  }
  const user = await repo.getUser(ctx.env.DB, userId);
  if (user?.status !== 'active') {
    throw new ForbiddenError('Break-glass sign-in is disabled.', 'BREAKGLASS_DISABLED');
  }
  const result = await startSession(ctx, user.id, ['admin', 'user'], 'breakglass', user.name, sign);
  await recordAudit(ctx, {
    actorType: 'user',
    actorId: user.id,
    action: 'auth.breakglass_used',
    targetType: 'user',
    targetId: user.id,
    ipPrefix: sign.ipPrefix,
  });
  return result;
}
