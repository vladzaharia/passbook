import type { Personalization } from '../../../passkit/types.ts';
import type { JoinCode } from '../../../shared/contracts/join.ts';
import { writeEvent } from '../../platform/analytics.ts';
import { tokenKeys } from '../../platform/capability-token.ts';
import { AppError } from '../../platform/errors.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { countPlatformCard } from './caps.ts';
import { createJoinCard, type OpenRelease } from './issue.ts';
import type { JoinOutcome } from './outcome.ts';
import { activeCardFor, linkByToken, type PublicLink } from './repo-issues.ts';
import { queueResend } from './resend.ts';

const TOKEN_SHAPE = /^[A-Za-z0-9_-]{22}$/;

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

/** A refusal of the create batch: the grant's reason says what the visitor sees. */
export async function afterRefusal(
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

/**
 * An address's card, after the browser has its answer: a known address is re-mailed, a new one gets a card and the mail.
 * Run off the request, so the response, status and timing are the same for both.
 */
export async function issueForEmail(
  ctx: ServiceContext,
  link: PublicLink,
  open: OpenRelease,
  input: Personalization,
  o: {
    token: string;
    email: string;
    mail: boolean;
    orgDailyCap: number;
    keys: Parameters<typeof createJoinCard>[4]['keys'];
  },
): Promise<void> {
  const existing = await activeCardFor(ctx.env.DB, link, o.email);
  if (existing) return resendDuplicate(ctx, link, existing, o.mail);
  try {
    await createJoinCard(ctx, link, open, input, {
      email: o.email,
      mail: o.mail,
      orgDailyCap: o.orgDailyCap,
      keys: o.keys,
    });
    await countPlatformCard(ctx);
  } catch (error) {
    if (!(error instanceof AppError)) throw error;
    await afterRefusal(ctx, link, o.token, o.email, o.mail, error);
  }
}
