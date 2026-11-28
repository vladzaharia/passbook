import { isUnverifiedEmail, knownEmail, maskEmail, normalizeEmail } from '../../../shared/email.ts';
import { identityLinkedEmail } from '../../email/identity-linked.ts';
import { baseUrl } from '../../platform/env.ts';
import { ForbiddenError, IdpEmailNotPrimaryError } from '../../platform/errors.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { auditStmtWhere } from '../audit/repo.ts';
import { recordAudit } from '../audit/service.ts';
import { createEmailBindingMailer } from '../delivery/mailer.ts';
import { getPlatformSettings } from '../settings/service.ts';
import * as repo from './repo.ts';
import * as claims from './repo-claims.ts';

export async function createUser(ctx: ServiceContext, email: string, name: string | null) {
  const id = ctx.ids.id();
  await repo.insertUser(ctx.env.DB, { id, name, email, now: ctx.clock.now() });
  const user = await repo.findUserByPrimaryEmail(ctx.env.DB, email);
  if (!user) throw new Error('user insert lost');
  // Another request took the address between our lookup and insert: do not sign into its account.
  if (user.id !== id) throw new ForbiddenError('Email conflict.', 'EMAIL_CONFLICT');
  return user;
}

/** What a Polaris ID email that names an account without auto-linking needs next. */
export interface PrimaryCheck {
  kind: 'ok' | 'prove' | 'lifted';
  /** `prove` for another account's secondary address: audited once the mail passes its caps. */
  probedOwnerId?: string;
}

/** A refused or probed Polaris ID claim on an address that is not an account's main email. */
export async function auditEmailNotPrimary(
  ctx: ServiceContext,
  ownerId: string,
  proven: boolean,
): Promise<void> {
  ctx.log.warn('auth.oidc_email_not_primary', { code: 'IDP_EMAIL_NOT_PRIMARY', userId: ownerId });
  await recordAudit(ctx, {
    actorType: 'system',
    action: 'auth.oidc_email_not_primary',
    targetType: 'user',
    targetId: ownerId,
    detail: { code: 'IDP_EMAIL_NOT_PRIMARY', proven },
  });
}

/**
 * A Polaris ID email that matches an account only through a secondary address (or a primary an email
 * session moved) creates and binds nothing. Unproven (no mail proof, provider not trusted), nothing
 * is said about the account: the address is mailed. Then:
 * - the address is the member's own primary, moved by an email session, it is the address their
 *   membership invitation named, and the account has no identity at all: the mail proof lifts the
 *   fence (`lifted`) and the subject links;
 * - otherwise the person is told the main email, masked.
 */
export async function checkPrimaryOwner(
  ctx: ServiceContext,
  email: string,
  state: { trust: boolean; mailProven: boolean },
): Promise<PrimaryCheck> {
  const db = ctx.env.DB;
  if (await repo.findUserByProvenEmail(db, email, { primaryOnly: true })) return { kind: 'ok' };
  const owner = await repo.findUserByEmail(db, email);
  if (!owner) return { kind: 'ok' };
  const movedPrimary =
    owner.status === 'active' &&
    normalizeEmail(owner.primary_email) === normalizeEmail(email) &&
    owner.primary_set_amr === 'magic_link' &&
    !(await claims.hasAnyIdentity(db, owner.id)) &&
    (await claims.invitedAs(db, owner.id, email));
  if (movedPrimary) return { kind: state.mailProven ? 'lifted' : 'prove' };
  if (!state.trust && !state.mailProven) return { kind: 'prove', probedOwnerId: owner.id };
  await auditEmailNotPrimary(ctx, owner.id, true);
  const primary = knownEmail(owner.primary_email);
  throw new IdpEmailNotPrimaryError(primary ? maskEmail(primary) : 'your main email');
}

/** The browser's current session, as far as a claim on an address cares. */
export interface ClaimSession {
  sessionUserId?: string | null;
  sessionAmr?: string | null;
}

