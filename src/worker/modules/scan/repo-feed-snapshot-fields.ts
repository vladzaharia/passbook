import type { SqlValue } from '../../platform/db.ts';
import { toHex } from '../../platform/ids.ts';
import type { ScanLogRow } from './repo-feed-types.ts';

/** Private values are compared as marked scalar binds, never inside the metadata JSON. */
export const privateFields = [
  ['id', 'scan-id'],
  ['orgId', 'proof'],
  ['reason', 'history-reason'],
  ['actionId', 'history-action-id'],
  ['actionKind', 'proof'],
  ['passId', 'pass-id'],
  ['templateId', 'template-id'],
  ['amount', 'history-amount'],
  ['before', 'history-before-value'],
  ['after', 'history-after-value'],
  ['actorId', 'actor-id'],
  ['source.actorKey', 'actor-key'],
  ['source.scannerId', 'scanner-id'],
  ['source.eventId', 'event-id'],
  ['source.staffId', 'staff-id'],
  ['source.approvedBy', 'approver-id'],
  ['source.overrideOf', 'history-override-of'],
  ['source.undoes', 'scan-id'],
  ['source.undoneBy', 'history-undone-by'],
  ['source.presenceScope', 'history-presence-scope'],
  ['templateName', 'proof'],
  ['eventId', 'event-id'],
  ['eventName', 'event-name'],
  ['scannerId', 'scanner-id'],
  ['scannerName', 'scanner-name'],
  ['staffId', 'staff-id'],
  ['staffName', 'staff-name'],
  ['approvedBy', 'approver-id'],
  ['undoes', 'scan-id'],
  ['undoneBy', 'staff-name'],
  ['keySnapshot.passId', 'pass-id'],
  ['keySnapshot.orgId', 'proof'],
  ['keySnapshot.templateId', 'template-id'],
  ['keySnapshot.templateVersion', 'history-current-pinned-version'],
  ['keySnapshot.issuanceReleaseId', 'proof'],
  ['keySnapshot.identityId', 'history-current-identity-id'],
  ['keySnapshot.connectionId', 'history-current-connection-id'],
  ['keySnapshot.headId', 'proof'],
  ['keySnapshot.headVersion', 'history-current-active-version'],
  ['keySnapshot.headCandidateHash', 'proof'],
  ['keySnapshot.walletTemplateVersion', 'history-recorded-wallet-template-version'],
  ['eventProof.scan.walletTemplateVersion', 'history-recorded-wallet-template-version'],
  ['eventProof.scan.pinnedTemplateVersion', 'history-recorded-template-version'],
  ['eventProof.versionPersonalization', 'history-recorded-personalization'],
  ['eventProof.eventPinnedManifest', 'history-event-pinned-manifest'],
  ['eventProof.currentPersonalization', 'history-current-personalization'],
  ['eventProof.event.id', 'proof'],
  ['eventProof.event.org_id', 'proof'],
  ['eventProof.event.pass_id', 'history-ledger-pass-id'],
  ['eventProof.event.device', 'history-ledger-device'],
  ['eventProof.event.actor_id', 'history-ledger-actor-id'],
  ['eventProof.event.data', 'history-ledger-data'],
  ['eventProof.eventWalletVersion', 'history-recorded-wallet-template-version'],
  ['eventProof.eventWalletManifest', 'history-event-wallet-manifest'],
  ['eventProof.eventActiveVersion', 'history-event-active-version'],
  ['eventProof.eventActiveManifest', 'history-event-active-manifest'],
  ['eventProof.eventLegacyVersion', 'history-event-active-version'],
  ['eventProof.eventLegacyManifest', 'history-event-active-manifest'],
] as const;
export const privateIndexes = new Map<string, number>(
  privateFields.map(([path], index) => [path, index]),
);
const encoder = new TextEncoder();

export function privateValue(row: ScanLogRow, path: string): SqlValue {
  let value: unknown = row;
  for (const part of path.split('.')) {
    if (value === null || typeof value !== 'object') return null;
    value = (value as Record<string, unknown>)[part];
  }
  if (typeof value === 'string') return toHex(encoder.encode(value)).toUpperCase();
  if (value === null || value === undefined || typeof value === 'number') return value;
  throw new Error('Invalid feed snapshot value.');
}

/** A hex string is bound and compared in slices of this many characters (half as many bytes). */
export const HEX_SLICE = 750_000;
