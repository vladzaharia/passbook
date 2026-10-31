import { renderSignInEmail } from '../../email/sign-in.ts';
import { baseUrl } from '../../platform/env.ts';
import { BadRequestError, ForbiddenError, UnavailableError } from '../../platform/errors.ts';
import { safeEqual, sha256Hex } from '../../platform/ids.ts';
import { checkRateLimit } from '../../platform/rate-limit.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { createEmailBindingMailer, type Mailer } from '../delivery/mailer.ts';
import { getPlatformSettings } from '../settings/service.ts';
import * as repo from './magic-repo.ts';
import {
  type PendingIdentity,
  type SignInContext,
  type SignInResult,
  signInMagicLink,
  verifyEmailForUser,
} from './service.ts';

export const MAGIC_TTL_MS = 15 * 60 * 1000;
export const MAX_CODE_ATTEMPTS = 5;
const DEFAULT_DAILY_CAP = 2000;
const EMAIL_HOURLY_CAP = 5;
const CODE_FAILURE_CAP = 10;
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

const invalid = () =>
  new BadRequestError('This link or code is invalid or expired.', 'LINK_INVALID');

const hashCode = (tokenHash: string, code: string) => sha256Hex(`${tokenHash}:${code}`);

export interface IssueInput {
  email: string;
  purpose: repo.MagicPurpose;
  userId: string | null;
  /** Hash of the browser-binding cookie; sign_in codes work only from that browser. */
  bindingHash: string | null;
  next: string | null;
  /** verify_email: shown in the mail and on the confirm page. */
  requester?: string | null;
  /** Pocket ID identity to link when this sign_in link is consumed. */
  pendingIdentity?: PendingIdentity | null;
}

export async function withinCaps(ctx: ServiceContext, email: string): Promise<boolean> {
  const now = ctx.clock.now();
  const emailKey = (await sha256Hex(`magic-email:${email}`)).slice(0, 32);
  if (!(await checkRateLimit(ctx.env, 'RL_MAGIC_LINK', `email:${emailKey}`))) return false;
  const perEmail = await repo.bumpCounter(
    ctx.env.DB,
    `magic:email:${emailKey}`,
    now - (now % HOUR),
  );
  return perEmail <= EMAIL_HOURLY_CAP;
}

/** Counted only for addresses that would receive mail, so strangers cannot burn the cap. */
export async function withinDailyCap(ctx: ServiceContext): Promise<boolean> {
  const now = ctx.clock.now();
  const cap = Number(ctx.env.MAGIC_LINK_DAILY_CAP) || DEFAULT_DAILY_CAP;
  return (await repo.bumpCounter(ctx.env.DB, 'magic:daily', now - (now % DAY))) <= cap;
}

/** Creates the link and sends it. Callers decide whether the address is eligible. */
export async function issueMagicLink(
  ctx: ServiceContext,
  input: IssueInput,
  mailer: Mailer = createEmailBindingMailer(ctx.env),
): Promise<void> {
  const now = ctx.clock.now();
  const token = ctx.ids.token(32);
  const tokenHash = await sha256Hex(token);
  const code = input.purpose === 'sign_in' ? ctx.ids.code(6) : null;
  await repo.insertLink(ctx.env.DB, {
    tokenHash,
    email: input.email,
    purpose: input.purpose,
    userId: input.userId,
    codeHash: code ? await hashCode(tokenHash, code) : null,
    bindingHash: input.bindingHash,
    redirectPath: input.next,
    pendingIdentity: input.pendingIdentity ? JSON.stringify(input.pendingIdentity) : null,
    now,
    expiresAt: now + MAGIC_TTL_MS,
  });
  const mail = renderSignInEmail({
    purpose: input.purpose,
    link: `${baseUrl(ctx.env)}/auth/magic?t=${token}`,
    code: code ?? undefined,
    expiresMinutes: MAGIC_TTL_MS / 60_000,
    ...(input.requester ? { requester: input.requester } : {}),
  });
  const { 'email.senderName': fromName } = await getPlatformSettings(ctx);
  await mailer.send({ to: input.email, fromName, ...mail });
}

/**
 * Public sign-in request, run after the 202 is returned so every address costs the caller the
 * same. Sends only to known addresses and stays silent when throttled.
 */
export async function processSignInRequest(
  ctx: ServiceContext,
  input: { email: string; bindingHash: string; next: string | null },
): Promise<void> {
  try {
    // Unknown addresses are dropped first so they never spend a victim's or the global budget.
    if (!(await repo.isKnownAddress(ctx.env.DB, input.email))) return;
    if (!(await withinCaps(ctx, input.email))) {
      ctx.log.warn('auth.magic_throttled', {});
      return;
    }
    if (!(await withinDailyCap(ctx))) {
      ctx.log.warn('auth.magic_daily_cap', {});
      return;
    }
    await issueMagicLink(ctx, { ...input, purpose: 'sign_in', userId: null });
    ctx.log.info('auth.magic_sent', { purpose: 'sign_in' });
  } catch (error) {
    ctx.log.error('auth.magic_send_failed', { error });
  }
}

