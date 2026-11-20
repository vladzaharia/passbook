import type { EntitlementValue } from '../../../shared/contracts/entitlements.ts';
import { EMAIL_LIMIT_COPY } from '../../../shared/copy/email.ts';
import { entitlementsOf } from '../../platform/entitlements.ts';
import { AppError } from '../../platform/errors.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { getOrgSettings, getPlatformSettings } from '../settings/service.ts';
import { recipientKey } from './recipient-key.ts';
import { readCounter } from './repo-email-queue.ts';

const DAY = 86_400_000;
const HOUR = 3_600_000;

/** One address gets this many pass emails an hour across all orgs; more wait for the next hour. Not a setting. */
export const PLATFORM_RECIPIENT_HOURLY_CAP = 10;
const MAX_DEFER_HOURS = 24;

/** The plan's `email.perDay` as a count: `null` has no cap; a missing or invalid value allows none. */
const planCap = (value: EntitlementValue | undefined): number =>
  value === null ? Number.POSITIVE_INFINITY : typeof value === 'number' ? value : 0;

/**
 * The org's caps from its settings (3 per hour, 500 per day by default); the day cap is clamped to the
 * platform's and to the plan's `email.perDay`. The queue grant re-reads the plan's cap at commit.
 */
export async function emailCaps(ctx: ServiceContext, orgId: string) {
  const [settings, platform, plan] = await Promise.all([
    getOrgSettings(ctx, orgId),
    getPlatformSettings(ctx),
    entitlementsOf(ctx, orgId),
  ]);
  return {
    recipientCap: settings['email.recipientCapPerHour'],
    orgCap: Math.min(
      settings['email.orgCapPerDay'],
      platform['email.orgCapPerDayMax'],
      planCap(plan['email.perDay']),
    ),
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
  // Over the platform ceiling the mail waits for the first hour with room, never a refusal.
  const platformKey = `pass-email:${mode}:to:${digest}`;
  let platformWindow = now - (now % HOUR);
  for (
    let i = 0;
    i < MAX_DEFER_HOURS &&
    (await readCounter(ctx.env.DB, platformKey, platformWindow)) >= PLATFORM_RECIPIENT_HOURLY_CAP;
    i++
  )
    platformWindow += HOUR;
  return {
    recipientKey: `pass-email:${mode}:org:${orgId}:to:${digest}`,
    orgKey: `pass-email:${mode}:org:${orgId}`,
    recipientWindow: now - (now % HOUR),
    orgWindow: now - (now % DAY),
    ...(await emailCaps(ctx, orgId)),
    platformKey,
    platformWindow,
    platformCap: PLATFORM_RECIPIENT_HOURLY_CAP,
    platformAvailableAt: platformWindow > now - (now % HOUR) ? platformWindow : 0,
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
