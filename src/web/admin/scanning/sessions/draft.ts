import type { WeeklyHours } from '@/passkit/types.ts';
import { admitsOf, admitsWire } from '@/shared/contracts/scanners.ts';
import type {
  ScanningSession,
  SessionCustomerSettings,
} from '@/shared/contracts/scanning-sessions.ts';
import { type OfflineMode, offlineModeOf } from '@/shared/scan-offline.ts';
import { DEFAULT_TIME_ZONE } from '@/shared/time-zone.ts';
import { EMPTY_DRAFT, type ScannerDraft, settingsOf } from '../scanners/scanner-draft.ts';
import { hoursBody, hoursProblem, weekOf } from './session-hours.ts';

export type SessionDraft = ScannerDraft & {
  timeZone: string;
  /** What the door does with no connection (O8). */
  whenOffline: OfflineMode;
  /** Zones this session checks. Absent while the server has not said (a list row). */
  zoneIds?: string[];
  /** The session already stores Desk actions, so Off is sent rather than left out. */
  deskActionsSaved?: boolean;
  customer?: SessionCustomerSettings;
  /** Open only at set hours, in the time zone above. */
  hoursOn: boolean;
  hours?: WeeklyHours;
  /** Dated exceptions in the session's zone: no spans is closed all day. */
  dates?: Record<string, string[]>;
  /** Events the session admits beside its pass types (`templateIds`). */
  eventIds: string[];
};

export const emptySessionDraft = (): SessionDraft => ({
  ...EMPTY_DRAFT,
  timeZone: DEFAULT_TIME_ZONE,
  accepts: 'all',
  eventIds: [],
  lookup: true,
  whenOffline: 'stop',
  zoneIds: [],
  hoursOn: false,
});
export function sessionDraft(s: ScanningSession): SessionDraft {
  const admits = s.accepts ? admitsOf(s.accepts) : { templateIds: [], eventIds: [] };
  return {
    ...emptySessionDraft(),
    name: s.name,
    timeZone: s.timeZone,
    orgId: s.orgId,
    accepts: s.accepts ? 'templates' : s.settings.acceptAllTemplates ? 'all' : 'templates',
    templateIds: admits.templateIds,
    eventIds: admits.eventIds,
    whenOffline: offlineModeOf(s.settings),
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
    ...(s.hours ? { hours: weekOf(s.hours) } : {}),
    ...(s.hours?.dates ? { dates: s.hours.dates } : {}),
  };
}
export const sessionBody = (d: SessionDraft) => ({
  name: d.name.trim(),
  orgId: d.orgId,
  timeZone: d.timeZone,
  hours: hoursBody(d.hoursOn, d.hours, d.dates, d.timeZone),
  accepts:
    d.accepts === 'all' ? null : admitsWire({ templateIds: d.templateIds, eventIds: d.eventIds }),
  settings: {
    ...settingsOf(d),
    whenOffline: d.whenOffline,
    offline: d.whenOffline === 'list',
    ...(d.deskActions || d.deskActionsSaved ? { deskActions: d.deskActions } : {}),
    ...(d.customer === undefined ? {} : { customer: cleanCustomer(d.customer) }),
  },
  // Events check in once: a session on one holds no zones.
  ...(d.zoneIds === undefined ? {} : { zoneIds: eventsOnly(d) ? [] : d.zoneIds }),
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
/** A session that admits events only: its doors hold no zones. */
export const eventsOnly = (d: Pick<SessionDraft, 'accepts' | 'templateIds' | 'eventIds'>) =>
  d.accepts !== 'all' && d.templateIds.length === 0 && d.eventIds.length > 0;

export function sessionReady(d: SessionDraft) {
  return (
    !hoursProblem(d.hoursOn, d.hours) &&
    !!d.name.trim() &&
    !!d.orgId &&
    (d.accepts === 'all' || !!(d.templateIds.length || d.eventIds.length))
  );
}
export function sessionAccepts(s: ScanningSession, eventName?: string) {
  if (!s.accepts) return s.settings.acceptAllTemplates ? 'Any pass type' : 'No pass types';
  const { templateIds, eventIds } = admitsOf(s.accepts);
  if (!templateIds.length && eventIds.length === 1) return eventName ?? '1 event';
  const part = (n: number, one: string, many: string) =>
    n ? [`${n} ${n === 1 ? one : many}`] : [];
  return [
    ...part(templateIds.length, 'pass type', 'pass types'),
    ...part(eventIds.length, 'event', 'events'),
  ].join(', ');
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

/** Direction Both or Out and an event's re-entry only act while the session tracks in / out. */
export function trackingGap(
  d: Pick<SessionDraft, 'direction' | 'checkIn' | 'eventIds'>,
  events: readonly { id: string; reentry: boolean }[],
) {
  if (d.checkIn.mode === 'in_out') return null;
  if (d.direction === 'both' || d.direction === 'out')
    return `Direction ${d.direction === 'both' ? 'Both' : 'Out'}`;
  return events.some((e) => e.reentry && d.eventIds.includes(e.id)) ? 'Re-entry' : null;
}
