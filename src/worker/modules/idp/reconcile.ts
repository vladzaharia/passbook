import { classify } from './classify.ts';
import { desiredState } from './desired.ts';
import { closeDrift, endSessions, holdTargetForOwner, noteDrift, type Who } from './effects.ts';
import { idpCodeOf } from './errors.ts';
import { type DriftKind, type DriftRow, driftStmt, openDrift } from './repo-drift.ts';
import { observedStmt, type TargetStateRow } from './repo-state.ts';
import {
  actionableDriftSubjects,
  flush,
  identitiesOfSubjects,
  linkedAdmins,
  markManyDirty,
  statesOfSubjects,
  touchObserved,
  unobservedWanted,
} from './repo-sync.ts';
import { isManaged, type RunEnv, rpcCtx } from './run-env.ts';
import type { Target } from './types.ts';

const DAY = 86_400_000;
/** The snapshot reports every grant ended for a missing member in this window, so a skipped day loses none. */
const SINCE_MS = 2 * DAY;
/** Subjects a run puts on the drain's queue for what it never saw, and for open differences to retry. */
const MARK_LIMIT = 200;
/** More platform admins gone than this at once is a feed fault, not an owner's edit: report, revoke nothing. */
const ADMIN_BREAKER = 5;
const OPEN_LIMIT = 2000;

export interface ReconcileReport {
  runId: string;
  members: number;
  external: number;
  unknown: number;
  held: number;
  marked: number;
  verified: number;
  capped: boolean;
}

const isAdminRoles = (lastRoles: string): boolean => lastRoles.includes('"admin"');

interface Queued {
  target: Target;
  /** The snapshot ended this grant: the member is gone and the owner took it. */
  ended: boolean;
}

/**
 * The daily pass over Polaris ID (design 1 section 3.4). One `snapshot` of every group, classified with the
 * same table as the drain: owner-added roles are recorded as external and left alone; a grant the owner ended
 * is held and its sessions end; members PassBook does not know are reported. Roles PassBook should add or take
 * back are put on the drain's queue rather than applied here, so the drain's limits cover them. It stops
 * verifying when `spent()` reaches `cap` (the oldest-checked subjects go first, so the rest wait for tomorrow).
 */
