import { PassBuildError } from '../../../passkit/build.ts';
import {
  JOIN_NAME_MESSAGE,
  type JoinCode,
  JoinSubmitSchema,
} from '../../../shared/contracts/join.ts';
import { JOIN_COPY } from '../../../shared/copy/join.ts';
import { EMAIL_INVALID_MESSAGE } from '../../../shared/email.ts';
import { TURNSTILE_JOIN_ACTION } from '../../../shared/turnstile.ts';
import { writeEvent } from '../../platform/analytics.ts';
import { revealToken, tokenKeys } from '../../platform/capability-token.ts';
import { AppError } from '../../platform/errors.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import type { Refusal } from '../../ssr/join-page.tsx';
import { verifyTurnstile } from '../auth/turnstile.ts';
import { getPass } from '../passes/repo-read-pass.ts';
import {
  countPlatformCard,
  mailWithinBudget,
  type PlatformLimits,
  platformLimits,
  platformOpen,
  prefixWithinCap,
  withinCaps,
} from './caps.ts';
import { deviceKeyOf, fieldsHashOf, ipKeyOf } from './cookie.ts';
import { assembleInput, createJoinCard, type OpenRelease, openRelease } from './issue.ts';
import { activeCardFor, deviceIssue, linkByToken, type PublicLink } from './repo-issues.ts';
import { queueResend } from './resend.ts';

const MINUTE = 60 * 1000;
/** A double tap or the back button: the same device with the same fields gets its card again. */
const REPLAY_MS = 10 * MINUTE;
/** Cloudflare's documented maximum for a Turnstile response. */
const TURNSTILE_TOKEN_MAX = 2048;
const TOKEN_SHAPE = /^[A-Za-z0-9_-]{22}$/;

export type JoinOutcome =
  | { kind: 'card'; token: string; device: string }
  | { kind: 'check_email'; link: PublicLink; email: string }
  | {
      kind: 'form';
      link: PublicLink;
      /** Whether the form asks for a name: decided from the release, as the page is. */
      askName: boolean;
      error: string;
      values: { name: string; email: string };
      /** 403 for a failed Turnstile check; else 422. */
      status?: 403;
    }
  | { kind: 'refused'; reason: Refusal; link: PublicLink | null };

export interface SubmitRequest {
  token: string;
  /** The urlencoded fields exactly as posted; a repeated field is refused. */
  fields: URLSearchParams;
  ip: string;
  /** The network (v4 /24, v6 /64) of the request. */
  prefix: string;
  /** The device cookie value, when the browser sent one this server made. */
  device: string | undefined;
}

/** A link a presented token names, or null for an unknown or rotated token. */
export async function lookupLink(ctx: ServiceContext, token: string): Promise<PublicLink | null> {
  if (!TOKEN_SHAPE.test(token)) return null;
  return linkByToken(ctx.env.DB, await tokenKeys(ctx.env, 'join', token));
}

/** One refusal: a stable code in the log and in analytics, no name, address, token or network. */
export function refuse(
  ctx: ServiceContext,
  link: PublicLink | null,
  code: JoinCode,
  level: 'warn' | 'error' = 'warn',
): void {
  ctx.log[level]('join.refused', {
    code,
    ...(link ? { linkId: link.id, orgId: link.orgId, mode: link.mode } : {}),
  });
  writeEvent(
    ctx.env,
    {
      event: 'join.refused',
      orgId: link?.orgId ?? null,
      outcome: code,
      mode: link?.mode ?? 'live',
    },
    ctx.log,
  );
}

/** Why a link takes no new cards right now, or null when it is open. */
export function closedReason(link: PublicLink, limits: PlatformLimits): 'closed' | null {
  return limits.enabled && link.enabled && link.orgActive && link.templateActive ? null : 'closed';
}

interface Parsed {
  name: string | undefined;
  email: string | undefined;
  turnstile: string | undefined;
  /** What was typed, to put back in the form. */
  raw: { name: string; email: string };
}

