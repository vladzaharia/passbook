import { sha256Hex } from '../../platform/ids.ts';
import { checkRateLimit } from '../../platform/rate-limit.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import * as repo from './magic-repo.ts';

export const DEFAULT_DAILY_CAP = 2000;
export const EMAIL_HOURLY_CAP = 5;
export const IP_DAILY_CAP = 30;
export const VERIFY_USER_DAILY_CAP = 10;
const HOUR = 60 * 60 * 1000;
export const DAY = 24 * HOUR;

export const dailyCapOf = (env: { MAGIC_LINK_DAILY_CAP?: string }): number =>
  Number(env.MAGIC_LINK_DAILY_CAP) || DEFAULT_DAILY_CAP;

export const dayStart = (now: number): number => now - (now % DAY);

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
  return (await repo.bumpCounter(ctx.env.DB, 'magic:daily', dayStart(now))) <= dailyCapOf(ctx.env);
}

/** Per-network sends for known addresses. Requests with no usable address are not capped. */
export async function withinIpCap(ctx: ServiceContext, prefix: string | null): Promise<boolean> {
  if (!prefix) return true;
  const key = `magic:ip:${await sha256Hex(prefix)}`;
  const now = ctx.clock.now();
  return (await repo.bumpCounter(ctx.env.DB, key, dayStart(now))) <= IP_DAILY_CAP;
}

/** Verification mails one signed-in user may trigger per day, whatever the address. */
export async function withinVerifyUserCap(ctx: ServiceContext, userId: string): Promise<boolean> {
  const now = ctx.clock.now();
  const count = await repo.bumpCounter(ctx.env.DB, `magic:verify:user:${userId}`, dayStart(now));
  return count <= VERIFY_USER_DAILY_CAP;
}
