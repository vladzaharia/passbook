import { bump } from '../../platform/counters.ts';
import { orgEmailBudget } from '../delivery/repo-email-budget.ts';
import type { StuckImport } from './repo-import-commit.ts';

const DAY = 86_400_000;
const key = (mode: string, orgId: string) => `pass-import-email:${mode}:org:${orgId}`;
const windowOf = (at: number) => at - (at % DAY);

/**
 * Takes up to `want` of the org's remaining pass emails for this import. Concurrent imports share the
 * reservation counter, so together they never claim more than the day's budget; the overflow is created
 * without mail and listed as not emailed.
 */
export async function reserveImportEmail(
  db: D1Database,
  mode: 'live' | 'test',
  orgId: string,
  now: number,
  want: number,
): Promise<number> {
  if (want <= 0) return 0;
  const left = await orgEmailBudget(db, mode, orgId, now);
  const wanted = Math.min(want, left);
  const total = await bump(db, key(mode, orgId), windowOf(now), wanted);
  const granted = Math.max(0, Math.min(wanted, left - (total - wanted)));
  if (granted < wanted) await bump(db, key(mode, orgId), windowOf(now), granted - wanted);
  return granted;
}

/** The mail is counted by the real counter once queued; the reservation ends with the run. */
export async function releaseImportEmail(
  db: D1Database,
  imp: Pick<StuckImport, 'mode' | 'org_id' | 'email' | 'email_budget'> & {
    committed_at: number | null;
  },
): Promise<void> {
  if (imp.email !== 1 || !imp.email_budget || imp.committed_at === null) return;
  await bump(db, key(imp.mode, imp.org_id), windowOf(imp.committed_at), -imp.email_budget);
}
