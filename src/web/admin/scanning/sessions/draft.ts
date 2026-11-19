import type { WeeklyHours } from '@/passkit/types.ts';
import type {
  ScanningSession,
  SessionCustomerSettings,
} from '@/shared/contracts/scanning-sessions.ts';
import { localZone } from '@/web/lib/timezones.ts';
import {
  acceptsOf,
  EMPTY_DRAFT,
  type ScannerDraft,
  settingsOf,
} from '../scanners/scanner-draft.ts';
import { hoursBody, hoursProblem } from './session-hours.ts';

export type SessionDraft = ScannerDraft & {
  timeZone: string;
  /** Zones this session checks. Absent while the server has not said (a list row). */
  zoneIds?: string[];
  /** The session already stores Desk actions, so Off is sent rather than left out. */
  deskActionsSaved?: boolean;
  customer?: SessionCustomerSettings;
  /** Open only at set hours, in the time zone above. */
  hoursOn: boolean;
  hours?: WeeklyHours;
};

export const emptySessionDraft = (): SessionDraft => ({
  ...EMPTY_DRAFT,
  timeZone: localZone(),
  accepts: 'all',
  lookup: true,
  zoneIds: [],
  hoursOn: false,
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
    approvals: s.settings.approvals ?? 'managers',
    hardLimit: s.settings.hardLimit ?? false,
    checkIn: s.settings.checkIn ?? {},
    dailyAmount: s.settings.dailyAmount,
    direction: s.settings.direction ?? 'pass',
    showPhoto: s.settings.showPhoto ?? true,
    zoneIds: s.zoneIds,
    deskActions: s.settings.deskActions ?? false,
    deskActionsSaved: s.settings.deskActions !== undefined,
    customer: s.settings.customer,
    hoursOn: Boolean(s.hours),
    ...(s.hours ? { hours: s.hours } : {}),
  };
}
export const sessionBody = (d: SessionDraft) => ({
  name: d.name.trim(),
  orgId: d.orgId,
  timeZone: d.timeZone,
  hours: hoursBody(d.hoursOn, d.hours),
  accepts: acceptsOf(d),
  settings: {
    ...settingsOf(d),
    ...(d.deskActions || d.deskActionsSaved ? { deskActions: d.deskActions } : {}),
    ...(d.customer === undefined ? {} : { customer: cleanCustomer(d.customer) }),
  },
  // Events check in once: a session on one holds no zones.
  ...(d.zoneIds === undefined ? {} : { zoneIds: d.accepts === 'event' ? [] : d.zoneIds }),
});

/** Empty lines are absent, so the defaults in `copy/scan-customer.ts` apply. */
export function cleanCustomer(c: SessionCustomerSettings): SessionCustomerSettings {
  const welcome = c.welcome?.trim();
  const refusedLine = c.refusedLine?.trim();
  return {
    ...(welcome ? { welcome } : {}),
    ...(refusedLine ? { refusedLine } : {}),
    ...(c.greet === undefined ? {} : { greet: c.greet }),
    ...(c.showReady === undefined ? {} : { showReady: c.showReady }),
    ...(c.showDraft === undefined ? {} : { showDraft: c.showDraft }),
  };
}
export function sessionReady(d: SessionDraft) {
  return (
    !hoursProblem(d.hoursOn, d.hours) &&
    !!d.name.trim() &&
    !!d.orgId &&
    (d.accepts === 'all' || (d.accepts === 'event' ? !!d.eventId : !!d.templateIds.length))
  );
}
export function sessionAccepts(s: ScanningSession, eventName?: string) {
  const n = s.accepts && 'templateIds' in s.accepts ? s.accepts.templateIds.length : 0;
  return s.accepts && 'eventId' in s.accepts
    ? (eventName ?? 'Event admission')
    : s.accepts
      ? `${n} pass ${n === 1 ? 'template' : 'templates'}`
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
