import {
  type ScanOutcome,
  type ScanReason,
  ScanReasonSchema,
} from '../../../shared/contracts/scan.ts';
import { validityOf } from '../../../shared/pass-view/validity.ts';
import { scanOf } from '../../../shared/scan-defaults.ts';
import { UnauthenticatedError } from '../../platform/errors.ts';
import { safeEqual } from '../../platform/ids.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import type { ActRequest } from './act-claim.ts';
import { StaleScanAuthority } from './act-override.ts';
import { snapshotActionContext } from './act-snapshot.ts';
import type { ActorCsrfSnapshot } from './actor-csrf.ts';
import { planAdmission } from './admission.ts';
import { type CredentialTombstoneSnapshot, credentialInputValid } from './credential-input.ts';
import { policyActor } from './dto.ts';
import { verifyEventActionLabelHash } from './event-safe-projection.ts';
import type { ScanActor } from './guard.ts';
import { verifiedEventRoleProjection } from './history-policy.ts';
import { verifyLiveTemplateSnapshot } from './live-template-snapshot.ts';
import { blankOutcome, isOverridable, safeOutcomeDetails } from './outcome.ts';
import { readReplayEvidence } from './repo-act-authority.ts';
import { replayCurrent } from './repo-act-replay-current.ts';
import { type ActionPassFence, prepareActionPassFence } from './repo-pass-authority.ts';
import type { ScanRow } from './repo-scans.ts';
import { foundOf } from './resolve.ts';
import { overridePolicyKind, scanPolicy } from './rules.ts';
import type { ScanEvaluation } from './scan-evaluation.ts';
import { scannerCredentialLost } from './scanner-credential-lost.ts';

/** A validated historical receipt with no current-policy-derived data or mutation affordances. */
export function minimalReceipt(row: ScanRow): ScanOutcome {
  return {
    ...blankOutcome(row.outcome ?? 'refused', {
      approvals: false,
      counts: { today: 0, event: null, asOf: 0, configRev: 0 },
    }),
    scanId: row.id,
    reason:
      row.passId === null &&
      row.templateId === null &&
      row.actionId === null &&
      (row.reason === 'not_found' || row.reason === 'ambiguous')
        ? row.reason
        : null,
    at: row.at,
    replay: true,
  };
}

