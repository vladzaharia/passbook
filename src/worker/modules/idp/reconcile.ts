import { classify } from './classify.ts';
import { desiredState } from './desired.ts';
import { holdOrReport } from './drain.ts';
import { closeDrift, endSessions, noteDrift, type Who } from './effects.ts';
import { idpCodeOf } from './errors.ts';
import { retireAdmins } from './reconcile-admins.ts';
import { type DriftKind, type DriftRow, driftStmt, openDrift } from './repo-drift.ts';
import { observedStmt, type TargetStateRow } from './repo-state.ts';
import {
  actionableDriftSubjects,
  flush,
  identitiesOfSubjects,
  markManyDirty,
  statesOfSubjects,
  touchObserved,
  unobservedWanted,
} from './repo-sync.ts';
import { DISABLED_CAP, isManaged, type RunEnv, rpcCtx } from './run-env.ts';
import type { Target } from './types.ts';

const DAY = 86_400_000;
/** The snapshot reports every grant ended for a missing member in this window, so a skipped day loses none. */
const SINCE_MS = 2 * DAY;
/** Subjects a run puts on the drain's queue for what it never saw, and for open differences to retry. */
const MARK_LIMIT = 200;
/** Never-seen subjects a dry run checks against the snapshot itself (nothing is queued in a dry run). */
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
 * is held and its sessions end (first, before the budget runs low); members PassBook does not know are
 * reported. Roles PassBook should add or take back are put on the drain's queue rather than applied here, so
 * the drain's limits cover them. Every phase checks `spent()` against `cap` before it starts; the
 * longest-unchecked subjects verify first, so a capped run resumes the next day.
 *
 * Dry run records drift rows and nothing else: no observed state, no hold, no session change, no queue mark. It
 * lists never-seen subjects that are missing from a group by comparing D1 with the snapshot directly.
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
  const over = (phase: string): boolean => {
    if (spent() < cap) return false;
    if (!report.capped)
      ctx.log.warn('idp.reconcile.capped', { code: 'CRON_BUDGET', phase, queries: spent() });
    report.capped = true;
    return true;
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
  if (over('snapshot')) return report;

  const groups = Object.entries(snapshot.roles).filter(([key]) => isManaged(key)) as [
    Target,
    (typeof snapshot.roles)[string],
  ][];
  const inGroup = new Map(groups.map(([t, g]) => [t, new Set(g.members.map((m) => m.subject))]));
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
    if (
      dry ||
      (before?.observed === 1 && before.presence === presence && before.error_code === null)
    )
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
  if (!dry) await endDisabledSessions(env, [...disabled], whoOf);

  // The owner's removals come first: they are few, and a run low on budget must still hold them.
  const held = new Set<string>();
  for (const e of snapshot.ended) {
    const key = `${e.subject}|${e.role}`;
    if (held.has(key) || admins.has(e.subject)) continue;
    if (isAdminRoles(identities.get(e.subject)?.last_roles ?? '')) continue;
    if (over('ended')) break;
    held.add(key);
    const desired = await desiredState(db, e.subject, now);
    if (desired.skip === 'platform_admin') continue;
    const s = stateOf(e.subject, e.role);
    const verdict = classify({
      present: false,
      grant: true,
      wanted: desired.skip === null && desired.targets.has(e.role),
      held: s?.held_at != null,
      seen: true,
    });
    if (verdict !== 'hold') continue;
    report.held++;
    await holdOrReport(env, whoOf(e.subject), e.role, driftOf.get(e.subject) ?? []);
  }

  // Never-checked subjects first, then the longest since a run checked them: a capped run resumes tomorrow.
  const age = (subject: string) => {
    const seen = (states.get(subject) ?? []).map((s) => s.observed_at ?? 0);
    return seen.length ? Math.min(...seen) : 0;
  };
  const order = [...queued.keys()].sort((a, b) => age(a) - age(b) || a.localeCompare(b));
  const toDrain: string[] = [];
  for (const subject of order) {
    if (over('verify')) break;
    const desired = await desiredState(db, subject, now);
    if (desired.skip === 'platform_admin') continue;
    report.verified++;
    if (!dry) await touchObserved(db, subject, now);
    const who = whoOf(subject);
    for (const q of queued.get(subject) ?? []) {
      const verdict = classify({
        present: true,
        grant: true,
        wanted: desired.skip === null && desired.targets.has(q.target),
        held: stateOf(subject, q.target)?.held_at != null,
        seen: true,
      });
      if (verdict === 'ok') {
        const open = driftOf.get(subject) ?? [];
        await closeDrift(ctx, who, q.target, open, ['missing', 'unexpected'], 'ok');
      } else if (verdict === 'remove') {
        await note(subject, q.target, 'unexpected');
        toDrain.push(subject);
      }
    }
  }

  if (!over('admins'))
    await retireAdmins(env, admins, snapshot.roles.platform_admin !== undefined, drifts);

  if (!over('candidates')) {
    const fresh = await unobservedWanted(db, MARK_LIMIT);
    if (dry) await listMissing(env, fresh, inGroup, note, over);
    else {
      const retry = await actionableDriftSubjects(db, MARK_LIMIT);
      const mark = [...new Set([...toDrain, ...fresh, ...retry])];
      await markManyDirty(db, mark);
      report.marked = mark.length;
    }
  }
  ctx.log.info('idp.reconcile.done', { ...report, queries: spent() });
  return report;
}

/** Ends the Polaris ID sessions of members the owner disabled, up to `DISABLED_CAP` a run. */
async function endDisabledSessions(
  env: RunEnv,
  disabled: string[],
  whoOf: (subject: string) => Who,
): Promise<void> {
  for (const [i, subject] of disabled.entries()) {
    if (i >= DISABLED_CAP) {
      env.ctx.log.error('idp.hold_breaker', { code: 'IDP_HOLD_BREAKER', limit: DISABLED_CAP });
      return;
    }
    await endSessions(env.ctx, whoOf(subject), 'user', 'disabled_in_idp');
  }
}

/** A dry run's list of what a live run would add: wanted by D1, absent from the group in the snapshot. */
async function listMissing(
  env: RunEnv,
  subjects: string[],
  inGroup: ReadonlyMap<Target, ReadonlySet<string>>,
  note: (subject: string, target: Target, kind: DriftKind) => Promise<void>,
  over: (phase: string) => boolean,
): Promise<void> {
  for (const subject of subjects) {
    if (over('missing')) return;
    const desired = await desiredState(env.ctx.env.DB, subject, env.ctx.clock.now());
    if (desired.skip) continue;
    for (const target of desired.targets.keys())
      if (inGroup.has(target) && !inGroup.get(target)?.has(subject))
        await note(subject, target, 'missing');
  }
}
