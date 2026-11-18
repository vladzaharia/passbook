import { EMAIL_LIMIT_COPY } from '../../../shared/copy/email.ts';
import { AppError } from '../../platform/errors.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { getOrgSettings } from '../settings/service.ts';
import { readCounter } from './repo-email-queue.ts';

const DAY = 86_400_000;

/** The org's caps from its settings; the schema supplies the defaults (3 per hour, 500 per day). */
export async function emailCaps(ctx: ServiceContext, orgId: string) {
  const settings = await getOrgSettings(ctx, orgId);
  return {
    recipientCap: settings['email.recipientCapPerHour'],
    orgCap: settings['email.orgCapPerDay'],
  };
}

/** The 429 for a refused queue: names the cap that was hit (`limit` is `org` or `recipient`). */
export async function emailLimitError(
  ctx: ServiceContext,
  mode: 'live' | 'test',
  orgId: string,
): Promise<AppError> {
  const now = ctx.clock.now();
  const { orgCap } = await emailCaps(ctx, orgId);
  const used = await readCounter(ctx.env.DB, `pass-email:${mode}:org:${orgId}`, now - (now % DAY));
  const limit = used >= orgCap ? 'org' : 'recipient';
  return new AppError('EMAIL_RATE_LIMITED', 429, EMAIL_LIMIT_COPY[limit], {
    headers: { 'retry-after': limit === 'org' ? '86400' : '3600' },
    issues: [{ path: 'limit', message: limit }],
  });
}
