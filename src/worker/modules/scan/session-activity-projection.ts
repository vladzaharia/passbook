import type { ScanRole } from '../../../shared/contracts/scan.ts';
import { UnavailableError } from '../../platform/errors.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { credentialReferences } from '../passes/credential-references.ts';
import { type HistoryPolicy, historyPolicy } from './history-policy.ts';
import { historyProofPolicySources, type VerifiedHistoryProof } from './history-proof.ts';
import type { ScanningSessionRow } from './repo-scanning-sessions.ts';
import type { ActivityCandidate, ActivityReadRow } from './repo-session-activity.ts';
import type { ScanEventProofCache } from './scan-event-proof.ts';

interface PreparedProjection {
  candidate: ActivityCandidate;
  proof: VerifiedHistoryProof;
  policy: HistoryPolicy;
  title: string | null;
  directionAllowed: boolean;
  refs: string[];
}

export const unavailable = () =>
  new UnavailableError('Scanning activity is unavailable.', 'SCANNING_ACTIVITY_UNAVAILABLE');
export const keysetUnavailable = () =>
  new UnavailableError(
    'Credential references are unavailable.',
    'CREDENTIAL_REF_KEYSET_UNAVAILABLE',
  );

/** Distinguish an empty authorized page from a missing read or stale authority. */
export function candidatesOf(result: D1Result | undefined): ActivityCandidate[] | null {
  if (!result || !Array.isArray(result.results) || result.results.length === 0) throw unavailable();
  const rows = result.results as unknown as ActivityReadRow[];
  const status = rows[0];
  if (!status) throw unavailable();
  if (status.authorized !== 1) return null;
  if (status.keyset !== 1) throw keysetUnavailable();
  if (status.id === null) {
    if (rows.length !== 1) throw unavailable();
    return [];
  }
  const nullableText = (value: unknown) => value === null || typeof value === 'string';
  for (const row of rows) {
    if (
      row.authorized !== 1 ||
      row.keyset !== 1 ||
      typeof row.id !== 'string' ||
      typeof row.at !== 'number' ||
      !Number.isSafeInteger(row.at) ||
      typeof row.deviceId !== 'string' ||
      typeof row.deviceName !== 'string' ||
      !nullableText(row.passId) ||
      !nullableText(row.eventId) ||
      !nullableText(row.templateId) ||
      !nullableText(row.serial) ||
      !nullableText(row.scanCode) ||
      !nullableText(row.barcodeHash) ||
      !nullableText(row.lookupHash) ||
      !nullableText(row.barcodeMessage) ||
      !nullableText(row.lookupValue) ||
      (row.outcome !== 'ok' &&
        row.outcome !== 'heads_up' &&
        row.outcome !== 'refused' &&
        row.outcome !== 'undone') ||
      (row.direction !== null && row.direction !== 'in' && row.direction !== 'out')
    )
      throw unavailable();
  }
  // The complete candidate shape was checked above, including every nullable field.
  return rows as unknown as ActivityCandidate[];
}

export function sameCandidate(a: ActivityCandidate, b: ActivityCandidate): boolean {
  return (
    a.id === b.id &&
    a.at === b.at &&
    a.deviceId === b.deviceId &&
    a.deviceName === b.deviceName &&
    a.passId === b.passId &&
    a.eventId === b.eventId &&
    a.templateId === b.templateId &&
    a.outcome === b.outcome &&
    a.direction === b.direction &&
    a.serial === b.serial &&
    a.scanCode === b.scanCode &&
    a.barcodeHash === b.barcodeHash &&
    a.lookupHash === b.lookupHash &&
    a.barcodeMessage === b.barcodeMessage &&
    a.lookupValue === b.lookupValue
  );
}

export async function prepareProjection(
  ctx: ServiceContext,
  row: ScanningSessionRow,
  role: ScanRole,
  candidate: ActivityCandidate,
  proof: VerifiedHistoryProof | undefined,
  proofCache: ScanEventProofCache,
): Promise<PreparedProjection | null> {
  if (!candidate.passId || !proof?.projectionCurrent) return null;
  const source = historyProofPolicySources(proof);
  if (
    !source ||
    source.scan.id !== candidate.id ||
    source.scan.passId !== candidate.passId ||
    source.scan.scannerId !== candidate.deviceId ||
    source.scan.eventId !== candidate.eventId ||
    source.scan.templateId !== candidate.templateId ||
    source.scan.at !== candidate.at ||
    (source.scan.undoneBy ? 'undone' : source.scan.outcome) !== candidate.outcome ||
    source.scan.direction !== candidate.direction ||
    source.currentScannerName !== candidate.deviceName
  )
    return null;
  let event: unknown;
  try {
    event = JSON.parse(source.event.data);
  } catch {
    return null;
  }
  if (
    !event ||
    typeof event !== 'object' ||
    !('authority' in event) ||
    !event.authority ||
    typeof event.authority !== 'object' ||
    (candidate.barcodeHash !== null && !/^[0-9a-f]{64}$/.test(candidate.barcodeHash)) ||
    (candidate.lookupHash !== null && !/^[0-9a-f]{64}$/.test(candidate.lookupHash))
  )
    return null;
  const values = {
    serial: candidate.serial,
    scanCode: candidate.scanCode,
    barcodeHash: candidate.barcodeHash,
    lookupHash: candidate.lookupHash,
    barcodeMessage: candidate.barcodeMessage,
    lookupValue: candidate.lookupValue,
  };
  const [policy, own] = await Promise.all([
    historyPolicy(ctx.env, { ...source, role, proofCache }),
    credentialReferences(ctx.env, row.org_id, row.mode, values),
  ]);
  if (!policy) return null;
  return {
    candidate,
    proof,
    policy,
    title: source.currentTitle,
    directionAllowed: policy.action(source.scan.actionId, source.scan.actionKind) !== null,
    refs: [...new Set(own.map((entry) => entry.ref))],
  };
}
