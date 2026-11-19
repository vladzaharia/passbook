import { ScanReasonSchema, type ScanRecordDto } from '../../../shared/contracts/index.ts';
import type { ScanActor } from './guard.ts';
import type { HistoryPolicy } from './history-policy.ts';
import type { HistoryRow } from './history-row.ts';

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
  row: HistoryRow,
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
  // A passless refusal has no pass or event-time policy to fence, so the console shows who recorded
  // it, by current name: a renamed scanner shows its new name on old rows, unlike pass-bearing rows.
  // The same audience (scanning:read) already lists scanners and staff by name.
  const passless =
    row.passlessProofCandidate && row.policyAvailable && row.passId === null && actor.role !== null;
  const scannerName = passless
    ? row.scannerName
    : authorized && history.scannerNameVisible(row.scannerName)
      ? row.scannerName
      : null;
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
    staffName: verified || passless ? row.staffName : null,
    apiKeyId: verified ? row.apiKeyId : null,
    approvedBy: verified ? row.approvedBy : null,
    method: row.method,
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
