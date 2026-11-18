import { bump } from '../../platform/counters.ts';
import { orgEmailBudget } from '../delivery/repo-email-budget.ts';

const DAY = 86_400_000;
const keyOf = (mode: string, orgId: string) => `pass-import-email:${mode}:org:${orgId}`;
const windowOf = (at: number) => at - (at % DAY);

/** What an import holds of the org's day budget; every field is on the `pass_imports` row. */
export interface EmailHold {
  mode: 'live' | 'test';
  org_id: string;
  email: number;
  email_budget: number | null;
  committed_at: number | null;
}

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
  const total = await bump(db, keyOf(mode, orgId), windowOf(now), wanted);
  const granted = Math.max(0, Math.min(wanted, left - (total - wanted)));
  if (granted < wanted) await bump(db, keyOf(mode, orgId), windowOf(now), granted - wanted);
  return granted;
}

/** The counter row to subtract when the run ends, or null when the import held nothing. */
export function holdRelease(hold: EmailHold): { key: string; window: number; by: number } | null {
  if (hold.email !== 1 || !hold.email_budget || hold.committed_at === null) return null;
  return {
    key: keyOf(hold.mode, hold.org_id),
    window: windowOf(hold.committed_at),
    by: hold.email_budget,
  };
}

/** For a commit that never started (no finish will run): gives the hold back on its own. */
export async function releaseImportEmail(db: D1Database, hold: EmailHold): Promise<void> {
  const r = holdRelease(hold);
  if (r) await bump(db, r.key, r.window, -r.by);
}
