import type { TemplateManifest } from '../../../passkit/types.ts';
import type { ScanCard } from '../../../shared/contracts/scan.ts';
import type { ResolvedScanAction } from '../../../shared/scan-defaults.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import type { EventRow } from '../events/repo.ts';
import { sourcePolicyProven, visibleAction } from './card-semantics.ts';
import { type CardPrivacy, record } from './dto-projection.ts';
import type { ScanActor } from './guard.ts';
import { type HistoryPolicy, historyPolicy } from './history-policy.ts';
import { CARD_HISTORY_CANDIDATE_LIMIT, type CardHistoryRow } from './repo-card-history.ts';
import { toScan } from './repo-scan-map.ts';
import type { Found } from './resolve.ts';

/** Verify the immutable receipt before using its historical policy or identity data. */
async function historicalCardPolicy(
  ctx: ServiceContext,
  actor: ScanActor,
  found: Found,
  currentPersonalization: string,
  row: CardHistoryRow,
): Promise<HistoryPolicy | null> {
  if (
    !sourcePolicyProven(found, actor) ||
    !row.event_json ||
    !row.recorded_template_version ||
    row.recorded_wallet_version === null ||
    !row.recorded_manifest
  )
    return null;
  let event: EventRow;
  let authority: Record<string, unknown> | undefined;
  try {
    event = JSON.parse(row.event_json) as EventRow;
    const data = record(JSON.parse(event.data));
    authority = record(data?.authority);
  } catch {
    return null;
  }
  if (
    !authority ||
    typeof authority.activeTemplateVersion !== 'string' ||
    found.transferPending !== false ||
    !Number.isSafeInteger(found.pass.credentialGeneration) ||
    row.current_credential_generation !== found.pass.credentialGeneration ||
    row.current_pending_transfer !== 0 ||
    found.pass.credentialGeneration < 1 ||
    authority.credentialGeneration !== found.pass.credentialGeneration ||
    authority.noPendingTransfer !== true
  )
    return null;
  const legacy =
    authority.pinnedReleaseId === null &&
    authority.activeReleaseId === null &&
    authority.activeReleaseGeneration === null &&
    authority.activeReleaseVersion === null &&
    authority.activeReleaseCandidateHash === null;
  if (legacy ? row.legacy_proof !== 1 : row.approved_proof !== 1) return null;
  const activeManifest = legacy ? row.event_legacy_manifest : row.event_active_manifest;
  if (!activeManifest) return null;
  let pinned: Record<string, unknown> | undefined;
  let active: Record<string, unknown> | undefined;
  let wallet: Record<string, unknown> | undefined;
  try {
    pinned = record(JSON.parse(row.recorded_manifest));
    active = record(JSON.parse(activeManifest));
    wallet = row.recorded_wallet_manifest
      ? record(JSON.parse(row.recorded_wallet_manifest))
      : undefined;
  } catch {
    return null;
  }
  const currentActive = found.activePolicy ?? found.activeTemplate ?? found.template;
  if (
    !pinned ||
    !active ||
    currentActive.version !== found.activeVersion ||
    found.template.version !== found.pass.templateVersion
  )
    return null;
  return historyPolicy(ctx.env, {
    event,
    scan: {
      ...toScan(row),
      pinnedTemplateVersion: row.recorded_template_version,
      walletVersion: row.recorded_wallet_version,
      walletTemplateVersion: row.recorded_wallet_template_version,
      direction: row.direction,
      presenceScope: row.presence_scope,
    },
    currentPersonalization,
    versionPersonalization: row.recorded_personalization,
    currentCredentialGeneration: found.pass.credentialGeneration,
    transferPending: found.transferPending,
    credentialKeysetCommitment: found.credentialKeysetCommitment,
    currentScannerName: row.scanner_name,
    eventPinned: {
      version: row.recorded_template_version,
      manifest: pinned as unknown as TemplateManifest,
    },
    eventActive: {
      version: authority.activeTemplateVersion,
      manifest: active as unknown as TemplateManifest,
    },
    eventWallet:
      wallet && row.recorded_wallet_template_version
        ? {
            version: row.recorded_wallet_template_version,
            manifest: wallet as unknown as TemplateManifest,
          }
        : null,
    currentPinned: found.template,
    currentActive,
    role: actor.role,
  });
}