export async function reconcile(
  env: RunEnv,
  spent: () => number,
  cap: number,
): Promise<ReconcileReport | null> {
  const { ctx, rpc, runId, dry } = env;
  const db = ctx.env.DB;
  const now = ctx.clock.now();
  const report: ReconcileReport = {
    runId,
    members: 0,
    external: 0,
    unknown: 0,
    held: 0,
    marked: 0,
    verified: 0,
    capped: false,
  };
  let snapshot: Awaited<ReturnType<typeof rpc.snapshot>>;
  try {
    snapshot = await rpc.snapshot({
      ...rpcCtx(env, 'reconcile', 'reconcile'),
      since: now - SINCE_MS,
    });
  } catch (error) {
    ctx.log.warn('idp.reconcile.snapshot_failed', { code: idpCodeOf(error) ?? 'IDP_UNAVAILABLE' });
    return null;
  }

  const groups = Object.entries(snapshot.roles).filter(([key]) => isManaged(key)) as [
    Target,
    (typeof snapshot.roles)[string],
  ][];
  const admins = new Set((snapshot.roles.platform_admin?.members ?? []).map((m) => m.subject));
  const subjects = [
    ...new Set([
      ...groups.flatMap(([, g]) => g.members.map((m) => m.subject)),
      ...snapshot.ended.map((e) => e.subject),
    ]),
  ];
  const identities = await identitiesOfSubjects(db, subjects);
  const states = await statesOfSubjects(db, subjects);
  const drifts = await openDrift(db, OPEN_LIMIT);
  const driftOf = new Map<string, DriftRow[]>();
  for (const d of drifts) driftOf.set(d.subject, [...(driftOf.get(d.subject) ?? []), d]);

  const whoOf = (subject: string): Who => ({
    subject,
    userId: identities.get(subject)?.user_id ?? null,
  });
  const stateOf = (subject: string, target: Target): TargetStateRow | undefined =>
    states.get(subject)?.find((s) => s.target === target);
  // The member scan only prepares writes; they go out fifty to a round trip, so it costs a few queries.
  const writes: D1PreparedStatement[] = [];
  const noted = new Set<string>();
  const note = async (subject: string, target: Target, kind: DriftKind, batched = false) => {
    const key = `${subject}|${target}|${kind}`;
    if (noted.has(key)) return;
    noted.add(key);
    if (!batched) return noteDrift(ctx, runId, whoOf(subject), target, kind, driftOf.get(subject));
    if (driftOf.get(subject)?.some((d) => d.target === target && d.kind === kind)) return;
    const w = whoOf(subject);
    writes.push(
      driftStmt(db, { id: ctx.ids.id(), runId, userId: w.userId, subject, target, kind, now }),
    );
  };
  const observe = (subject: string, target: Target, presence: 'passbook' | 'external') => {
    const before = stateOf(subject, target);
    if (before?.observed === 1 && before.presence === presence && before.error_code === null)
      return;
    writes.push(observedStmt(db, { ...whoOf(subject), target, observed: true, presence, now }));
  };

  const queued = new Map<string, Queued[]>();
  const queue = (subject: string, q: Queued) =>
    queued.set(subject, [...(queued.get(subject) ?? []), q]);
  const disabled = new Set<string>();
  for (const [target, group] of groups) {
    for (const m of group.members) {
      report.members++;
      if (m.isAdmin || admins.has(m.subject)) continue;
      const identity = identities.get(m.subject);
      if (!identity) {
        report.unknown++;
        await note(m.subject, target, 'unknown_member', true);
        continue;
      }
      if (isAdminRoles(identity.last_roles)) continue;
      observe(m.subject, target, m.grant ? 'passbook' : 'external');
      if (m.disabled && identity.status === 'active') {
        disabled.add(m.subject);
        await note(m.subject, target, 'disabled_in_idp', true);
      }
      if (m.grant) queue(m.subject, { target, ended: false });
      else {
        report.external++;
        await note(m.subject, target, 'external_added', true);
      }
    }
  }
  await flush(db, writes);
  for (const e of snapshot.ended)
    if (!admins.has(e.subject) && !isAdminRoles(identities.get(e.subject)?.last_roles ?? ''))
      queue(e.subject, { target: e.role, ended: true });
  if (!dry)
    for (const subject of disabled)
      await endSessions(ctx, whoOf(subject), 'user', 'disabled_in_idp');

  // Never-checked subjects first, then the longest since a run checked them: a capped run resumes tomorrow.
  const age = (subject: string) => {
    const seen = (states.get(subject) ?? []).map((s) => s.observed_at ?? 0);
    return seen.length ? Math.min(...seen) : 0;
  };
  const order = [...queued.keys()].sort((a, b) => age(a) - age(b) || a.localeCompare(b));
  const toDrain: string[] = [];
  for (const subject of order) {
    if (spent() >= cap) {
      report.capped = true;
      break;
    }
    const desired = await desiredState(db, subject, now);
    if (desired.skip === 'platform_admin') continue;
    report.verified++;
    await touchObserved(db, subject, now);
    const who = whoOf(subject);
    for (const q of queued.get(subject) ?? []) {
      const s = stateOf(subject, q.target);
      const verdict = classify({
        present: !q.ended,
        grant: true,
        wanted: desired.skip === null && desired.targets.has(q.target),
        held: s?.held_at != null,
        seen: q.ended || s?.observed === 1,
      });
      if (verdict === 'ok')
        await closeDrift(
          ctx,
          who,
          q.target,
          driftOf.get(subject) ?? [],
          ['missing', 'unexpected'],
          'ok',
        );
      else if (verdict === 'remove') {
        await note(subject, q.target, 'unexpected');
        toDrain.push(subject);
      } else if (verdict === 'hold') {
        report.held++;
        if (dry) await note(subject, q.target, 'owner_removed');
        else await holdTargetForOwner(ctx, runId, who, q.target);
      }
    }
  }

  await retireAdmins(env, admins, snapshot.roles.platform_admin !== undefined);

  const retry = dry ? [] : await actionableDriftSubjects(db, MARK_LIMIT);
  const mark = [...new Set([...toDrain, ...(await unobservedWanted(db, MARK_LIMIT)), ...retry])];
  await markManyDirty(db, mark);
  report.marked = mark.length;
  ctx.log.info('idp.reconcile.done', { ...report, queries: spent() });
  return report;
}

/**
 * People whose last sign-in was as platform admin but who are no longer in the admin group: their admin
 * sessions end. An empty or missing group, or more than a handful gone at once, is reported and revokes nothing.
 */
async function retireAdmins(env: RunEnv, admins: Set<string>, seen: boolean): Promise<void> {
  const { ctx } = env;
  if (!seen || admins.size === 0) return;
  const gone = (await linkedAdmins(ctx.env.DB, 200)).filter((a) => !admins.has(a.subject));
  if (gone.length === 0) return;
  if (gone.length > ADMIN_BREAKER) {
    ctx.log.error('idp.reconcile.admin_breaker', { code: 'IDP_BREAKER', count: gone.length });
    return;
  }
  for (const a of gone) {
    const who: Who = { subject: a.subject, userId: a.user_id };
    // The admin group carries the console role, so the difference is filed under it.
    await noteDrift(ctx, env.runId, who, 'console', 'admin_changed');
    if (!env.dry) await endSessions(ctx, who, 'admin', 'admin_removed');
  }
}
