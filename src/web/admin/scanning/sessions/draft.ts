import type { ScanningSession } from '@/shared/contracts/scanning-sessions.ts';
import { localZone } from '@/web/lib/timezones.ts';
import {
  acceptsOf,
  EMPTY_DRAFT,
  type ScannerDraft,
  settingsOf,
} from '../scanners/scanner-draft.ts';

export type SessionDraft = ScannerDraft & { timeZone: string };

export const emptySessionDraft = (): SessionDraft => ({
  ...EMPTY_DRAFT,
  timeZone: localZone(),
  accepts: 'all',
  lookup: true,
});
export function sessionDraft(s: ScanningSession): SessionDraft {
  return {
    ...emptySessionDraft(),
    name: s.name,
    timeZone: s.timeZone,
    orgId: s.orgId,
    accepts:
      s.accepts && 'eventId' in s.accepts
        ? 'event'
        : s.accepts
          ? 'templates'
          : s.settings.acceptAllTemplates
            ? 'all'
            : 'templates',
    eventId: s.accepts && 'eventId' in s.accepts ? s.accepts.eventId : '',
    templateIds: s.accepts && 'templateIds' in s.accepts ? s.accepts.templateIds : [],
    flow: s.settings.flow,
    reader: s.settings.reader === 'barcode' ? 'barcode' : 'none',
    lookup: s.settings.lookup,
    staffSignIn: s.settings.staffSignIn,
    roleWithoutSignIn: s.settings.roleWithoutSignIn,
    letInAgain: s.settings.letInAgain,
    checkIn: s.settings.checkIn ?? {},
    dailyAmount: s.settings.dailyAmount,
    direction: s.settings.direction ?? 'pass',
    showPhoto: s.settings.showPhoto ?? true,
  };
}
export const sessionBody = (d: SessionDraft) => ({
  name: d.name.trim(),
  orgId: d.orgId,
  timeZone: d.timeZone,
  accepts: acceptsOf(d),
  settings: settingsOf(d),
});
export function sessionReady(d: ScannerDraft) {
  return (
    !!d.name.trim() &&
    !!d.orgId &&
    (d.accepts === 'all' || (d.accepts === 'event' ? !!d.eventId : !!d.templateIds.length))
  );
}
export function sessionAccepts(s: ScanningSession) {
  return s.accepts && 'eventId' in s.accepts
    ? 'Event admission'
    : s.accepts
      ? `${s.accepts.templateIds.length} pass templates`
      : s.settings.acceptAllTemplates
        ? 'All passes'
        : 'No passes assigned';
}
export const sessionRuleLabel = (s: ScanningSession) =>
  s.settings.checkIn?.mode
    ? {
        single: 'One scan',
        daily: 'Once per day',
        unlimited: 'Unlimited scans',
        in_out: 'In / out',
      }[s.settings.checkIn.mode]
    : 'Pass or template rules';
