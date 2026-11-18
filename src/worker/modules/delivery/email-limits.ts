import { EMAIL_LIMIT_COPY } from '../../../shared/copy/email.ts';
import { AppError } from '../../platform/errors.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { getOrgSettings, getPlatformSettings } from '../settings/service.ts';
import { recipientKey } from './recipient-key.ts';
import { readCounter } from './repo-email-queue.ts';

const DAY = 86_400_000;
const HOUR = 3_600_000;

/** One address may get this many pass emails an hour across all orgs. Not a setting. */
export const PLATFORM_RECIPIENT_HOURLY_CAP = 10;

/** The org's caps from its settings (3 per hour, 500 per day by default); the day cap is clamped to the platform's. */
export async function emailCaps(ctx: ServiceContext, orgId: string) {
  const [settings, platform] = await Promise.all([
    getOrgSettings(ctx, orgId),
    getPlatformSettings(ctx),
  ]);
  return {
    recipientCap: settings['email.recipientCapPerHour'],
    orgCap: Math.min(settings['email.orgCapPerDay'], platform['email.orgCapPerDayMax']),
  };
}

/** The counters for one pass email to one address: per org, per org-and-address, and platform-wide. */
export async function emailRate(
  ctx: ServiceContext,
  mode: 'live' | 'test',
  orgId: string,
  to: string,
) {
  const now = ctx.clock.now();
  const digest = await recipientKey(ctx.env, to);
  return {
    recipientKey: `pass-email:${mode}:org:${orgId}:to:${digest}`,
    orgKey: `pass-email:${mode}:org:${orgId}`,
    recipientWindow: now - (now % HOUR),
    orgWindow: now - (now % DAY),
    ...(await emailCaps(ctx, orgId)),
    platformKey: `pass-email:${mode}:to:${digest}`,
    platformWindow: now - (now % HOUR),
    platformCap: PLATFORM_RECIPIENT_HOURLY_CAP,
  };
}

/**
 * The org-visible cap that is used up, or null. The platform ceiling is null on purpose: it is
 * shared across orgs, so naming it would tell one org about another's mail.
 */
export async function limitReached(
  ctx: ServiceContext,
  mode: 'live' | 'test',
  orgId: string,
  to: string,
): Promise<'org' | 'recipient' | null> {
  const rate = await emailRate(ctx, mode, orgId, to);
  const db = ctx.env.DB;
  if ((await readCounter(db, rate.orgKey, rate.orgWindow)) >= rate.orgCap) return 'org';
  if ((await readCounter(db, rate.recipientKey, rate.recipientWindow)) >= rate.recipientCap)
    return 'recipient';
  return null;
}

/** The 429 for a refused queue: the org's own cap by name, the platform ceiling generically. */
export async function emailLimitError(
  ctx: ServiceContext,
  mode: 'live' | 'test',
  orgId: string,
  to: string,
): Promise<AppError> {
  const limit = await limitReached(ctx, mode, orgId, to);
  return new AppError(
    'EMAIL_RATE_LIMITED',
    429,
    limit ? EMAIL_LIMIT_COPY[limit] : 'Too many pass emails. Try again later.',
    {
      headers: { 'retry-after': limit === 'org' ? '86400' : '3600' },
      ...(limit ? { issues: [{ path: 'limit', message: limit }] } : {}),
    },
  );
}
