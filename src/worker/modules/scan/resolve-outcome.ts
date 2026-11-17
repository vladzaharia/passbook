import type { z } from 'zod';
import type { ScanResolveRequestSchema } from '../../../shared/contracts/scan.ts';
import type { ResolvedScanAction, ResolvedScanManifest } from '../../../shared/scan-defaults.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { depsOf, overrideDeps } from '../passes/deps.ts';
import { decodePlatformSettings, platformSettingsStmt } from '../settings/service.ts';
import { type CountsPlan, planCounts } from './counts.ts';
import {
  type CredentialTombstoneSnapshot,
  credentialTombstoneRefsForInput,
  snapshotCredentialEnv,
} from './credential-input.ts';
import type { ScanActor } from './guard.ts';
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
  req: z.infer<typeof ScanResolveRequestSchema>,
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
  // One round trip: the candidates, the day's counts and the platform settings.
  const results = await ctx.env.DB.batch([
    ...plan.stmts,
    ...countPlan.stmts,
    platformSettingsStmt(ctx.env.DB),
  ]);
  const candidateRead = { candidates: plan.finish(results.slice(0, plan.stmts.length)) };
  const countResults = results.slice(plan.stmts.length, plan.stmts.length + countPlan.stmts.length);
  const settingsResult = results[plan.stmts.length + countPlan.stmts.length];
  if (!settingsResult) return refused;
  const settings = decodePlatformSettings(settingsResult);
  const counts: CountsPlan = { stmts: [], read: () => countPlan.read(countResults) };
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
