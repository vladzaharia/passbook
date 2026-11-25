import { endSessions, noteDrift, type Who } from './effects.ts';
import { type DriftRow, resolveDrift } from './repo-drift.ts';
import { linkedAdmins } from './repo-sync.ts';
import type { RunEnv } from './run-env.ts';

/** More platform admins gone than this at once is a feed fault, not an owner's edit: report, revoke nothing. */
export const ADMIN_BREAKER = 5;

/**
 * People whose last sign-in was as platform admin and none of whose Polaris ID accounts is still in the admin
 * group: their admin sessions end. A person is judged by all their subjects, and a person already reported stays
 * out of the count until they sign in again (their `last_roles` then no longer names admin, which closes the
 * report). An empty or missing group, or more than a handful newly gone, is reported and revokes nothing.
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
  const linked = await linkedAdmins(db, 200);
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
  if (gone.length > ADMIN_BREAKER) {
    ctx.log.error('idp.reconcile.admin_breaker', { code: 'IDP_BREAKER', count: gone.length });
    return;
  }
  for (const [userId, subjects] of gone) {
    const who: Who = { subject: subjects[0] ?? '', userId };
    // The admin group carries the console role, so the difference is filed under it.
    await noteDrift(ctx, env.runId, who, 'console', 'admin_changed');
    if (!env.dry) await endSessions(ctx, who, 'admin', 'admin_removed');
  }
}
