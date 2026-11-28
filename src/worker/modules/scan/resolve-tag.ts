import type { z } from 'zod';
import type { ScanReason, ScanResolveRequestSchema } from '../../../shared/contracts/scan.ts';
import { entitledIn } from '../../platform/feature-guard.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { depsOf, overrideDeps } from '../passes/deps.ts';
import { decodePlatformSettings, platformSettingsStmt } from '../settings/service.ts';
import { act } from './act.ts';
import type { ActRequestInput } from './act-claim.ts';
import type { ScanActor } from './actor.ts';
import { planCounts } from './counts.ts';
import {
  type CredentialTombstoneSnapshot,
  credentialTombstoneRefsForInput,
  snapshotCredentialEnv,
} from './credential-input.ts';
import { planTagReads, tagReadOf } from './evaluate-tag.ts';
import { missCounterRead, refuseOverCap } from './misses.ts';
import { scanAuthorizedStmt, scanReadAuthority } from './repo-read-authority.ts';
import { defaultAction, resolveOutcome } from './resolve-outcome.ts';
import { resolveObserved, unknown } from './resolve-outcome-observed.ts';
import type { ScanEvaluation } from './scan-evaluation.ts';
import { cloneObservedScanActor } from './scanning-workspace-observation.ts';
import { chooseTagPass } from './tag-choose.ts';
import { countTagMiss, type TagAct, tagRefusal, tagUnknown, withTagView } from './tag-scan.ts';
import { type TagId, verifiedSunId } from './tags-sun.ts';

type TagInput = Extract<ActRequestInput['input'], { tag: unknown }>;
type ResolveRequest = Omit<z.infer<typeof ScanResolveRequestSchema>, 'input'>;

const frozen = (refs: CredentialTombstoneSnapshot): CredentialTombstoneSnapshot =>
  Object.freeze({
    credentialKeysetCommitment: refs.credentialKeysetCommitment,
    credentialTombstoneRefs: Object.freeze([...refs.credentialTombstoneRefs]),
    otherModeCredentialTombstoneRefs: Object.freeze([...refs.otherModeCredentialTombstoneRefs]),
  });

/**
 * Step 1: the tag a read names (its UID, or a SUN read the plugin verified), the NDEF pass code it carries
 * when the org has no such tag, or the refusal a bad SUN read gets.
 */
async function readOf(
  ctx: ServiceContext,
  actor: ScanActor,
  input: TagInput,
): Promise<{ id: TagId } | { code: string } | { refused: ScanReason } | null> {
  const read = tagReadOf(input.tag, ctx.env);
  if (!read) return null;
  if ('sun' in read) {
    // A SUN tag below the plan's Secure level is not allowed; Test waives the level.
    if (!(await entitledIn(ctx, actor.orgId, 'nfc', actor.mode, 'secure')))
      return { refused: 'tag_not_allowed' };
    return verifiedSunId(ctx, actor, input.tag);
  }
  if ('code' in read) return read;
  if (input.tag.ndef && (await tagUnknown(ctx, actor, read.uid)))
    return { code: input.tag.ndef.value };
  return { id: { uid: read.uid } };
}

