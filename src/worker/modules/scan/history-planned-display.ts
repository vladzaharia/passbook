import type { EventRow } from '../events/repo.ts';
import type { ScanActor } from './actor.ts';
import { displayRowOf, isDisplayCheckIn } from './history-display-read.ts';
import { currentHistoryTitle, type HistoryManifest, historyPolicy } from './history-policy.ts';
import { privateValues } from './history-row-evidence.ts';
import type { PendingDisplayRow } from './repo-pending-display-history.ts';
import type { Finalize } from './repo-scans.ts';
import type { Found } from './resolve.ts';
import type { DisplayRow } from './scan-display-history-view.ts';
import { type ScanEventReference, verifyScanEventProvenance } from './scan-event-proof.ts';

/** The scan this request will commit, as a display lists it. Only `appendPlannedDisplayHistory` reads it. */
export interface PlannedDisplayScan {
  readonly id: string;
  readonly orgId: string;
  readonly mode: Found['pass']['mode'];
  readonly passId: string;
  readonly templateId: string;
  readonly eventId: string | null;
  readonly credentialKeysetCommitment: string;
  /** Null when this scan is not one a display lists; it still counts in the pass's history. */
  readonly row: DisplayRow | null;
}

function manifest(version: string | null, raw: string | null): HistoryManifest | null {
  if (!version || !raw) return null;
  try {
    const value: unknown = JSON.parse(raw);
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    return { version, manifest: value as HistoryManifest['manifest'] };
  } catch {
    return null;
  }
}

/**
 * Evaluate the scan a request is about to commit from the pass state it was claimed under and the
 * event it will record. Null unless the event's own provenance holds and the pass is current.
 */
export async function plannedDisplayScan(
  env: object,
  actor: ScanActor,
  found: Found,
  input: {
    row: PendingDisplayRow;
    keyset: string;
    event: EventRow;
    final: Finalize;
    eventId: string | null;
  },
): Promise<PlannedDisplayScan | null> {
  const { row, keyset, event, final, eventId } = input;
  const walletVersion = row.recorded_wallet_version;
  const secrets = privateValues(row);
  if (
    !row.recorded_template_version ||
    typeof walletVersion !== 'number' ||
    secrets === null ||
    typeof row.current_lifecycle_generation !== 'number' ||
    !Number.isSafeInteger(row.current_lifecycle_generation) ||
    row.current_lifecycle_generation < 0
  )
    return null;
  const planned: ScanEventReference & { undoneBy: null } = {
    id: final.id,
    orgId: row.org_id,
    mode: row.mode,
    passId: final.passId,
    templateId: final.templateId,
    scannerId: row.scanner_id,
    eventId,
    actorKey: row.actor_key,
    staffId: row.staff_id,
    actionId: final.actionId,
    actionKind: final.actionKind,
    outcome: final.outcome,
    reason: final.reason,
    passVersion: final.passVersion,
    method: row.method,
    at: row.at,
    state: 'done',
    pinnedTemplateVersion: row.recorded_template_version,
    walletVersion,
    walletTemplateVersion: row.recorded_wallet_template_version,
    direction: final.direction ?? null,
    presenceScope: final.presenceScope ?? null,
    undoneBy: null,
  };
  if (!(await verifyScanEventProvenance(env, event, planned))) return null;
  const currentPinned = manifest(row.current_pinned_version, row.current_pinned_manifest);
  const policy = isDisplayCheckIn(
    {
      passId: final.passId,
      templateId: final.templateId,
      actionKind: final.actionKind,
      outcome: final.outcome,
      undoneBy: null,
      amount: row.amount,
      before: row.before_value,
      after: row.after_value,
    },
    { passId: found.pass.id, templateId: found.pass.templateId },
  )
    ? await historyPolicy(env, {
        event,
        scan: planned,
        credentialKeysetCommitment: keyset,
        currentPersonalization: row.current_personalization,
        versionPersonalization: row.recorded_personalization,
        currentCredentialGeneration: row.current_credential_generation,
        transferPending: row.current_transfer_pending !== 0,
        eventPinned: manifest(row.recorded_template_version, row.event_pinned_manifest),
        eventWallet: manifest(row.recorded_wallet_template_version, row.event_wallet_manifest),
        eventActive: manifest(row.event_active_version, row.event_active_manifest),
        currentPinned,
        currentActive: manifest(row.current_active_version, row.current_active_manifest),
        currentTitle: currentHistoryTitle(currentPinned, row.current_personalization),
        currentScannerName: row.current_scanner_name,
        privateValues: secrets,
        role: actor.role,
      })
    : null;
  return Object.freeze({
    id: final.id,
    orgId: row.org_id,
    mode: row.mode,
    passId: found.pass.id,
    templateId: found.pass.templateId,
    eventId,
    credentialKeysetCommitment: keyset,
    row: displayRowOf(
      policy,
      { id: final.id, at: row.at, actionId: final.actionId, actionKind: final.actionKind },
      { id: row.scanner_id, name: row.current_scanner_name },
    ),
  });
}
