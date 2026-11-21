import { PassBuildError } from '../../../passkit/build.ts';
import { JOIN_NAME_MESSAGE, JoinSubmitSchema } from '../../../shared/contracts/join.ts';
import { JOIN_COPY } from '../../../shared/copy/join.ts';
import { EMAIL_INVALID_MESSAGE } from '../../../shared/email.ts';
import { TURNSTILE_JOIN_ACTION } from '../../../shared/turnstile.ts';
import { revealToken } from '../../platform/capability-token.ts';
import { AppError } from '../../platform/errors.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
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
import type { JoinOutcome } from './outcome.ts';
import { deviceIssue, type PublicLink } from './repo-issues.ts';
import { afterRefusal, issueForEmail, lookupLink, refuse } from './submit-after.ts';

const MINUTE = 60 * 1000;
/** A double tap or the back button: the same device with the same fields gets its card again. */
const REPLAY_MS = 10 * MINUTE;
/** Cloudflare's documented maximum for a Turnstile response. */
const TURNSTILE_TOKEN_MAX = 2048;

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
  // One mail slot per request, spent whether the address already has a card or not.
  const mail = email !== undefined ? await mailWithinBudget(ctx, email) : false;
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
  if (email !== undefined) {
    // Known and new addresses get one answer; the card or the re-sent mail follows by email only.
    const keys = { ipKey, deviceKey: await deviceKeyOf(env, ctx.ids.token(32)), fieldsHash };
    ctx.waitUntil(
      issueForEmail(ctx, link, open, input, {
        token: req.token,
        email,
        mail,
        orgDailyCap: limits.orgDailyCap,
        keys,
      }),
    );
    return { kind: 'check_email', link, email };
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
