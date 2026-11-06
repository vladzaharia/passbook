import type { z } from 'zod';
import type { CheckInPolicy } from '@/shared/contracts/check-in.ts';
import type { CreateScannerSetupSchema, ScannerSetup } from '@/shared/contracts/scan-setups.ts';
import type { ScannerDto } from '@/shared/contracts/scanners.ts';
import { localZone } from '@/web/lib/timezones.ts';

/** The scanner form's values as text and booleans; one shape for the dialog and the detail page. */
export interface ScannerDraft {
  name: string;
  orgId: string;
  accepts: 'all' | 'event' | 'templates';
  kind: 'device' | 'terminal' | 'display';
  deviceRole: 'scan' | 'customer' | 'monitor';
  watch: { scannerIds: string[]; allOrg: boolean };
  adminUserId: string;
  eventId: string;
  templateIds: string[];
  flow: 'auto' | 'choose';
  staffSignIn: boolean;
  roleWithoutSignIn: 'door' | 'desk';
  letInAgain: 'anyone' | 'manager' | 'never';
  reader: 'none' | 'barcode';
  lookup: boolean;
  dailyAmount: number | null;
  checkIn: CheckInPolicy;
  direction: 'pass' | 'in' | 'out' | 'both';
  showPhoto: boolean;
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
  reader: 'none',
  lookup: false,
  dailyAmount: null,
  checkIn: {},
  direction: 'pass',
  showPhoto: true,
};

export function draftOf(s: ScannerDto & Partial<ScannerSetup>): ScannerDraft {
  const accepts = s.accepts;
  return {
    name: s.name,
    orgId: s.orgId,
    accepts: accepts && 'eventId' in accepts ? 'event' : accepts ? 'templates' : 'all',
    kind: s.kind,
    deviceRole: s.deviceRole,
    watch: s.watch ?? { scannerIds: [], allOrg: false },
    adminUserId: s.adminUser?.id ?? '',
    eventId: accepts && 'eventId' in accepts ? accepts.eventId : '',
    templateIds: accepts && 'templateIds' in accepts ? accepts.templateIds : [],
    flow: s.settings.flow,
    staffSignIn: s.settings.staffSignIn,
    roleWithoutSignIn: s.settings.roleWithoutSignIn,
    letInAgain: s.settings.letInAgain,
    // NFC stays off this wave; a scanner already set to it shows as no reader until it is changed.
    reader: s.settings.reader === 'barcode' ? 'barcode' : 'none',
    lookup: s.settings.lookup,
    dailyAmount: s.settings.dailyAmount,
    checkIn: s.settings.checkIn ?? {},
    direction: s.settings.direction ?? 'pass',
    showPhoto: s.settings.showPhoto ?? true,
  };
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
    ...(d.deviceRole !== 'scan' && !d.watch.allOrg && !d.watch.scannerIds.length
      ? { watch: 'Choose a scanner to follow.' }
      : {}),
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
  reader: d.reader,
  lookup: d.lookup,
  dailyAmount: d.dailyAmount,
  checkIn: d.checkIn,
  direction: d.direction === 'pass' ? undefined : d.direction,
  showPhoto: d.showPhoto,
});

export function createBody(d: ScannerDraft): z.input<typeof CreateScannerSetupSchema> {
  return {
    orgId: d.orgId,
    name: d.name.trim(),
    kind: d.kind,
    deviceRole: d.deviceRole,
    accepts: d.deviceRole === 'scan' ? acceptsOf(d) : null,
    watch: d.deviceRole === 'scan' ? null : d.watch,
    ...(d.adminUserId ? { adminUserId: d.adminUserId } : {}),
    settings: settingsOf(d),
    timeZone: localZone(),
  };
}
