import type { BroadcastDto } from '@/shared/contracts/broadcasts.ts';
import { useScanEvents } from '../scanning/scanner-api.ts';

/** The checked-in-to event's name, from the org's events; undefined until loaded or when none. */
export function useAudienceEventName(
  orgId: string | undefined,
  eventId: string | undefined,
): string | undefined {
  const events = useScanEvents(orgId, Boolean(orgId && eventId));
  return events.data?.items.find((event) => event.id === eventId)?.name;
}

export const scanEventIdOf = (b: BroadcastDto): string | undefined =>
  b.target.scan && 'eventId' in b.target.scan ? b.target.scan.eventId : undefined;