/** `POST /resolve` with a tag read (design §4.2): one batch, then the chosen pass's own answer. */
export async function resolveTag(
  ctx: ServiceContext,
  actor: ScanActor,
  req: ResolveRequest & { input: TagInput },
): Promise<ScanEvaluation> {
  const env = snapshotCredentialEnv(ctx.env);
  overrideDeps(env, depsOf(ctx.env));
  ctx = { ...ctx, env };
  actor = cloneObservedScanActor(actor);
  const read = await readOf(ctx, actor, req.input);
  if (!read || 'refused' in read)
    return {
      outcome: tagRefusal(read ? read.refused : 'tag_invalid'),
      evaluatedSnapshot: null,
      credentialContext: null,
    };
  if ('code' in read)
    return resolveOutcome(ctx, actor, { ...req, input: { code: read.code, method: 'nfc' } });
  const credentials = frozen(
    await credentialTombstoneRefsForInput(ctx, actor.orgId, actor.mode, req.input, true, 'defer'),
  );
  actor = { ...actor, credentialKeysetCommitment: credentials.credentialKeysetCommitment };
  const plan = await planTagReads(ctx, actor, read.id, credentials);
  const now = ctx.clock.now();
  const countPlan = planCounts({ ...ctx, clock: { now: () => now } }, actor, req.dayStart);
  const n = plan.stmts.length;
  const m = countPlan.stmts.length;
  // One round trip, as a code's: the actor, the tag and its passes, the counts, the settings, the misses.
  const results = await ctx.env.DB.batch<{ authorized?: unknown }>([
    scanAuthorizedStmt(ctx.env.DB, scanReadAuthority(actor, { now })),
    ...plan.stmts,
    ...countPlan.stmts,
    platformSettingsStmt(ctx.env.DB),
    missCounterRead(ctx.env.DB, actor, now),
  ]);
  const refused = { outcome: unknown().outcome, evaluatedSnapshot: null, credentialContext: null };
  if (results[0]?.results?.[0]?.authorized !== 1) return refused;
  refuseOverCap(results[1 + n + m + 1]?.results?.[0], now);
  const settingsResult = results[1 + n + m];
  if (!settingsResult) return refused;
  const countResults = results.slice(1 + n, 1 + n + m);
  const counts = { stmts: [], read: () => countPlan.read(countResults) };
  const found = plan.read(results.slice(1, 1 + n));
  if (found.stop) {
    if (found.unknown) await countTagMiss(ctx, actor, plan.ref);
    const outcome = tagRefusal(found.stop, await counts.read());
    return { outcome, evaluatedSnapshot: null, credentialContext: null };
  }
  const choice = await chooseTagPass(ctx, actor, found);
  if (!choice) return refused;
  const { unconfirmed, ...result } = await resolveObserved(
    ctx,
    choice.actor,
    { ...req, input: { passId: choice.chosen.pass.id, method: 'nfc' } },
    credentials,
    { candidates: [choice.chosen] },
    counts,
    decodePlatformSettings(settingsResult)['scan.undoWindowMinutes'],
    defaultAction,
  );
  return withTagView(
    { ...result, credentialContext: unconfirmed ? null : credentials },
    choice.view,
  );
}

/** `POST /actions` with a tag read (design §4.3): `act` on the pass the tag chooses, pinned when given. */
export async function actTag(
  ctx: ServiceContext,
  actor: ScanActor,
  req: ActRequestInput & { input: TagInput },
): Promise<ScanEvaluation> {
  const read = await readOf(ctx, actor, req.input);
  if (!read || 'refused' in read)
    return {
      outcome: tagRefusal(read ? read.refused : 'tag_invalid'),
      evaluatedSnapshot: null,
      credentialContext: null,
    };
  if ('code' in read) return act(ctx, actor, { ...req, input: { code: read.code, method: 'nfc' } });
  const credentials = await credentialTombstoneRefsForInput(
    ctx,
    actor.orgId,
    actor.mode,
    req.input,
    true,
    'defer',
  );
  // Only a follow-up of a heads-up may present a read its device already used.
  const followUp = !!(req.confirmed || req.overrideOf || req.approval);
  const plan = await planTagReads(ctx, actor, read.id, credentials, req.overrideOf, followUp);
  let view: Awaited<ReturnType<typeof chooseTagPass>> = null;
  const tag: TagAct = {
    ref: plan.ref,
    stmts: plan.stmts,
    async choose(results) {
      const found = plan.read(results);
      if (found.stop)
        return {
          reason: found.stop,
          tagId: found.tagId ?? null,
          miss: !!found.unknown,
          ...(found.sun ? { sun: found.sun } : {}),
        };
      // An override acts on the pass of the scan it overrides: no re-selection.
      const pin = req.input.passId ?? (req.overrideOf ? (found.overridden ?? '') : null);
      view = await chooseTagPass(ctx, actor, found, { pin, actionId: req.actionId });
      if (!view) return { reason: 'not_found', tagId: found.tag.id, miss: false };
      return { actor: view.actor, input: { passId: view.chosen.pass.id, method: 'nfc' } };
    },
  };
  const result = await act(ctx, actor, req, tag);
  const chosen = view as Awaited<ReturnType<typeof chooseTagPass>>;
  return withTagView(result, chosen?.view ?? null);
}
