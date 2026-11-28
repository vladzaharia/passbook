import type { CheckInPolicy } from '@/shared/contracts/check-in.ts';
import type { ScannerSetup } from '@/shared/contracts/scan-setups.ts';
import type { ScannerDto } from '@/shared/contracts/scanners.ts';

/** What a monitor follows. A field that is present (even empty) is the chosen kind of watch. */
export interface WatchDraft {
  scannerIds: string[];
  allOrg: boolean;
  sessionIds?: string[];
  eventId?: string;
  zoneIds?: string[];
}

export type WatchKind = 'scanners' | 'sessions' | 'event' | 'zones';
export const watchKind = (w: WatchDraft): WatchKind =>
  w.zoneIds ? 'zones' : w.eventId !== undefined ? 'event' : w.sessionIds ? 'sessions' : 'scanners';

/** The body's watch: empty parts drop out, the contract's strict object takes the rest. */
export const watchOf = (w: WatchDraft) => ({
  scannerIds: w.scannerIds,
  allOrg: w.allOrg,
  ...(w.sessionIds?.length ? { sessionIds: w.sessionIds } : {}),
  ...(w.eventId ? { eventId: w.eventId } : {}),
  ...(w.zoneIds?.length ? { zoneIds: w.zoneIds } : {}),
});

/** Scanner settings in editable admin forms, represented as text and booleans. */
export interface ScannerDraft {
  name: string;
  orgId: string;
  accepts: 'all' | 'event' | 'templates';
  kind: 'device' | 'terminal' | 'display';
  deviceRole: 'scan' | 'customer' | 'monitor';
  watch: WatchDraft;
  adminUserId: string;
  eventId: string;
  templateIds: string[];
  flow: 'auto' | 'choose';
  staffSignIn: boolean;
  roleWithoutSignIn: 'door' | 'desk';
  letInAgain: 'anyone' | 'manager' | 'never';
  /** Whose PIN approves a risky action. `set` and hard refusals always need a Manager. */
  approvals: 'managers' | 'desk';
  /** Full is final at this door, for every role. */
  hardLimit: boolean;
  reader: 'none' | 'barcode';
  lookup: boolean;
  dailyAmount: number | null;
  checkIn: CheckInPolicy;
  direction: 'pass' | 'in' | 'out' | 'both';
  showPhoto: boolean;
  /** A desk monitor may let people in and mark them out. */
  deskActions: boolean;
}

export const EMPTY_DRAFT: ScannerDraft = {
  name: '',
  orgId: '',
  accepts: 'templates',
  kind: 'device',
  deviceRole: 'scan',
  watch: { scannerIds: [], allOrg: false },
  adminUserId: '',
  eventId: '',
  templateIds: [],
  flow: 'auto',
  staffSignIn: false,
  roleWithoutSignIn: 'door',
  letInAgain: 'anyone',
  approvals: 'managers',
  hardLimit: false,
  reader: 'none',
  lookup: false,
  dailyAmount: null,
  checkIn: {},
  direction: 'pass',
  showPhoto: true,
  deskActions: false,
};

export function draftOf(s: ScannerDto & Partial<ScannerSetup>): ScannerDraft {
  const accepts = s.accepts;
  return {
    name: s.name,
    orgId: s.orgId,
    accepts: accepts && 'eventId' in accepts ? 'event' : accepts ? 'templates' : 'all',
    kind: s.kind,
    // Kiosks are created by K0's flow, never this draft.
    deviceRole: s.deviceRole === 'kiosk' ? 'scan' : s.deviceRole,
    watch: s.watch ?? { scannerIds: [], allOrg: false },
    adminUserId: s.adminUser?.id ?? '',
    eventId: accepts && 'eventId' in accepts ? accepts.eventId : '',
    templateIds: accepts && 'templateIds' in accepts ? accepts.templateIds : [],
    flow: s.settings.flow,
    staffSignIn: s.settings.staffSignIn,
    roleWithoutSignIn: s.settings.roleWithoutSignIn,
    letInAgain: s.settings.letInAgain,
    approvals: s.settings.approvals ?? 'managers',
    hardLimit: s.settings.hardLimit ?? false,
    // NFC stays off this wave; a scanner already set to it shows as no reader until it is changed.
    reader: s.settings.reader === 'barcode' ? 'barcode' : 'none',
    lookup: s.settings.lookup,
    dailyAmount: s.settings.dailyAmount,
    checkIn: s.settings.checkIn ?? {},
    direction: s.settings.direction ?? 'pass',
    showPhoto: s.settings.showPhoto ?? true,
    deskActions: s.settings.deskActions ?? false,
  };
}

function watchError(w: WatchDraft): string | undefined {
  switch (watchKind(w)) {
    case 'zones':
      return w.zoneIds?.length ? undefined : 'Choose a zone.';
    case 'event':
      return w.eventId ? undefined : 'Pick an event.';
    case 'sessions':
      return w.sessionIds?.length ? undefined : 'Choose a session.';
    default:
      return w.allOrg || w.scannerIds.length ? undefined : 'Choose a scanner to follow.';
  }
}

/** Field errors for the values; the server's messages follow for the rest. */
export function draftErrors(d: ScannerDraft, needsOrg: boolean): Partial<Record<string, string>> {
  return {
    ...(d.name.trim() ? {} : { name: 'Required.' }),
    ...(needsOrg && !d.orgId ? { orgId: 'Pick an organization.' } : {}),
    ...(d.deviceRole === 'scan' && d.accepts === 'event' && !d.eventId
      ? { eventId: 'Pick an event.' }
      : {}),
    ...(d.deviceRole === 'scan' && d.accepts === 'templates' && d.templateIds.length === 0
      ? { templateIds: 'Pick at least one template.' }
      : {}),
    ...(d.deviceRole !== 'scan' && watchError(d.watch) ? { watch: watchError(d.watch) } : {}),
  };
}

export const acceptsOf = (d: ScannerDraft) =>
  d.accepts === 'all'
    ? null
    : d.accepts === 'event'
      ? { eventId: d.eventId }
      : { templateIds: d.templateIds };

export const settingsOf = (d: ScannerDraft) => ({
  flow: d.flow,
  staffSignIn: d.staffSignIn,
  roleWithoutSignIn: d.roleWithoutSignIn,
  letInAgain: d.letInAgain,
  approvals: d.approvals,
  hardLimit: d.hardLimit,
  reader: d.reader,
  lookup: d.lookup,
  dailyAmount: d.dailyAmount,
  checkIn: d.checkIn,
  direction: d.direction === 'pass' ? undefined : d.direction,
  showPhoto: d.showPhoto,
  // Settings merge on the server: a monitor says it either way so Off sticks.
  ...(d.deskActions || d.deviceRole === 'monitor' ? { deskActions: d.deskActions } : {}),
});
