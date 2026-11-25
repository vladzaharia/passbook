import { isStrongAmr } from '../../../shared/sign-in.ts';
import { writeEvent } from '../../platform/analytics.ts';
import type { Amr, Role } from '../../platform/auth.ts';
import { envString } from '../../platform/env.ts';
import { ForbiddenError } from '../../platform/errors.ts';
import type { Logger } from '../../platform/log.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { recordAudit } from '../audit/service.ts';
import { attachWaitingPassesForEmail } from '../holders/service-attach.ts';
import {
  accountProvenByMail,
  announceLiftedLink,
  checkPrimaryOwner,
  createUser,
  linkLifted,
  releaseClaimOtherThan,
} from './account-claims.ts';
import * as repo from './repo.ts';
import { bumpCounter } from './repo-magic.ts';
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
  /** How that session was made (`oidc`, `magic_link`, ...). */
  sessionAmr?: string | null;
  /** Roles of that session. */
  sessionRoles?: Role[];
  /** Hash of a fresh browser-binding cookie, set by the caller if the proof mail is sent. */
  bindingHash?: string | null;
  next?: string | null;
  /** The provider's authentication time (ms), kept on the session. */
  authTime?: number;
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

const groupKey = (name: string) =>
  name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_]/g, '_');

const csv = (value: string | undefined) =>
  (value ?? '')
    .split(',')
    .map((part) => part.trim())
    .filter((part) => part.length > 0);

/** The exact names a group variable holds (a comma list); empty when unset. */
export const configuredNames = (env: object, variable: string) => csv(envString(env, variable));

/** Lowest role first: a name configured twice grants only the lowest of its variables. */
const GROUP_VARIABLES = [
  'OIDC_USER_GROUP',
  'OIDC_DEVELOPER_GROUP',
  'OIDC_ADMIN_GROUP',
  'OIDC_PLATFORM_ADMIN_GROUP',
] as const;

/**
 * A claim matches a configured group name exactly, case included. Each `OIDC_*_GROUP` var holds one
 * name or a comma list of exact names (the rename window: old and new name side by side); every
 * alias grants the same role. A name configured in more than one variable grants only the lowest
 * role among them and logs `GROUP_CONFIGURED_TWICE`. If Polaris ID normalises a group's name in the
 * claim (`passbook_developers`), set the variable to that name. Unset variables grant nothing.
 *
 * Platform admins get everything. The admin group carries `console` (it opens the console where
 * `OIDC_CONSOLE_GROUP_REQUIRED` is on; which orgs is in-app membership). While
 * `OIDC_PLATFORM_ADMIN_SUBJECTS` is not empty, platform admin also needs `subject` on that list;
 * a group member who is not listed gets no admin (and nothing it implies).
 */
