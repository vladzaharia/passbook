import { eventsOnly, type SessionDraft } from './draft.ts';
import { hoursProblem } from './session-hours.ts';

export const SESSION_STEPS = [
  { id: 'passes', title: 'Passes', heading: 'Name it and pick passes' },
  { id: 'rules', title: 'Admission', heading: 'Set check-in rules' },
  { id: 'access', title: 'Access', heading: 'Set where it scans' },
  { id: 'customer', title: 'Customer screen', heading: 'Set the customer screen' },
  { id: 'defaults', title: 'Device defaults', heading: 'Set device defaults' },
  { id: 'review', title: 'Review', heading: 'Check and create' },
] as const;
export type SessionStepId = (typeof SESSION_STEPS)[number]['id'];
export type SessionBodyId = Exclude<SessionStepId, 'review'>;

export const SESSION_HINTS: Partial<Record<SessionStepId, string>> = {
  passes: 'Name it and pick passes.',
};

/** Where a server field error is fixed. */
export const SESSION_FIELD_STEP: Record<string, SessionStepId> = {
  name: 'passes',
  orgId: 'passes',
  timeZone: 'passes',
  hours: 'passes',
  accepts: 'passes',
  zoneIds: 'access',
};

const only = (found: Record<string, string | undefined>) =>
  Object.values(found).some(Boolean)
    ? (Object.fromEntries(Object.entries(found).filter(([, v]) => v)) as Record<string, string>)
    : undefined;

/** Blocking problems by step; `blocked` is why the organization or mode forbids the dialog. */
export function sessionErrors(draft: SessionDraft, blocked: string | undefined) {
  return {
    passes: only({
      orgId: blocked,
      name: draft.name.trim() ? undefined : 'Enter a name.',
      hours: hoursProblem(draft.hoursOn, draft.hours) ?? undefined,
      accepts:
        draft.accepts === 'all' || draft.templateIds.length || draft.eventIds.length
          ? undefined
          : 'Pick a pass type or an event.',
    }),
  };
}

const RULE_LABEL = {
  single: 'One scan',
  daily: 'Once per day',
  unlimited: 'Unlimited scans',
  in_out: 'In / out',
} as const;

export const ruleLabel = (draft: SessionDraft) =>
  draft.checkIn.mode ? RULE_LABEL[draft.checkIn.mode] : 'Pass or template rules';

export function sessionSummaries(draft: SessionDraft) {
  const zones = draft.zoneIds?.length ?? 0;
  return {
    passes: draft.name.trim() || undefined,
    rules: ruleLabel(draft),
    access: eventsOnly(draft)
      ? 'Event'
      : zones
        ? `${zones} ${zones === 1 ? 'zone' : 'zones'}`
        : undefined,
    defaults: draft.flow === 'choose' ? 'Review first' : 'Automatic',
  };
}
