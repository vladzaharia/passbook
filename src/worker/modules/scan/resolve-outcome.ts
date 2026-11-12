import type { z } from 'zod';
import type { ScanResolveRequestSchema } from '../../../shared/contracts/scan.ts';
import type { ResolvedScanAction, ResolvedScanManifest } from '../../../shared/scan-defaults.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { depsOf, overrideDeps } from '../passes/deps.ts';
import { decodePlatformSettings, platformSettingsStmt } from '../settings/service.ts';
import {
  actorCsrfAuthorityStmt,
  actorCsrfSnapshotFence,
  actorCsrfSnapshotFromResult,
} from './actor-csrf.ts';
import { type CountsPlan, planCounts } from './counts.ts';
import {
  type CredentialTombstoneSnapshot,
  credentialTombstoneRefsForInput,
  snapshotCredentialEnv,
} from './credential-input.ts';
import type { ScanActor } from './guard.ts';
import { actorAuthorityPredicate } from './repo-actor-authority.ts';
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
  actor.credentialKeysetCommitment = credentialContext.credentialKeysetCommitment;
  const csrfStmt = actorCsrfAuthorityStmt(ctx.env.DB, actor);
  if (!csrfStmt)
    return { outcome: unknown().outcome, evaluatedSnapshot: null, credentialContext: null };
  const [csrfResult, settingsResult] = await ctx.env.DB.batch([
    csrfStmt,
    platformSettingsStmt(ctx.env.DB),
  ]);
  const csrfSnapshot = await actorCsrfSnapshotFromResult(ctx, actor, csrfResult);
  if (!settingsResult)
    return { outcome: unknown().outcome, evaluatedSnapshot: null, credentialContext: null };
  const settings = decodePlatformSettings(settingsResult);
  if (!csrfSnapshot)
    return { outcome: unknown().outcome, evaluatedSnapshot: null, credentialContext: null };
  const csrfAt = (now: number) =>
    actorCsrfSnapshotFence(
      actor,
      csrfSnapshot.session
        ? { ...csrfSnapshot, session: { ...csrfSnapshot.session, now } }
        : csrfSnapshot,
    );
  const plan = await planCandidateReads(ctx, actor, req.input, credentialContext, (now) => {
    const csrf = csrfAt(now);
    if (!csrf) return null;
    const authority = actorAuthorityPredicate({
      actor,
      now,
      event: actor.event,
      adminEventTemplates: actor.adminEventTemplates === true,
    });
    return {
      sql: `(${authority.sql}) AND (${csrf.sql})`,
      params: [...authority.params, ...csrf.params],
    };
  });
  if (!plan.stmts.length)
    return { outcome: unknown().outcome, evaluatedSnapshot: null, credentialContext: null };
  const csrf = csrfAt(plan.now);
  if (!csrf)
    return { outcome: unknown().outcome, evaluatedSnapshot: null, credentialContext: null };
  const countPlan = planCounts(
    { ...ctx, clock: { now: () => plan.now } },
    actor,
    req.dayStart,
    actor,
    csrf,
  );
  const results = await ctx.env.DB.batch([...plan.stmts, ...countPlan.stmts]);
  const candidateRead = { candidates: plan.finish(results.slice(0, plan.stmts.length)) };
  const countResults = results.slice(plan.stmts.length, plan.stmts.length + countPlan.stmts.length);
  const counts: CountsPlan = { stmts: [], read: () => countPlan.read(countResults) };
  const { unconfirmed, ...result } = await resolveObserved(
    ctx,
    actor,
    req,
    credentialContext,
    csrfSnapshot,
    candidateRead,
    counts,
    settings['scan.undoWindowMinutes'],
    defaultAction,
  );
  return { ...result, credentialContext: unconfirmed ? null : credentialContext };
}