export function rolesFromGroups(
  env: object,
  groups: readonly string[],
  log?: Pick<Logger, 'warn'>,
  subject?: string,
): Role[] {
  const lowest = new Map<string, string>();
  for (const variable of GROUP_VARIABLES)
    for (const name of configuredNames(env, variable)) {
      const first = lowest.get(name);
      if (first === undefined) lowest.set(name, variable);
      else if (first !== variable && groups.includes(name))
        log?.warn('auth.oidc_group_duplicate', {
          code: 'GROUP_CONFIGURED_TWICE',
          configured: name,
          variables: [first, variable],
        });
    }
  const has = (variable: string) => {
    let matched = false;
    for (const name of configuredNames(env, variable)) {
      if (groups.includes(name)) {
        if (lowest.get(name) === variable) matched = true;
        continue;
      }
      // Grants nothing: a group that matches only after the old normalising is a config mistake to fix.
      const near = groups.find((group) => group !== name && groupKey(group) === groupKey(name));
      if (near !== undefined)
        log?.warn('auth.oidc_group_near_miss', {
          code: 'GROUP_NEAR_MISS',
          received: near,
          configured: name,
        });
    }
    return matched;
  };
  const pinned = csv(envString(env, 'OIDC_PLATFORM_ADMIN_SUBJECTS'));
  const pinOk = pinned.length === 0 || (subject !== undefined && pinned.includes(subject));
  const platform = has('OIDC_PLATFORM_ADMIN_GROUP') && pinOk;
  const developer = platform || has('OIDC_DEVELOPER_GROUP');
  const console = platform || has('OIDC_ADMIN_GROUP');
  if (!(console || developer || has('OIDC_USER_GROUP'))) return [];
  const roles: Role[] = [];
  if (platform) roles.push('admin');
  roles.push('user');
  if (developer) roles.push('developer');
  if (console) roles.push('console');
  return roles;
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
    ...(sign.authTime === undefined ? {} : { authTime: sign.authTime }),
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

/** An email link used in a browser that already holds the same person's strong session: nothing changes. */
export interface KeptSession {
  userId: string;
  roles: Role[];
  session: null;
}

/**
 * Magic-link sign-in for an email the browser just proved. Grants `user` only. A browser holding the
 * same user's strong session keeps it: the link must never swap Polaris ID access for email access.
 */
export async function signInMagicLink(
  ctx: ServiceContext,
  email: string,
  sign: SignInContext,
): Promise<SignInResult | KeptSession> {
  const user = await accountProvenByMail(ctx, email, sign);
  if (sign.sessionUserId === user.id && sign.sessionAmr && isStrongAmr(sign.sessionAmr)) {
    await attachWaitingPassesForEmail(ctx, user.id, email);
    return { userId: user.id, roles: sign.sessionRoles ?? ['user'], session: null };
  }
  const result = await startSession(ctx, user.id, ['user'], 'magic_link', null, sign);
  await attachWaitingPassesForEmail(ctx, user.id, email);
  return result;
}

/**
 * Links a Pocket ID subject to the account of an address it just proved by mail. No session: the
 * caller sends the browser back through Pocket ID, so the sign-in that follows carries the
 * subject's group roles rather than the `user` role a mail link grants.
 */
export async function linkIdentityByMail(
  ctx: ServiceContext,
  email: string,
  pending: PendingIdentity,
  sign: SignInContext,
): Promise<void> {
  const { kind } = await checkPrimaryOwner(ctx, email, { trust: false, mailProven: true });
  const lifted = kind === 'lifted';
  const user = await accountProvenByMail(ctx, email, sign, { primaryOnly: !lifted });
  const row = { ...pending, userId: user.id, now: ctx.clock.now() };
  const linked = lifted ? await linkLifted(ctx, row) : await repo.insertIdentity(ctx.env.DB, row);
  if (lifted && !linked) throw new ForbiddenError('Email conflict.', 'EMAIL_CONFLICT');
  if (linked) {
    await auditIdentityLinked(ctx, user.id, 'mail_proof', pending.emailVerified);
    if (lifted) await announceLiftedLink(ctx, user.id, email);
  }
  await attachWaitingPassesForEmail(ctx, user.id, email);
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
  await releaseClaimOtherThan(ctx, userId, email);
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
  await repo.adoptPrimaryEmail(ctx.env.DB, userId, email, 'magic_link');
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

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const FAILURE_ROWS_PER_HOUR = 100;

/** Audits a wrong token, capped per hour so guessing cannot flood the log; the day count is exact. */
export async function recordBreakglassFailure(
  ctx: ServiceContext,
  prefix: string | null,
): Promise<void> {
  const now = ctx.clock.now();
  await bumpCounter(ctx.env.DB, 'breakglass:fail', now - (now % DAY));
  const rows = await bumpCounter(ctx.env.DB, 'audit:breakglass_failed', now - (now % HOUR));
  if (rows > FAILURE_ROWS_PER_HOUR + 1) return;
  if (rows === FAILURE_ROWS_PER_HOUR + 1) {
    ctx.log.error('auth.breakglass_failed_capped', { code: 'BREAKGLASS_FAILURE_CAP' });
    return;
  }
  await recordAudit(ctx, {
    actorType: 'system',
    action: 'auth.breakglass_failed',
    ipPrefix: prefix,
    detail: { reason: 'wrong_token' },
  });
}

export type NewOidcFlow = Parameters<typeof repo.insertFlow>[1];

/** Stores the secrets of one sign-in attempt until its callback arrives. */
export const saveOidcFlow = (ctx: ServiceContext, flow: NewOidcFlow) =>
  repo.insertFlow(ctx.env.DB, flow);

/** One-shot: a flow can be consumed once, from the browser that started it, before it expires. */
export const takeOidcFlow = (ctx: ServiceContext, stateHash: string, bindingHash: string) =>
  repo.consumeFlow(ctx.env.DB, stateHash, bindingHash, ctx.clock.now());

export const findUser = (ctx: ServiceContext, userId: string) => repo.getUser(ctx.env.DB, userId);
