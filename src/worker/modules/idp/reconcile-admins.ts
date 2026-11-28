import { endSessions, noteDrift, type Who } from './effects.ts';
import { type DriftRow, resolveDrift } from './repo-drift.ts';
import { linkedAdmins } from './repo-sync.ts';
import type { RunEnv } from './run-env.ts';

/** More platform admins gone than this at once is a feed fault, not an owner's edit: report, revoke nothing. */
export const ADMIN_BREAKER = 5;

/** Most linked admin accounts one reconcile judges at once. */
const LINKED_ADMIN_CAP = 1000;

/**
 * People whose last sign-in was as platform admin and none of whose Polaris ID accounts is still in the admin
 * group: their admin sessions end. A person is judged by all their subjects, and a person already reported stays
 * out of the count until they sign in again (their `last_roles` then no longer names admin, which closes the
 * report). An empty or missing group revokes nothing; more than a handful newly gone are reported, not revoked.
 */
export async function retireAdmins(
  env: RunEnv,
  admins: ReadonlySet<string>,
  groupSeen: boolean,
  open: readonly DriftRow[],
): Promise<void> {
  const { ctx } = env;
  const db = ctx.env.DB;
  if (!groupSeen || admins.size === 0) return;
  const linked = await linkedAdmins(db, LINKED_ADMIN_CAP + 1);
  // A truncated list would close reports of admins it left out: judge nothing rather than wrongly.
  if (linked.length > LINKED_ADMIN_CAP) {
    ctx.log.error('idp.reconcile.admins_truncated', { code: 'IDP_ADMINS_TRUNCATED' });
    return;
  }
  const byUser = new Map<string, string[]>();
  for (const a of linked) byUser.set(a.user_id, [...(byUser.get(a.user_id) ?? []), a.subject]);
  const stillAdmin = new Set(linked.map((a) => a.subject));
  const reported = new Set(open.filter((d) => d.kind === 'admin_changed').map((d) => d.subject));
  for (const subject of reported)
    if (!stillAdmin.has(subject))
      await resolveDrift(db, subject, 'console', 'admin_changed', 'signed_in', ctx.clock.now());
  const gone = [...byUser].filter(
    ([, subjects]) => !subjects.some((s) => admins.has(s) || reported.has(s)),
  );
  if (gone.length === 0) return;
  const storm = gone.length > ADMIN_BREAKER;
  if (storm)
    ctx.log.error('idp.reconcile.admin_breaker', { code: 'IDP_BREAKER', count: gone.length });
  for (const [userId, subjects] of gone) {
    const who: Who = { subject: subjects[0] ?? '', userId };
    // The admin group carries the console role, so the difference is filed under it. In a storm it is still
    // reported, so these people drop out of the next count; only the revoking waits for a person.
    await noteDrift(ctx, env.runId, who, 'console', 'admin_changed');
    if (!env.dry && !storm) await endSessions(ctx, who, 'admin', 'admin_removed');
  }
}
