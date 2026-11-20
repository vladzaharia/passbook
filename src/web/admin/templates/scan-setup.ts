import type { TemplateScanSetup } from '@/shared/contracts/scan-template-setup.ts';

const listOf = (names: string[]) =>
  names.length < 2 ? (names[0] ?? '') : `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`;

const eventsOf = (names: string[]) =>
  names.length > 3
    ? `${names.length} events`
    : `${names.length === 1 ? 'event' : 'events'} ${listOf(names)}`;

/** The one line the session page opens with. */
export function scanSetupSummary(r: TemplateScanSetup): string {
  const made = r.events.map((e) => e.name);
  if (!r.created)
    return made.length > 0
      ? `Added ${eventsOf(made)} to session ${r.session.name}. Edit anything here.`
      : `${r.session.name} already scans these passes. Edit anything here.`;
  if (made.length > 0)
    return `Created ${eventsOf(made)} and session ${r.session.name}. Edit anything here.`;
  return r.noEvents
    ? `Created session ${r.session.name}. No event yet: no passes with an upcoming event are issued. Edit anything here.`
    : `Created session ${r.session.name}. Edit anything here.`;
}
