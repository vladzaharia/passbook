import { strictEmail } from '../../../shared/email.ts';
import { writeEvent } from '../../platform/analytics.ts';
import type { Amr, Role } from '../../platform/auth.ts';
import { envString } from '../../platform/env.ts';
import { ForbiddenError } from '../../platform/errors.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { recordAudit } from '../audit/service.ts';
import { attachWaitingPassesForEmail } from '../holders/service.ts';
import { getPlatformSettings } from '../settings/service.ts';
import { issueMagicLink, withinCaps, withinDailyCap } from './magic-service.ts';
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

async function startSession(
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

async function createUser(ctx: ServiceContext, email: string, name: string | null) {
  await repo.insertUser(ctx.env.DB, { id: ctx.ids.id(), name, email, now: ctx.clock.now() });
  const user = await repo.findUserByPrimaryEmail(ctx.env.DB, email);
  if (!user) throw new Error('user insert lost');
  return user;
}

/**
 * trustEmail off: an unlinked identity whose email belongs to an account proves the address by
 * mail. The link works only from this browser and links the identity when consumed.
 */
async function sendIdentityProof(
  ctx: ServiceContext,
  ownerId: string,
  email: string,
  claims: OidcClaims,
  sign: SignInContext,
): Promise<never> {
  const conflict = () => new ForbiddenError('Email conflict.', 'EMAIL_CONFLICT');
  if (!sign.bindingHash) throw conflict();
  if (!(await withinCaps(ctx, email)) || !(await withinDailyCap(ctx))) {
    ctx.log.warn('auth.magic_throttled', { userId: ownerId });
    throw conflict();
  }
  await issueMagicLink(ctx, {
    email,
    purpose: 'sign_in',
    userId: null,
    bindingHash: sign.bindingHash,
    next: sign.next ?? null,
    pendingIdentity: {
      provider: OIDC_PROVIDER,
      subject: claims.sub,
      emailClaim: email,
      emailVerified: claims.emailVerified,
      groups: claims.groups,
    },
  });
  throw new ForbiddenError('Check your email.', 'EMAIL_PROOF_SENT');
}

/** Pocket ID sign-in. Identity is (provider, subject); email only links per `oidc.trustEmail`. */
export async function signInOidc(
  ctx: ServiceContext,
  claims: OidcClaims,
  sign: SignInContext,
): Promise<SignInResult> {
  const db = ctx.env.DB;
  const roles = rolesFromGroups(ctx.env, claims.groups);
  if (roles.length === 0) throw new ForbiddenError('No access.', 'NO_ACCESS');
  const email = strictEmail(claims.email);
  if (!email) throw new ForbiddenError('The account has no usable email.', 'NO_EMAIL');
  const { 'oidc.trustEmail': trust } = await getPlatformSettings(ctx);

  const identity = await repo.findIdentity(db, OIDC_PROVIDER, claims.sub);
  let user = identity ? await repo.getUser(db, identity.user_id) : null;
  if (!user) {
    const owner =
      (await repo.findUserByEmail(db, email)) ?? (await repo.findUserByPrimaryEmail(db, email));
    if (owner && !trust) {
      if (owner.status !== 'active') {
        throw new ForbiddenError('Account disabled.', 'ACCOUNT_DISABLED');
      }
      await sendIdentityProof(ctx, owner.id, email, claims, sign);
    }
    user = owner ?? (await createUser(ctx, email, claims.name ?? null));
  }
  if (user.status !== 'active') throw new ForbiddenError('Account disabled.', 'ACCOUNT_DISABLED');

  const identityRow = {
    provider: OIDC_PROVIDER,
    subject: claims.sub,
    emailClaim: email,
    emailVerified: claims.emailVerified,
    groups: claims.groups,
    now: ctx.clock.now(),
  };
  if (identity) await repo.updateIdentity(db, identityRow);
  else await repo.insertIdentity(db, { ...identityRow, userId: user.id });

  let verified = false;
  if (trust) {
    const { ownerId } = await repo.addUserEmail(db, email, user.id, 'oidc', ctx.clock.now());
    verified = ownerId === user.id;
    if (!verified) ctx.log.warn('auth.oidc_email_conflict', { userId: user.id });
  } else {
    verified = (await repo.emailsOf(db, user.id)).some((e) => e.email === email);
  }

  const result = await startSession(ctx, user.id, roles, 'oidc', claims.name ?? null, sign);
  if (verified) await attachWaitingPassesForEmail(ctx, user.id, email);
  return result;
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
  if (!user || user.status !== 'active') {
    throw new ForbiddenError('Break-glass sign-in is disabled.', 'BREAKGLASS_DISABLED');
  }
  return startSession(ctx, user.id, ['admin', 'user'], 'breakglass', user.name, sign);
}