/** The strict form of the link: only the fields it asks for, each once. An error is one sentence for the form. */
function parseForm(
  link: PublicLink,
  askName: boolean,
  fields: URLSearchParams,
): Parsed | { error: string; raw: Parsed['raw'] } {
  const seen = new Map<string, string>();
  let repeated = false;
  for (const [key, value] of fields) {
    if (seen.has(key)) repeated = true;
    seen.set(key, value);
  }
  const raw = { name: seen.get('name') ?? '', email: seen.get('email') ?? '' };
  const turnstile = seen.get('cf-turnstile-response');
  seen.delete('cf-turnstile-response');
  // Cloudflare's tokens stay within 2048 characters; anything longer is no token.
  const parsed = JoinSubmitSchema.omit({ 'cf-turnstile-response': true }).safeParse(
    Object.fromEntries(seen),
  );
  if (repeated || !parsed.success) {
    const paths = parsed.success ? [] : parsed.error.issues.map((i) => i.path[0]);
    const error = paths.includes('email')
      ? EMAIL_INVALID_MESSAGE
      : paths.includes('name')
        ? JOIN_NAME_MESSAGE
        : 'Check the form and try again.';
    return { error, raw };
  }
  const { name, email } = parsed.data;
  // The link takes what it asks for and nothing else.
  if (email !== undefined && !link.askEmail) return { error: 'Check the form and try again.', raw };
  if (askName ? name === undefined : name !== undefined) return { error: JOIN_NAME_MESSAGE, raw };
  return { name, email, turnstile, raw };
}

async function cardOf(ctx: ServiceContext, passId: string): Promise<string | null> {
  const pass = await getPass(ctx.env.DB, passId);
  // A card staff voided or removed since it was made is not handed back.
  if (pass?.status !== 'active' || pass.removedAt !== null) return null;
  try {
    return await revealToken(ctx.env, 'pass', pass.id, pass.orgId, pass.downloadToken);
  } catch (error) {
    if (error instanceof AppError && error.code.startsWith('TOKEN_SEAL_')) return null;
    throw error;
  }
}

/** The address already has a card here: mail it (within the address's daily budget) and tell the browser nothing more. */
async function resendDuplicate(
  ctx: ServiceContext,
  link: PublicLink,
  passId: string,
  mail: boolean,
): Promise<void> {
  ctx.log.info('join.duplicate', {
    code: 'JOIN_DUPLICATE',
    linkId: link.id,
    orgId: link.orgId,
    mode: link.mode,
  });
  if (mail) await queueResend(ctx, passId, link.id);
  else refuse(ctx, link, 'JOIN_EMAIL_CAPPED');
}

/** The grant's own refusals, as the design maps them (refusals that are the caller's own bug stay errors). */
const CLOSED_CODES = new Set([
  'JOIN_NOT_READY',
  'TEMPLATE_RELEASE_REQUIRED',
  'TEMPLATE_RELEASE_CONFLICT',
  'TEMPLATE_NOT_FOUND',
  'ORG_ACCESS_CHANGED',
  'ORG_NOT_FOUND',
  'CREATE_STALE',
]);

/**
 * POST /j/:token after the request-level checks (rate limit, origin, body). The order is the design's:
 * link, form, replay, device, Turnstile, network count, platform breaker, duplicate, readiness, caps, create.
 */
