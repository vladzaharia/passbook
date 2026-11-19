import type { z } from 'zod';
import type { ScanCodeInput, ScanResolveRequestSchema } from '../../../shared/contracts/scan.ts';
import type { ResolvedScanAction, ResolvedScanManifest } from '../../../shared/scan-defaults.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { depsOf, overrideDeps } from '../passes/deps.ts';
import { decodePlatformSettings, platformSettingsStmt } from '../settings/service.ts';
import { narrowForCandidates } from './admits.ts';
import { type CountsPlan, planCounts } from './counts.ts';
import {
  type CredentialTombstoneSnapshot,
  credentialTombstoneRefsForInput,
  snapshotCredentialEnv,
} from './credential-input.ts';
import type { ScanActor } from './guard.ts';
import { missCounterRead, refuseOverCap } from './misses.ts';
import { planCandidateReads } from './resolve-candidates.ts';
import { resolveObserved, unknown } from './resolve-outcome-observed.ts';
import type { ScanEvaluation } from './scan-evaluation.ts';
import { cloneObservedScanActor } from './scanning-workspace-observation.ts';

/** The scanner's default action, else the template's first. */
export function defaultAction(
  actor: ScanActor,
  scan: ResolvedScanManifest,
): ResolvedScanAction | null {
  const wanted = actor.settings.defaultActionId;
  return scan.actions.find((a) => a.id === wanted) ?? scan.actions[0] ?? null;
}

/** Resolve without creating a scan row; the original credential context stays worker-only. */
export async function resolveOutcome(
  ctx: ServiceContext,
  actor: ScanActor,
  req: Omit<z.infer<typeof ScanResolveRequestSchema>, 'input'> & { input: ScanCodeInput },
): Promise<ScanEvaluation> {
  req = {
    ...req,
    input: { ...req.input },
    ...(req.scope
      ? {
          scope: {
            ...req.scope,
            ...(req.scope.templateIds ? { templateIds: [...req.scope.templateIds] } : {}),
          },
        }
      : {}),
  };
  const env = snapshotCredentialEnv(ctx.env);
  overrideDeps(env, depsOf(ctx.env));
  ctx = { ...ctx, env };
  actor = cloneObservedScanActor(actor);
  const observed = await credentialTombstoneRefsForInput(
    ctx,
    actor.orgId,
    actor.mode,
    req.input,
    true,
    'defer',
  );
  const credentialContext: CredentialTombstoneSnapshot = Object.freeze({
    credentialKeysetCommitment: observed.credentialKeysetCommitment,
    credentialTombstoneRefs: Object.freeze([...observed.credentialTombstoneRefs]),
    otherModeCredentialTombstoneRefs: Object.freeze([...observed.otherModeCredentialTombstoneRefs]),
  });
  actor = { ...actor, credentialKeysetCommitment: credentialContext.credentialKeysetCommitment };
  const refused = { outcome: unknown().outcome, evaluatedSnapshot: null, credentialContext: null };
  const plan = await planCandidateReads(ctx, actor, req.input, credentialContext);
  if (!plan.stmts.length) return refused;
  const countPlan = planCounts({ ...ctx, clock: { now: () => plan.now } }, actor, req.dayStart);
  // One round trip: the candidates, the day's counts, the platform settings and the miss counter.
  const results = await ctx.env.DB.batch([
    ...plan.stmts,
    ...countPlan.stmts,
    platformSettingsStmt(ctx.env.DB),
    missCounterRead(ctx.env.DB, actor, plan.now),
  ]);
  const candidateRead = { candidates: plan.finish(results.slice(0, plan.stmts.length)) };
  const countResults = results.slice(plan.stmts.length, plan.stmts.length + countPlan.stmts.length);
  const settingsResult = results[plan.stmts.length + countPlan.stmts.length];
  // Past its miss cap an actor reads nothing, a hit included: guessing is throttled, not just its misses.
  refuseOverCap(results[plan.stmts.length + countPlan.stmts.length + 1]?.results?.[0], plan.now);
  if (!settingsResult) return refused;
  const settings = decodePlatformSettings(settingsResult);
  let counts: CountsPlan = { stmts: [], read: () => countPlan.read(countResults) };
  // A mixed scope runs the scan under the entry that admits the pass; an event's counts come with it.
  const admitted = narrowForCandidates(actor, candidateRead.candidates, plan.now);
  if (admitted !== actor && admitted.event) {
    const again = planCounts({ ...ctx, clock: { now: () => plan.now } }, admitted, req.dayStart);
    const read = again.stmts.length ? await ctx.env.DB.batch(again.stmts) : [];
    counts = { stmts: [], read: () => again.read(read) };
  }
  actor = admitted;
  const { unconfirmed: notConfirmed, ...result } = await resolveObserved(
    ctx,
    actor,
    req,
    credentialContext,
    candidateRead,
    counts,
    settings['scan.undoWindowMinutes'],
    defaultAction,
  );
  return { ...result, credentialContext: notConfirmed ? null : credentialContext };
}