function historicalAction(
  actor: ScanActor,
  found: Found,
  privacy: CardPrivacy,
  original: HistoryPolicy | null,
  row: CardHistoryRow,
): ResolvedScanAction | null {
  if (!original || !row.action_id || !row.action_kind || actor.role === null) return null;
  try {
    const action = found.scan.actions.find((item) => item.id === row.action_id);
    const allowed = original.action(row.action_id, row.action_kind);
    if (
      !action ||
      !allowed ||
      action.kind !== allowed.kind ||
      action.input !== allowed.input ||
      !visibleAction(found, actor, action, privacy) ||
      (action.input !== undefined && !original.inputVisible(action.input)) ||
      !privacy.safe(allowed.label) ||
      !original.valueSafe(action.id) ||
      !original.valueSafe(action.label) ||
      !original.valueSafe(allowed.label)
    )
      return null;
    return allowed;
  } catch {
    return null;
  }
}

/** Verify newest-first candidates until three complete, exposable scans are found. */
export async function cardLastScans(
  ctx: ServiceContext,
  actor: ScanActor,
  found: Found,
  privacy: CardPrivacy,
  reads: { scans: readonly CardHistoryRow[]; undoWindowMinutes: number },
  now: number,
): Promise<{ scans: ScanCard['lastScans']; selectedScans: CardHistoryRow[] }> {
  if (
    reads.scans.length === 0 ||
    found.pass.orgId !== actor.orgId ||
    found.pass.mode !== actor.mode
  )
    return { scans: [], selectedScans: [] };
  const currentPersonalization = found.passPersonalizationSnapshot;
  const project = async (row: CardHistoryRow): Promise<ScanCard['lastScans'][number] | null> => {
    if (
      !row.outcome ||
      row.org_id !== actor.orgId ||
      row.mode !== actor.mode ||
      row.pass_id !== found.pass.id ||
      row.template_id !== found.pass.templateId
    )
      return null;
    const original = await historicalCardPolicy(ctx, actor, found, currentPersonalization, row);
    const action = historicalAction(actor, found, privacy, original, row);
    if (!original || !action) return null;
    // A scanner name is free text: show it only when proven and safe, otherwise a generic label.
    const scannerName =
      typeof row.scanner_name === 'string' &&
      privacy.safe(row.scanner_name) &&
      original.scannerNameVisible(row.scanner_name)
        ? row.scanner_name
        : row.actor_type === 'user'
          ? 'Console'
          : 'Scanner';
    return {
      scanId: row.id,
      at: row.at,
      actionLabel: action.label,
      outcome: row.outcome,
      scannerName,
      undoable:
        row.outcome === 'ok' &&
        row.undone_by === null &&
        row.actor_key === actor.actorKey &&
        now - row.at <= reads.undoWindowMinutes * 60_000,
    };
  };
  const projected: ScanCard['lastScans'] = [];
  const selectedScans: CardHistoryRow[] = [];
  const candidateCount = Math.min(reads.scans.length, CARD_HISTORY_CANDIDATE_LIMIT);
  let offset = 0;
  while (offset < candidateCount && projected.length < 3) {
    const end = Math.min(candidateCount, offset + 3 - projected.length);
    const candidates = reads.scans.slice(offset, end);
    offset = end;
    const results = await Promise.all(candidates.map(project));
    for (const [index, row] of results.entries()) {
      if (!row) continue;
      const candidate = candidates[index];
      if (!candidate) throw new Error('Missing scan history candidate');
      projected.push(row);
      selectedScans.push(candidate);
    }
  }
  return { scans: projected, selectedScans };
}
