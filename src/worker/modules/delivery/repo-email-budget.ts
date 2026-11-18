import type { Mode } from '../../../shared/contracts/common.ts';
import { read } from '../../platform/counters.ts';
import { EMAIL_ORG_DAILY_CAP } from './issuance-intent.ts';

const DAY = 86_400_000;

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