/**
 * The proving browser is the claimant's own: its session was made by Pocket ID (a mail-link session
 * can be planted by anyone who can get a victim to open a link) and the provider's claim names
 * this very address.
 */
async function isOwnSession(
  ctx: ServiceContext,
  claimantId: string,
  email: string,
  sign: ClaimSession,
): Promise<boolean> {
  return (
    sign.sessionUserId === claimantId &&
    sign.sessionAmr === 'oidc' &&
    (await repo.identityClaims(ctx.env.DB, claimantId, email))
  );
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
  sign: ClaimSession = {},
  options: { primaryOnly?: boolean } = {},
): Promise<repo.UserRow> {
  return (
    (await repo.findUserByProvenEmail(ctx.env.DB, email, options)) ??
    (await createUserForProvenEmail(ctx, email, name, sign))
  );
}

/** For an address with no proven owner: handles any unproven claimant, else creates the account. */
export async function createUserForProvenEmail(
  ctx: ServiceContext,
  email: string,
  name: string | null,
  sign: ClaimSession = {},
): Promise<repo.UserRow> {
  const claimant = await repo.findUserByPrimaryEmail(ctx.env.DB, email);
  if (claimant) {
    if (claimant.status !== 'active') {
      ctx.log.warn('auth.claimant_disabled', { code: 'CLAIMANT_DISABLED', userId: claimant.id });
      throw new ForbiddenError('Account disabled.', 'ACCOUNT_DISABLED');
    }
    if (await isOwnSession(ctx, claimant.id, email, sign)) return claimant;
    await releaseClaim(ctx, claimant.id, email);
  }
  return createUser(ctx, email, name);
}

/** The account that owns an address its holder just proved by mail; the address is recorded on it. */
export async function accountProvenByMail(
  ctx: ServiceContext,
  email: string,
  sign: ClaimSession,
  options: { primaryOnly?: boolean } = {},
) {
  const db = ctx.env.DB;
  const user = await accountForProvenEmail(ctx, email, null, sign, options);
  if (user.status !== 'active') throw new ForbiddenError('Account disabled.', 'ACCOUNT_DISABLED');
  const { ownerId } = await repo.addUserEmail(db, email, user.id, 'magic_link', ctx.clock.now());
  if (ownerId !== user.id) throw new ForbiddenError('Email conflict.', 'EMAIL_CONFLICT');
  await repo.adoptPrimaryEmail(db, user.id, email, 'magic_link');
  return user;
}

/**
 * A fenced account gets a Polaris ID through a mail proof alone: the identity and its audit row are
 * one batch (the row exists exactly when the identity does); then every other verified address is told.
 */
export async function linkLifted(
  ctx: ServiceContext,
  row: Parameters<typeof repo.insertIdentityStmt>[1],
): Promise<boolean> {
  const db = ctx.env.DB;
  const audit = auditStmtWhere(
    db,
    ctx,
    {
      actorType: 'system',
      action: 'auth.identity_linked_moved_primary',
      targetType: 'user',
      targetId: row.userId,
      detail: { provider: row.provider, subject: row.subject },
    },
    repo.IDENTITY_LINKED_SQL,
    [row.provider, row.subject, row.userId],
  );
  const [inserted] = await db.batch([repo.insertIdentityStmt(db, row, true), audit]);
  return (inserted?.meta.changes ?? 0) > 0;
}

export async function announceLiftedLink(
  ctx: ServiceContext,
  userId: string,
  proofEmail: string,
): Promise<void> {
  const mailer = createEmailBindingMailer(ctx.env);
  const { 'email.senderName': fromName } = await getPlatformSettings(ctx);
  const mail = identityLinkedEmail(baseUrl(ctx.env));
  for (const { email } of await repo.emailsOf(ctx.env.DB, userId)) {
    if (email === proofEmail || isUnverifiedEmail(email)) continue;
    try {
      await mailer.send({ to: email, fromName, ...mail });
    } catch (error) {
      ctx.log.error('auth.identity_linked_notice_failed', { code: 'NOTICE_FAILED', error });
    }
  }
}
