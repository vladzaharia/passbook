import type { ScanRole, TemplateManifest } from '../../../passkit/types.ts';
import type { ResolvedScanAction } from '../../../shared/scan-defaults.ts';
import type { EventRow } from '../events/repo.ts';
import { captureCredentialKeyEnv } from '../passes/credential-keyset.ts';
import { verifyEventScannerNameHash, verifyEventTitleHash } from './event-safe-projection.ts';
import { evaluatedHistoryPolicy } from './history-policy-evaluation.ts';
import { deriveCurrentHistoryTitle } from './history-policy-title.ts';
import { validCredentialKeysetCommitment } from './repo-credential-tombstones.ts';
import { ROLE_RANK } from './rules.ts';
import {
  type ScanEventProofCache,
  type ScanEventReference,
  verifiedScanPersonalizationSource,
  verifyScanEventProvenance,
} from './scan-event-proof.ts';

export interface HistoryManifest {
  version: string;
  manifest: TemplateManifest;
}

export interface HistoryPolicyInput {
  event: EventRow;
  scan: ScanEventReference;
  currentPersonalization: string | null;
  versionPersonalization: string | null;
  /** Original current-pass credential/transfer snapshot, rechecked in the final authority batch. */
  currentCredentialGeneration: number | null;
  transferPending: boolean;
  credentialKeysetCommitment: string;
  eventPinned: HistoryManifest | null;
  eventWallet?: HistoryManifest | null;
  eventActive: HistoryManifest | null;
  currentPinned: HistoryManifest | null;
  currentActive: HistoryManifest | null;
  currentTitle?: string | null;
  currentScannerName?: string | null;
  /** Request-local credential denylist; never projected or logged. */
  privateValues?: readonly string[];
  proofCache?: ScanEventProofCache;
  role: ScanRole | null;
}

export interface HistoryPolicy {
  action(id: string | null, kind: string | null): ResolvedScanAction | null;
  inputVisible(path: string): boolean;
  valueSafe(value: unknown): boolean;
  titleVisible(title: string | null): boolean;
  scannerNameVisible(name: string | null): boolean;
}

export interface VerifiedEventRoleProjection {
  role: ScanRole;
  action: { kind: string; labelHash: string } | null;
  scannerNameHash: string | null;
  titleHash: string | null;
}

type ObjectValue = Record<string, unknown>;
const object = (value: unknown): ObjectValue | null =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as ObjectValue)
    : null;

function personalization(raw: string | null): ObjectValue | null {
  if (raw === null) return null;
  try {
    return object(JSON.parse(raw));
  } catch {
    return null;
  }
}

/** Derive a title from the selected current manifest and personalization, not a cached pass title. */
export function currentHistoryTitle(
  template: HistoryManifest | null,
  raw: string | null,
): string | null {
  return deriveCurrentHistoryTitle(template, raw);
}

function authority(event: EventRow): ObjectValue | null {
  try {
    const data = object(JSON.parse(event.data));
    return data ? object(data.authority) : null;
  } catch {
    return null;
  }
}

/** Select a signed role entry only after verifying the universal event proof. */
export async function verifiedEventRoleProjection(
  env: object,
  event: EventRow,
  scan: ScanEventReference,
  currentRole: ScanRole | null,
  proofCache?: ScanEventProofCache,
): Promise<VerifiedEventRoleProjection | null> {
  const keys = captureCredentialKeyEnv(env);
  const capturedEvent = { ...event };
  const capturedScan = { ...scan };
  if (
    !currentRole ||
    !Object.hasOwn(ROLE_RANK, currentRole) ||
    !(await verifyScanEventProvenance(keys, capturedEvent, capturedScan, proofCache))
  )
    return null;
  const signed = authority(capturedEvent);
  const eventRole = signed?.role;
  if (eventRole !== 'door' && eventRole !== 'desk' && eventRole !== 'manager') return null;
  const role = ROLE_RANK[currentRole] < ROLE_RANK[eventRole] ? currentRole : eventRole;
  const projection = signed ? object(signed.eventProjection) : null;
  const roles = projection ? object(projection.roles) : null;
  const entry = roles ? object(roles[role]) : null;
  if (
    projection?.v !== 1 ||
    !entry ||
    !Object.hasOwn(entry, 'action') ||
    !Object.hasOwn(entry, 'scannerNameHash') ||
    !Object.hasOwn(entry, 'titleHash')
  )
    return null;
  const rawAction = entry.action === null ? null : object(entry.action);
  if (
    entry.action !== null &&
    (!rawAction ||
      capturedScan.actionId === null ||
      typeof rawAction.kind !== 'string' ||
      typeof rawAction.labelHash !== 'string' ||
      !/^[0-9a-f]{64}$/.test(rawAction.labelHash) ||
      rawAction.kind !== capturedScan.actionKind)
  )
    return null;
  const scannerNameHash = entry.scannerNameHash;
  const titleHash = entry.titleHash;
  if (
    (scannerNameHash !== null &&
      (typeof scannerNameHash !== 'string' || !/^[0-9a-f]{64}$/.test(scannerNameHash))) ||
    (titleHash !== null && (typeof titleHash !== 'string' || !/^[0-9a-f]{64}$/.test(titleHash)))
  )
    return null;
  return {
    role,
    action: rawAction
      ? { kind: String(rawAction.kind), labelHash: String(rawAction.labelHash) }
      : null,
    scannerNameHash,
    titleHash,
  };
}

