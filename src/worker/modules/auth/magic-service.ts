import { renderSignInEmail } from '../../email/sign-in.ts';
import { baseUrl } from '../../platform/env.ts';
import { BadRequestError } from '../../platform/errors.ts';
import { safeEqual, sha256Hex } from '../../platform/ids.ts';
import { checkRateLimit } from '../../platform/rate-limit.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { createEmailBindingMailer, type Mailer } from '../delivery/mailer.ts';
import { getPlatformSettings } from '../settings/service.ts';
import * as repo from './magic-repo.ts';
import {
  type SignInContext,
  type SignInResult,
  signInMagicLink,
  verifyEmailForUser,
} from './service.ts';

export const MAGIC_TTL_MS = 15 * 60 * 1000;
export const MAX_CODE_ATTEMPTS = 5;
const DEFAULT_DAILY_CAP = 2000;
const EMAIL_HOURLY_CAP = 5;
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
}

async function withinCaps(ctx: ServiceContext, email: string): Promise<boolean> {
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
async function withinDailyCap(ctx: ServiceContext): Promise<boolean> {
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
    now,
    expiresAt: now + MAGIC_TTL_MS,
  });
  const mail = renderSignInEmail({
    purpose: input.purpose,
    link: `${baseUrl(ctx.env)}/auth/magic?t=${token}`,
    code: code ?? undefined,
    expiresMinutes: MAGIC_TTL_MS / 60_000,
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
    if (!(await withinCaps(ctx, input.email))) {
      ctx.log.warn('auth.magic_throttled', {});
      return;
    }
    if (!(await repo.isKnownAddress(ctx.env.DB, input.email))) return;
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

export async function peekMagicLink(ctx: ServiceContext, token: string) {
  const link = await repo.peekLink(ctx.env.DB, await sha256Hex(token), ctx.clock.now());
  return link ? { email: link.email, purpose: link.purpose } : null;
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
  const result = await signInMagicLink(ctx, link.email, sign);
  return { kind: 'signed_in', result, next: link.redirect_path };
}

export async function consumeMagicToken(
  ctx: ServiceContext,
  token: string,
  sign: SignInContext,
): Promise<MagicOutcome> {
  const link = await repo.consumeLink(ctx.env.DB, await sha256Hex(token), ctx.clock.now());
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
  const link = await repo.findLinkForCode(
    db,
    input.email,
    await sha256Hex(input.bindingCookie),
    ctx.clock.now(),
  );
  if (!link?.code_hash) throw invalid();
  if (!(await repo.spendAttempt(db, link.token_hash, MAX_CODE_ATTEMPTS))) throw invalid();
  if (!(await safeEqual(await hashCode(link.token_hash, input.code), link.code_hash)))
    throw invalid();
  const consumed = await repo.consumeLink(db, link.token_hash, ctx.clock.now());
  if (!consumed) throw invalid();
  return finish(ctx, consumed, sign);
}
