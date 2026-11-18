import type { Mode } from '../../../shared/contracts/common.ts';
import { read } from '../../platform/counters.ts';
import { EMAIL_ORG_DAILY_CAP, EMAIL_RECIPIENT_HOURLY_CAP } from './issuance-intent.ts';
import { recipientKey } from './recipient-key.ts';

const DAY = 86_400_000;
const HOUR = 3_600_000;

/** Pass emails the org can still queue today (the counter `issuance-intent.ts` charges). Reads only. */
export async function orgEmailBudget(
  db: D1Database,
  mode: Mode,
  orgId: string,
  now: number,
): Promise<number> {
  const used = await read(db, `pass-email:${mode}:org:${orgId}`, now - (now % DAY));
  return Math.max(0, EMAIL_ORG_DAILY_CAP - used);
}

/** Pass emails this address can still get this hour (the counter `issuance-intent.ts` charges). Reads only. */
export async function recipientEmailBudget(
  env: object & { DB: D1Database },
  mode: Mode,
  to: string,
  now: number,
): Promise<number> {
  const used = await read(
    env.DB,
    `pass-email:${mode}:to:${await recipientKey(env, to)}`,
    now - (now % HOUR),
  );
  return Math.max(0, EMAIL_RECIPIENT_HOURLY_CAP - used);
}
