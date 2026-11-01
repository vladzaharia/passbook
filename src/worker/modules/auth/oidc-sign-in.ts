import { strictEmail } from '../../../shared/email.ts';
import { ForbiddenError } from '../../platform/errors.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { attachWaitingPassesForEmail } from '../holders/service.ts';
import { getPlatformSettings } from '../settings/service.ts';
import { withinCaps, withinDailyCap } from './magic-caps.ts';
import { issueMagicLink } from './magic-service.ts';
import * as repo from './repo.ts';
import {
  auditIdentityLinked,
  createUser,
  OIDC_PROVIDER,
  type OidcClaims,
  rolesFromGroups,
  type SignInContext,
  type SignInResult,
  startSession,
} from './service.ts';

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
  const { 'oidc.trustEmail': setting } = await getPlatformSettings(ctx);
  // The setting is not enough: the provider must also assert that it verified the address.
  const trust = setting && claims.emailVerified === true;

  const identity = await repo.findIdentity(db, OIDC_PROVIDER, claims.sub);
  let user = identity ? await repo.getUser(db, identity.user_id) : null;
  let linkVia: 'trusted_email' | 'new_user' = 'new_user';
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
    linkVia = owner ? 'trusted_email' : 'new_user';
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
  else {
    await repo.insertIdentity(db, { ...identityRow, userId: user.id });
    await auditIdentityLinked(ctx, user.id, linkVia, claims.emailVerified);
  }

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
