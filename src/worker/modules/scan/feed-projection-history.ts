import { ScanReasonSchema, type ScanRecordDto } from '../../../shared/contracts/index.ts';
import type { ScanRole } from '../../../shared/contracts/scan.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { canonicalJson } from '../templates/package/hash.ts';
import type { ScanActor } from './guard.ts';
import { type HistoryPolicy, historyPolicy } from './history-policy.ts';
import { historyProofPolicySources, type VerifiedHistoryProof } from './history-proof.ts';
import type { ScanLogRow } from './repo-feed.ts';
import type { ScanEventProofCache } from './scan-event-proof.ts';

/** Verify the event-time policy against the same current pass snapshot used for projection. */
export async function historyOf(
  ctx: ServiceContext,
  row: ScanLogRow,
  proof: VerifiedHistoryProof,
  role: ScanRole | null,
  proofCache: ScanEventProofCache,
): Promise<HistoryPolicy | null> {
  const original = row.eventProof;
  if (!row.policyAvailable || !original || !proof.projectionCurrent || !role) return null;
  const sources = historyProofPolicySources(proof);
  if (
    !sources ||
    canonicalJson(original.event) !== canonicalJson(sources.event) ||
    sources.currentScannerName !== row.scannerName
  )
    return null;
  const scan = sources.scan as unknown as Record<string, unknown>;
  if (Object.entries(original.scan).some(([key, value]) => !Object.is(scan[key], value)))
    return null;
  return historyPolicy(ctx.env, {
    ...sources,
    credentialKeysetCommitment: proof.credentialKeysetCommitment,
    role,
    currentScannerName: row.scannerName,
    proofCache,
  });
}

/** A stored effect value, or null when the viewer's policy finds it unsafe (contact data, a hidden input). */
export function effectValue(
  raw: string | null,
  history: HistoryPolicy | null,
): ScanRecordDto['before'] {
  if (raw === null) return null;
  let value: ScanRecordDto['before'] = raw;
  try {
    value = JSON.parse(raw) as ScanRecordDto['before'];
  } catch {
    // A stored effect value which is not JSON is plain text, which is a valid JSON value.
  }
  return history && !history.valueSafe(value) ? null : value;
}

/** Project only after the row's provenance and the viewer's current policy have been checked. */
export function projectScanRecord(
  row: ScanLogRow,
  currentTitle: string | null,
  actor: ScanActor,
  history: HistoryPolicy | null,
): ScanRecordDto {
  const authorized =
    row.policyAvailable && row.passId !== null && actor.role !== null && history !== null;
  const noPolicy = !row.policyAvailable || (row.passId !== null && !authorized);
  // Names come from org- and mode-scoped joins. Effect values also need the action to be visible.
  const verified = authorized;
  const reason = ScanReasonSchema.safeParse(row.reason);
  const action = authorized ? history.action(row.actionId, row.actionKind) : null;
  const title = authorized && history.titleVisible(currentTitle) ? currentTitle : null;
  const scannerName =
    authorized && history.scannerNameVisible(row.scannerName) ? row.scannerName : null;
  return {
    id: row.id,
    at: row.at,
    outcome: row.outcome ?? 'refused',
    reason: reason.success ? reason.data : null,
    kind: action?.kind ?? null,
    actionId: action?.id ?? null,
    actionLabel: action?.label ?? null,
    direction: action ? row.direction : null,
    passId: noPolicy ? null : row.passId,
    passTitle: title,
    templateId: noPolicy ? null : row.templateId,
    templateName: verified ? row.templateName : null,
    eventId: row.policyAvailable || row.passlessProofCandidate ? row.eventId : null,
    eventName: verified ? row.eventName : null,
    scannerId: row.policyAvailable ? row.scannerId : null,
    scannerName,
    staffId: row.policyAvailable ? row.staffId : null,
    staffName: verified ? row.staffName : null,
    approvedBy: verified ? row.approvedBy : null,
    method: row.method === 'auto' ? 'manual' : row.method,
    amount: action ? row.amount : null,
    before: action ? effectValue(row.before, history) : null,
    after: action ? effectValue(row.after, history) : null,
    passVersion: noPolicy ? null : row.passVersion,
    override: row.override,
    offline: row.offline,
    actor: { type: row.actorType === 'user' ? 'user' : 'scanner', id: row.actorId },
    undoneAt: row.undoneAt,
    undoneBy: verified ? row.undoneBy : null,
    undoes: action ? row.undoes : null,
  };
}
