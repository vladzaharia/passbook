import type { z } from 'zod';
import type { CreateScannerSchema, ScannerDto } from '@/shared/contracts/scanners.ts';
import { localZone } from '@/web/lib/timezones.ts';

/** The scanner form's values as text and booleans; one shape for the dialog and the detail page. */
export interface ScannerDraft {
  name: string;
  orgId: string;
  accepts: 'event' | 'templates';
  eventId: string;
  templateIds: string[];
  flow: 'auto' | 'choose';
  staffSignIn: boolean;
  roleWithoutSignIn: 'door' | 'desk';
  letInAgain: 'anyone' | 'manager' | 'never';
  reader: 'none' | 'barcode';
  lookup: boolean;
  dailyAmount: number | null;
}

export const EMPTY_DRAFT: ScannerDraft = {
  name: '',
  orgId: '',
  accepts: 'templates',
  eventId: '',
  templateIds: [],
  flow: 'auto',
  staffSignIn: false,
  roleWithoutSignIn: 'door',
  letInAgain: 'anyone',
  reader: 'none',
  lookup: false,
  dailyAmount: null,
};

export function draftOf(s: ScannerDto): ScannerDraft {
  const accepts = s.accepts;
  return {
    name: s.name,
    orgId: s.orgId,
    accepts: accepts && 'eventId' in accepts ? 'event' : 'templates',
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
  };
}

/** Field errors for the values; the server's messages follow for the rest. */
export function draftErrors(d: ScannerDraft, needsOrg: boolean): Partial<Record<string, string>> {
  return {
    ...(d.name.trim() ? {} : { name: 'Required.' }),
    ...(needsOrg && !d.orgId ? { orgId: 'Pick an organization.' } : {}),
    ...(d.accepts === 'event' && !d.eventId ? { eventId: 'Pick an event.' } : {}),
    ...(d.accepts === 'templates' && d.templateIds.length === 0
      ? { templateIds: 'Pick at least one template.' }
      : {}),
  };
}

export const acceptsOf = (d: ScannerDraft) =>
  d.accepts === 'event' ? { eventId: d.eventId } : { templateIds: d.templateIds };

export const settingsOf = (d: ScannerDraft) => ({
  flow: d.flow,
  staffSignIn: d.staffSignIn,
  roleWithoutSignIn: d.roleWithoutSignIn,
  letInAgain: d.letInAgain,
  reader: d.reader,
  lookup: d.lookup,
  dailyAmount: d.dailyAmount,
});

export function createBody(d: ScannerDraft): z.input<typeof CreateScannerSchema> {
  return {
    orgId: d.orgId,
    name: d.name.trim(),
    kind: 'device',
    accepts: acceptsOf(d),
    settings: settingsOf(d),
    timeZone: localZone(),
  };
}