/**
 * Verification request from a signed-in user. Runs after the response; the caller always answers
 * the same. Sends to unowned addresses only, under the same caps as public sign-in.
 */
export async function processVerifyRequest(
  ctx: ServiceContext,
  input: { userId: string; email: string },
): Promise<void> {
  try {
    if (await repo.isOwnedByOther(ctx.env.DB, input.email, input.userId)) {
      ctx.log.info('me.email_add_taken', { userId: input.userId });
      return;
    }
    if (!(await withinCaps(ctx, input.email))) {
      ctx.log.warn('auth.magic_throttled', {});
      return;
    }
    if (!(await withinDailyCap(ctx))) {
      ctx.log.warn('auth.magic_daily_cap', {});
      return;
    }
    await issueMagicLink(ctx, {
      email: input.email,
      purpose: 'verify_email',
      userId: input.userId,
      bindingHash: null,
      next: '/account',
      requester: await repo.primaryEmailOf(ctx.env.DB, input.userId),
    });
  } catch (error) {
    ctx.log.error('auth.magic_send_failed', { error });
  }
}

export async function peekMagicLink(ctx: ServiceContext, token: string) {
  const link = await repo.peekLink(ctx.env.DB, await sha256Hex(token), ctx.clock.now());
  if (!link) return null;
  const requester =
    link.purpose === 'verify_email' && link.user_id
      ? await repo.primaryEmailOf(ctx.env.DB, link.user_id)
      : null;
  return { email: link.email, purpose: link.purpose, requester };
}

async function requireSignInEnabled(ctx: ServiceContext) {
  if (!(await getPlatformSettings(ctx))['auth.magicLinkEnabled']) {
    throw new UnavailableError('Email sign-in is off.', 'MAGIC_LINK_DISABLED');
  }
}

export type MagicOutcome =
  | { kind: 'signed_in'; result: SignInResult; next: string | null }
  | { kind: 'verified'; next: string | null };

async function finish(
  ctx: ServiceContext,
  link: repo.MagicLinkRow,
  sign: SignInContext,
): Promise<MagicOutcome> {
  if (link.purpose === 'verify_email') {
    if (!link.user_id) throw invalid();
    await verifyEmailForUser(ctx, link.user_id, link.email);
    return { kind: 'verified', next: link.redirect_path };
  }
  const pending = link.pending_identity
    ? (JSON.parse(link.pending_identity) as PendingIdentity)
    : undefined;
  const result = await signInMagicLink(ctx, link.email, sign, pending);
  return { kind: 'signed_in', result, next: link.redirect_path };
}

export async function consumeMagicToken(
  ctx: ServiceContext,
  token: string,
  sign: SignInContext,
  bindingCookie?: string,
): Promise<MagicOutcome> {
  const tokenHash = await sha256Hex(token);
  const peeked = await repo.peekLink(ctx.env.DB, tokenHash, ctx.clock.now());
  if (!peeked) throw invalid();
  if (peeked.purpose === 'sign_in' && !peeked.pending_identity) await requireSignInEnabled(ctx);
  // The click grants the address to the account that asked, so only that account's browser may confirm.
  if (peeked.purpose === 'verify_email' && sign.sessionUserId !== peeked.user_id) {
    throw new ForbiddenError('Sign in as the account that asked first.', 'SESSION_REQUIRED');
  }
  // A Pocket ID identity links only from the browser that signed in with it.
  if (
    peeked.pending_identity &&
    !(
      bindingCookie &&
      peeked.browser_binding_hash &&
      (await safeEqual(await sha256Hex(bindingCookie), peeked.browser_binding_hash))
    )
  ) {
    throw invalid();
  }
  const link = await repo.consumeLink(ctx.env.DB, tokenHash, ctx.clock.now());
  if (!link) throw invalid();
  return finish(ctx, link, sign);
}

export async function consumeMagicCode(
  ctx: ServiceContext,
  input: { email: string; code: string; bindingCookie: string | undefined },
  sign: SignInContext,
): Promise<MagicOutcome> {
  if (!input.bindingCookie) throw invalid();
  const db = ctx.env.DB;
  const now = ctx.clock.now();
  const failKey = `magic:fail:${(await sha256Hex(input.email)).slice(0, 32)}`;
  const windowStart = now - (now % DAY);
  // Failures count across links, so reissuing a link does not reset the guess budget.
  if ((await repo.readCounter(db, failKey, windowStart)) >= CODE_FAILURE_CAP) throw invalid();
  const link = await repo.findLinkForCode(
    db,
    input.email,
    await sha256Hex(input.bindingCookie),
    now,
  );
  if (!link?.code_hash) throw invalid();
  if (!link.pending_identity) await requireSignInEnabled(ctx);
  if (!(await repo.spendAttempt(db, link.token_hash, MAX_CODE_ATTEMPTS))) throw invalid();
  if (!(await safeEqual(await hashCode(link.token_hash, input.code), link.code_hash))) {
    await repo.bumpCounter(db, failKey, windowStart);
    throw invalid();
  }
  const consumed = await repo.consumeLink(db, link.token_hash, now);
  if (!consumed) throw invalid();
  return finish(ctx, consumed, sign);
}
