import type { TemplateScanSetup } from '@/shared/contracts/scan-setups.ts';

/** A template with a scan block says how its passes are scanned; any other has the one check-in. */
export const hasScanBlock = (manifest: unknown): boolean =>
  typeof manifest === 'object' &&
  manifest !== null &&
  (manifest as { scan?: unknown }).scan !== undefined;

const listOf = (names: string[]) =>
  names.length < 2 ? (names[0] ?? '') : `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`;

/** The one line the session page opens with. */
export function scanSetupSummary(r: TemplateScanSetup): string {
  if (!r.created) return `${r.session.name} already scans these passes. Edit anything here.`;
  const made = r.events.filter((e) => e.created).map((e) => e.name);
  const events =
    made.length === 0
      ? ''
      : made.length > 3
        ? `${made.length} events`
        : `${made.length === 1 ? 'event' : 'events'} ${listOf(made)}`;
  const undated = r.undated.length > 0 ? ` ${listOf(r.undated)} has no date yet.` : '';
  return `Created ${events ? `${events} and ` : ''}session ${r.session.name}.${undated} Edit anything here.`;
}