export async function submitJoin(ctx: ServiceContext, req: SubmitRequest): Promise<JoinOutcome> {
  const link = await lookupLink(ctx, req.token);
  if (!link) return { kind: 'refused', reason: 'expired', link: null };
  const limits = await platformLimits(ctx, link.mode);
  if (closedReason(link, limits)) {
    refuse(ctx, link, 'JOIN_LINK_CLOSED');
    return { kind: 'refused', reason: 'closed', link };
  }
  let open: OpenRelease | null;
  try {
    open = await openRelease(ctx, link);
  } catch (error) {
    if (!(error instanceof AppError) || error.status >= 500) throw error;
    open = null;
  }
  if (!open) {
    refuse(ctx, link, 'JOIN_NOT_READY', 'error');
    return { kind: 'refused', reason: 'closed', link };
  }
  const askName = open.readiness.nameInput !== null;
  const form = parseForm(link, askName, req.fields);
  if ('error' in form) return { kind: 'form', link, askName, error: form.error, values: form.raw };
  const { name, email } = form;
  const env = ctx.env;
  const now = ctx.clock.now();
  const deviceKey = req.device ? await deviceKeyOf(env, req.device) : null;
  const fieldsHash = await fieldsHashOf(env, link.id, name ?? '', email ?? '');
  // The same device and fields within ten minutes get the card they made; any other card today is the device limit.
  const prior = deviceKey ? await deviceIssue(env.DB, link.id, deviceKey, now) : null;
  if (prior && req.device) {
    if (prior.fieldsHash === fieldsHash && now - prior.createdAt < REPLAY_MS) {
      const token = await cardOf(ctx, prior.passId);
      if (token) {
        ctx.log.info('join.replay', {
          code: 'JOIN_REPLAY',
          linkId: link.id,
          orgId: link.orgId,
          mode: link.mode,
        });
        return { kind: 'card', token, device: req.device };
      }
    }
    refuse(ctx, link, 'JOIN_DEVICE_LIMIT');
    return { kind: 'refused', reason: 'device_limit', link };
  }
  if (
    !form.turnstile ||
    form.turnstile.length > TURNSTILE_TOKEN_MAX ||
    !(await verifyTurnstile(env, form.turnstile, req.ip, ctx.log, fetch, TURNSTILE_JOIN_ACTION))
  ) {
    refuse(ctx, link, 'JOIN_TURNSTILE_FAILED');
    return {
      kind: 'form',
      link,
      askName,
      error: JOIN_COPY.refusal.turnstile,
      values: form.raw,
      status: 403,
    };
  }
  const ipKey = await ipKeyOf(env, link.id, req.prefix);
  if (!(await prefixWithinCap(ctx, link.id, ipKey))) {
    refuse(ctx, link, 'JOIN_IP_LIMIT');
    return { kind: 'refused', reason: 'too_many', link };
  }
  if (!(await platformOpen(ctx, limits.platformDailyCap))) {
    refuse(ctx, link, 'JOIN_PLATFORM_CAP', 'error');
    return { kind: 'refused', reason: 'closed', link };
  }
  // One mail slot per request, spent here whether the address gets a re-sent card or a new one.
  const mail = email !== undefined ? await mailWithinBudget(ctx, email) : false;
  if (email !== undefined) {
    const existing = await activeCardFor(env.DB, link, email);
    if (existing) {
      await resendDuplicate(ctx, link, existing, mail);
      return { kind: 'check_email', link, email };
    }
  }
  // Both caps are read before the card is built; the grant's checks stay the exact fence.
  if (!(await withinCaps(ctx, link, limits.orgDailyCap))) {
    refuse(ctx, link, 'JOIN_LIMIT');
    return { kind: 'refused', reason: 'daily_limit', link };
  }
  let input: ReturnType<typeof assembleInput>;
  try {
    input = assembleInput(open, name, ctx.ids);
  } catch (error) {
    if (error instanceof PassBuildError && error.code === 'INVALID_INPUT')
      return { kind: 'form', link, askName, error: JOIN_NAME_MESSAGE, values: form.raw };
    throw error;
  }
  const device = req.device ?? ctx.ids.token(32);
  try {
    const card = await createJoinCard(ctx, link, open, input, {
      email: email ?? null,
      mail,
      orgDailyCap: limits.orgDailyCap,
      keys: { ipKey, deviceKey: deviceKey ?? (await deviceKeyOf(env, device)), fieldsHash },
    });
    await countPlatformCard(ctx);
    return { kind: 'card', token: card.token, device };
  } catch (error) {
    if (!(error instanceof AppError)) throw error;
    return afterRefusal(ctx, link, req.token, email, mail, error);
  }
}

/** A refusal of the create batch: the grant's reason says what the visitor sees. */
async function afterRefusal(
  ctx: ServiceContext,
  link: PublicLink,
  token: string,
  email: string | undefined,
  mail: boolean,
  error: AppError,
): Promise<JoinOutcome> {
  switch (error.code) {
    case 'JOIN_LINK_CLOSED':
      // Switched off since the lookup: closed. Rotated or deleted: the token no longer finds a link.
      refuse(ctx, link, 'JOIN_LINK_CLOSED');
      return {
        kind: 'refused',
        reason: (await lookupLink(ctx, token)) ? 'closed' : 'expired',
        link,
      };
    case 'JOIN_LIMIT':
      refuse(ctx, link, 'JOIN_LIMIT');
      return { kind: 'refused', reason: 'daily_limit', link };
    case 'JOIN_DUPLICATE': {
      // An equal address committed first: the same answer as the duplicate check.
      const existing = email ? await activeCardFor(ctx.env.DB, link, email) : null;
      if (email && existing) {
        await resendDuplicate(ctx, link, existing, mail);
        return { kind: 'check_email', link, email };
      }
      refuse(ctx, link, 'JOIN_LINK_CLOSED');
      return { kind: 'refused', reason: 'closed', link };
    }
    default:
      if (!CLOSED_CODES.has(error.code)) throw error;
      refuse(ctx, link, 'JOIN_NOT_READY', 'error');
      return { kind: 'refused', reason: 'closed', link };
  }
}
