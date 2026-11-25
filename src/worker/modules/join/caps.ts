import { withinLimitValue } from '../../../shared/contracts/entitlements.ts';
import { bump } from '../../platform/counters.ts';
import { entitlementsOf } from '../../platform/entitlements.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { recipientKey } from '../delivery/recipient-key.ts';
import { getPlatformSettings } from '../settings/service.ts';
import { orgIssuedToday, type PublicLink, rollingCount } from './repo-issues.ts';
import { issuedToday, type JoinLinkRow } from './repo-links.ts';

const HOUR = 60 * 60 * 1000;
const DAY = 24 * 60 * 60 * 1000;
/** Cards one network prefix may take from one link in an hour: loose, since a venue's Wi-Fi shares one. */
export const PREFIX_HOURLY_CAP = 60;
/** Join mails (new or re-sent) one address gets per 24 hours, platform-wide. */
export const MAIL_DAILY_CAP = 3;
/** Test links hold fewer cards a day than live ones. */
export const TEST_ORG_CAP = 200;

const windowOf = (now: number, size: number) => now - (now % size);

export interface PlatformLimits {
  enabled: boolean;
  orgDailyCap: number;
  platformDailyCap: number;
}

/** The platform's join settings, read at request time; a test link's org cap is the test cap. */
export async function platformLimits(
  ctx: ServiceContext,
  mode: PublicLink['mode'],
): Promise<PlatformLimits> {
  const s = await getPlatformSettings(ctx);
  return {
    enabled: s['join.enabled'],
    orgDailyCap: mode === 'test' ? TEST_ORG_CAP : s['join.orgDailyCap'],
    platformDailyCap: s['join.platformDailyCap'],
  };
}

/** One more attempt from this network on this link; true while the hour's count is within the cap. */
export async function prefixWithinCap(
  ctx: ServiceContext,
  linkId: string,
  ipKey: string,
): Promise<boolean> {
  const now = ctx.clock.now();
  return (
    (await bump(ctx.env.DB, `join:ip:${linkId}:${ipKey}`, windowOf(now, HOUR))) <= PREFIX_HOURLY_CAP
  );
}

const rolling = (ctx: ServiceContext, key: string) =>
  rollingCount(ctx.env.DB, key, ctx.clock.now() - DAY);

const spend = (ctx: ServiceContext, key: string) =>
  bump(ctx.env.DB, key, windowOf(ctx.clock.now(), HOUR));

const PLATFORM_KEY = 'join:platform';

/** The platform breaker is open while the rolling 24 hours hold fewer cards than the cap. */
export async function platformOpen(ctx: ServiceContext, cap: number): Promise<boolean> {
  return (await rolling(ctx, PLATFORM_KEY)) < cap;
}

/** A card was made: only cards count against the breaker, never refusals or duplicates. */
export async function countPlatformCard(ctx: ServiceContext): Promise<void> {
  await spend(ctx, PLATFORM_KEY);
}

/**
 * The per-link, per-org and plan (`join.perDay`) counts, read before the pass is built so a flood at the cap does not sign and
 * store a card each time. The grant's checks stay the exact fence; this one only saves the work.
 */
export async function withinCaps(
  ctx: ServiceContext,
  link: Pick<PublicLink, 'id' | 'orgId' | 'mode' | 'dailyLimit'>,
  orgDailyCap: number,
): Promise<boolean> {
  const now = ctx.clock.now();
  const row: Pick<JoinLinkRow, 'id' | 'orgId' | 'mode'> = link;
  const [perLink, perOrg, plan] = await Promise.all([
    issuedToday(ctx.env.DB, row, now),
    orgIssuedToday(ctx.env.DB, link.orgId, link.mode, now),
    entitlementsOf(ctx, link.orgId),
  ]);
  return (
    perLink < link.dailyLimit &&
    perOrg < orgDailyCap &&
    withinLimitValue(plan['join.perDay'], perOrg)
  );
}

/**
 * One join mail to this mailbox (a new card's or a re-sent one): true while it is within its three per
 * rolling 24 hours. The key is the canonical mailbox, so `+tag` and Gmail dot variants share it.
 * Spent once per request; the card is made and shown either way.
 */
export async function mailWithinBudget(ctx: ServiceContext, email: string): Promise<boolean> {
  const key = `join-email:${await recipientKey(ctx.env, email)}`;
  if ((await rolling(ctx, key)) >= MAIL_DAILY_CAP) return false;
  await spend(ctx, key);
  return true;
}