/**
 * Intersect the four policies with the actor's current and signed event-time role. The caller
 * must select the manifests from the exact scoped versions and revalidate the current pass/head;
 * the event and historical personalization are independently authenticated here. No Wallet JSON
 * or R2 reads are needed.
 */
export async function historyPolicy(
  env: object,
  request: HistoryPolicyInput,
): Promise<HistoryPolicy | null> {
  const keys = captureCredentialKeyEnv(env);
  const snapshot = (source: HistoryManifest | null | undefined): HistoryManifest | null =>
    source ? { version: source.version, manifest: structuredClone(source.manifest) } : null;
  const input: HistoryPolicyInput = {
    ...request,
    event: { ...request.event },
    scan: { ...request.scan },
    eventPinned: snapshot(request.eventPinned),
    eventWallet: snapshot(request.eventWallet),
    eventActive: snapshot(request.eventActive),
    currentPinned: snapshot(request.currentPinned),
    currentActive: snapshot(request.currentActive),
    ...(request.privateValues === undefined ? {} : { privateValues: [...request.privateValues] }),
  };
  const { event, scan, eventPinned, eventActive, currentPinned, currentActive } = input;
  if (
    !eventPinned ||
    !eventActive ||
    !currentPinned ||
    !currentActive ||
    !input.role ||
    !Object.hasOwn(ROLE_RANK, input.role)
  )
    return null;
  const signed = authority(event);
  if (
    !signed ||
    eventPinned.version !== scan.pinnedTemplateVersion ||
    signed.pinnedTemplateVersion !== eventPinned.version ||
    input.transferPending !== false ||
    !validCredentialKeysetCommitment(input.credentialKeysetCommitment) ||
    typeof input.currentCredentialGeneration !== 'number' ||
    !Number.isSafeInteger(input.currentCredentialGeneration) ||
    input.currentCredentialGeneration <= 0 ||
    signed.credentialGeneration !== input.currentCredentialGeneration ||
    signed.noPendingTransfer !== true ||
    typeof signed.activeTemplateVersion !== 'string' ||
    signed.activeTemplateVersion !== eventActive.version ||
    (signed.activeReleaseId !== null && signed.activeReleaseVersion !== eventActive.version)
  )
    return null;
  const proofCache = input.proofCache ?? new Map<string, Promise<boolean>>();
  const selected = await verifiedScanPersonalizationSource(
    keys,
    event,
    scan,
    input.currentPersonalization,
    input.versionPersonalization,
    proofCache,
  );
  if (!selected) return null;
  const roleProjection = await verifiedEventRoleProjection(
    keys,
    event,
    scan,
    input.role,
    proofCache,
  );
  if (!roleProjection) return null;
  const { role, action: signedAction, scannerNameHash, titleHash } = roleProjection;
  const currentTitle = input.currentTitle ?? null;
  const titleCommitted =
    currentTitle !== null &&
    titleHash !== null &&
    scan.passId !== null &&
    (await verifyEventTitleHash(keys, {
      orgId: scan.orgId,
      passId: scan.passId,
      scanId: scan.id,
      role,
      title: currentTitle,
      hash: titleHash,
    }));
  const currentScannerName = input.currentScannerName ?? null;
  const scannerNameCommitted =
    currentScannerName !== null &&
    scannerNameHash !== null &&
    scan.passId !== null &&
    (await verifyEventScannerNameHash(keys, {
      orgId: scan.orgId,
      passId: scan.passId,
      scanId: scan.id,
      role,
      scannerName: currentScannerName,
      hash: scannerNameHash,
    }));
  const eventWallet =
    input.eventWallet &&
    typeof signed.walletTemplateVersion === 'string' &&
    signed.walletTemplateVersion.length > 0 &&
    signed.walletTemplateVersion === input.eventWallet.version &&
    scan.walletTemplateVersion === input.eventWallet.version
      ? input.eventWallet
      : null;
  if (selected === 'version' && !eventWallet) return null;
  const historical = personalization(
    selected === 'current' ? input.currentPersonalization : input.versionPersonalization,
  );
  const current = personalization(input.currentPersonalization);
  if (!historical || !current) return null;
  const manifests = [
    eventPinned.manifest,
    eventActive.manifest,
    currentPinned.manifest,
    currentActive.manifest,
  ];
  return evaluatedHistoryPolicy({
    keys,
    scan,
    role,
    signedAction,
    currentPinned,
    currentActive,
    eventWallet,
    selected,
    currentTitle,
    titleCommitted,
    currentScannerName,
    scannerNameCommitted,
    manifests,
    historical,
    current,
    privateValues: input.privateValues,
  });
}
