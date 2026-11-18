import { EMAIL_LIMIT_COPY } from '../../../shared/copy/email.ts';
import { AppError } from '../../platform/errors.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { getOrgSettings } from '../settings/service.ts';
import { recipientKey } from './recipient-key.ts';
import { readCounter } from './repo-email-queue.ts';

const DAY = 86_400_000;
const HOUR = 3_600_000;

/** The org's caps from its settings; the schema supplies the defaults (3 per hour, 500 per day). */
export async function emailCaps(ctx: ServiceContext, orgId: string) {
  const settings = await getOrgSettings(ctx, orgId);
  return {
    recipientCap: settings['email.recipientCapPerHour'],
    orgCap: settings['email.orgCapPerDay'],
  };
}

/** The cap that is used up, or null. Without a recipient, an unreached org cap reads as the recipient's. */
export async function limitReached(
  ctx: ServiceContext,
  mode: 'live' | 'test',
  orgId: string,
  to?: string,
): Promise<'org' | 'recipient' | null> {
  const now = ctx.clock.now();
  const caps = await emailCaps(ctx, orgId);
  const db = ctx.env.DB;
  const org = await readCounter(db, `pass-email:${mode}:org:${orgId}`, now - (now % DAY));
  if (org >= caps.orgCap) return 'org';
  if (!to) return 'recipient';
  const key = `pass-email:${mode}:to:${await recipientKey(ctx.env, to)}`;
  const used = await readCounter(db, key, now - (now % HOUR));
  return used >= caps.recipientCap ? 'recipient' : null;
}

/** The 429 for a refused queue: names the cap that was hit (`limit` is `org` or `recipient`). */
export async function emailLimitError(
  ctx: ServiceContext,
  mode: 'live' | 'test',
  orgId: string,
): Promise<AppError> {
  const limit = (await limitReached(ctx, mode, orgId)) ?? 'recipient';
  return new AppError('EMAIL_RATE_LIMITED', 429, EMAIL_LIMIT_COPY[limit], {
    headers: { 'retry-after': limit === 'org' ? '86400' : '3600' },
    issues: [{ path: 'limit', message: limit }],
  });
}