/** Reproject an authenticated receipt without creating any effect, asset grant or live event. */
export async function replayOutcome(
  ctx: ServiceContext,
  actor: ScanActor,
  req: ActRequest,
  row: ScanRow,
  credentialContext: CredentialTombstoneSnapshot,
  csrfSnapshot: ActorCsrfSnapshot,
): Promise<ScanEvaluation> {
  ctx = snapshotActionContext(ctx);
  if (!credentialInputValid(req.input, credentialContext)) throw new StaleScanAuthority();
  const evidence = await readReplayEvidence(ctx, actor, row, credentialContext);
  const receipt: ScanEvaluation = {
    outcome: minimalReceipt(row),
    evaluatedSnapshot: null,
    credentialContext,
  };
  const finishReceipt = async () => {
    await replayCurrent(
      ctx,
      actor,
      req,
      row,
      credentialContext,
      csrfSnapshot,
      evidence,
      null,
      null,
    );
    return receipt;
  };
  const { candidate, ledger, reference, recorded } = evidence;
  if (!candidate || !ledger || !reference || !recorded || !row.passId || !row.templateId)
    return finishReceipt();
  if (
    candidate.pass.id !== row.passId ||
    candidate.pass.orgId !== actor.orgId ||
    candidate.pass.mode !== actor.mode ||
    candidate.pass.version !== row.passVersion ||
    candidate.pass.credentialGeneration !== recorded.credentialGeneration ||
    candidate.pass.linkGeneration !== recorded.linkGeneration ||
    candidate.pass.releaseId !== recorded.pinnedReleaseId ||
    candidate.pass.identityId !== recorded.identityId
  )
    return finishReceipt();

  // The candidate already contains its pinned and current template documents. Verify those exact
  // bytes instead of performing cold registry reads, then bind them again in the final transaction.
  const templates = await verifyLiveTemplateSnapshot(
    ctx,
    candidate,
    candidate.templateSnapshot,
    'commit',
  );
  if (!templates) return finishReceipt();
  const found = await foundOf(
    ctx,
    { ...candidate, hasPhoto: false },
    {
      ...actor,
      settings: { ...actor.settings, showPhoto: false },
    },
    { verifiedTemplates: templates },
  );
  if (!found) return finishReceipt();
  const available =
    found.pass.orgId === actor.orgId &&
    found.pass.mode === actor.mode &&
    !found.pass.testDataQuarantined &&
    found.pass.deletedAt === null &&
    found.pass.removedAt === null &&
    found.pass.status === 'active' &&
    !!found.pass.personalization &&
    typeof found.pass.personalization === 'object' &&
    !Array.isArray(found.pass.personalization) &&
    !!found.pass.fieldSources &&
    typeof found.pass.fieldSources === 'object' &&
    !Array.isArray(found.pass.fieldSources) &&
    !!found.passJson &&
    typeof found.passJson === 'object' &&
    !Array.isArray(found.passJson) &&
    (found.passJson.voided === undefined || found.passJson.voided === false) &&
    (found.passJson.expirationDate === undefined ||
      (typeof found.passJson.expirationDate === 'string' &&
        Number.isFinite(Date.parse(found.passJson.expirationDate)))) &&
    validityOf(found.passJson, ctx.clock.now()).status === 'active';
  const compatible =
    found.activeVersion === found.template.version ||
    found.activeTemplate?.version === found.activeVersion;
  if (!available || !compatible) return finishReceipt();

  const prepared = prepareActionPassFence(
    ctx.env.DB,
    candidate.pass,
    candidate.checkInRules,
    candidate.connectionGeneration,
    candidate.activeTemplateVersion,
    candidate.orgRevision,
    candidate.templateRevision,
    ctx.clock.now(),
    ctx.env,
    candidate,
  );
  if (!prepared) return finishReceipt();
  let fence: ActionPassFence | null = null;
  let admissionAllowed = true;
  const configured =
    Object.keys(found.checkInRules ?? {}).length > 0 ||
    Object.keys(actor.settings.checkIn ?? {}).length > 0 ||
    actor.settings.direction === 'out' ||
    actor.settings.direction === 'both';
  if (row.direction || configured) {
    const eventId =
      actor.event?.id ?? found.checkInRules?.eventId ?? actor.settings.checkIn?.eventId ?? null;
    // An admission event unknown to the captured receipt can never match its recorded event.
    if (eventId && eventId !== actor.event?.id && eventId !== evidence.event?.id)
      return finishReceipt();
    const planningActor =
      !actor.event && eventId && evidence.event?.id === eventId
        ? { ...actor, event: evidence.event }
        : actor;
    const admission = await planAdmission(ctx, planningActor, found, row.direction ?? undefined, {
      stmts: [prepared.statement],
      async finish(results) {
        const result = results[0]?.results?.[0] as { rules: string | null } | undefined;
        fence = await prepared.complete(result);
      },
    });
    found.admission = admission.plan;
    admissionAllowed = admission.reason !== 'wrong_event' && admission.reason !== 'not_accepted';
  } else {
    const results = await ctx.env.DB.batch([prepared.statement]);
    const result = results[0]?.results?.[0] as { rules: string | null } | undefined;
    fence = await prepared.complete(result);
  }
  const passFence = fence as ActionPassFence | null;
  if (
    !passFence ||
    passFence.identityRevision !== recorded.identityRevision ||
    passFence.identityPassTypeIdentifier !== recorded.identityPassTypeIdentifier ||
    passFence.identityTeamIdentifier !== recorded.identityTeamIdentifier ||
    passFence.connectionGeneration !== recorded.connectionGeneration ||
    passFence.walletVersion !== recorded.walletVersion ||
    passFence.walletTemplateVersion !== recorded.walletTemplateVersion ||
    typeof recorded.passJsonHash !== 'string' ||
    passFence.passJsonHash === null ||
    !(await safeEqual(passFence.passJsonHash, recorded.passJsonHash)) ||
    typeof recorded.evaluatedPersonalizationHash !== 'string' ||
    !(await safeEqual(
      passFence.evaluatedPersonalizationHash,
      recorded.evaluatedPersonalizationHash,
    ))
  )
    return finishReceipt();

  const policy = found.activePolicy ?? found.activeTemplate ?? found.template;
  const currentAction =
    scanOf(policy.manifest).actions.find((item) => item.id === row.actionId) ?? null;
  const action = found.scan.actions.find((item) => item.id === row.actionId) ?? null;
  const target = evidence.target;
  const overrideReason = target?.reason as ScanReason | null | undefined;
  const overrideAllowed =
    !row.overrideOf ||
    (!!action &&
      !!currentAction &&
      action.allowAgain &&
      currentAction.allowAgain &&
      !!target &&
      target.mode === actor.mode &&
      target.actorKey === actor.actorKey &&
      target.passId === row.passId &&
      target.actionId === row.actionId &&
      !!overrideReason &&
      isOverridable(overrideReason) &&
      scanPolicy(policyActor(actor), {
        kind: overridePolicyKind(overrideReason),
      }).allow);
  const currentEvent = found.admission?.event ?? actor.event;
  if (
    !admissionAllowed ||
    row.eventId !== (currentEvent?.id ?? null) ||
    row.templateId !== found.pass.templateId ||
    !overrideAllowed ||
    (row.actionId &&
      (!action ||
        !currentAction ||
        action.kind !== currentAction.kind ||
        action.kind !== row.actionKind ||
        action.input !== currentAction.input ||
        !scanPolicy(policyActor(actor), { kind: 'act', minRole: action.minRole }).allow ||
        !scanPolicy(policyActor(actor), { kind: 'act', minRole: currentAction.minRole }).allow))
  )
    return finishReceipt();
  const details = safeOutcomeDetails(found, actor, action, [], currentAction?.label);
  if (row.actionId !== null && !details.action) return finishReceipt();
  const signed = await verifiedEventRoleProjection(ctx.env, ledger, reference, actor.role);
  if (!signed) return finishReceipt();
  if (row.actionId !== null) {
    const original = signed.action;
    const projected = details.action;
    if (
      !projected ||
      !original ||
      projected.id !== row.actionId ||
      projected.kind !== original.kind ||
      !(await verifyEventActionLabelHash(ctx.env, {
        orgId: row.orgId,
        passId: row.passId,
        scanId: row.id,
        role: signed.role,
        actionId: projected.id,
        kind: projected.kind,
        label: projected.label,
        hash: original.labelHash,
      }))
    )
      return finishReceipt();
  }
  const current = await replayCurrent(
    ctx,
    actor,
    req,
    row,
    credentialContext,
    csrfSnapshot,
    evidence,
    candidate,
    currentEvent,
  ).catch(async (error: unknown) => {
    // A credential lost or replaced during the final read unpairs the device instead of answering as a miss.
    if (error instanceof StaleScanAuthority && (await scannerCredentialLost(ctx, actor)))
      throw new UnauthenticatedError('Pair this device again.', 'SCANNER_REPAIR');
    throw error;
  });
  if (!current) return receipt;
  const reason = ScanReasonSchema.safeParse(row.reason);
  const kind = row.outcome ?? 'refused';
  return {
    outcome: {
      ...blankOutcome(kind, {
        approvals: false,
        counts: { today: 0, event: null, asOf: 0, configRev: 0 },
      }),
      scanId: row.id,
      kind,
      reason: reason.success ? reason.data : null,
      replay: true,
      action: details.action,
      at: row.at,
    },
    evaluatedSnapshot: candidate,
    credentialContext,
  };
}
