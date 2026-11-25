import { useEffect, useRef } from 'react';
import { DEFAULT_TIME_ZONE, resolveOrgTimeZone } from '@/shared/time-zone.ts';
import { useSettings } from './queries.ts';

/** The org's effective time zone: its setting, else the default. Admin screens read dates in it. */
export function useOrgTimeZone(orgId: string | undefined): string {
  const value = useSettings(`org:${orgId}`, Boolean(orgId)).data?.items.find(
    (i) => i.key === 'org.timeZone',
  )?.value;
  return resolveOrgTimeZone(typeof value === 'string' ? value : null);
}

/**
 * Seeds a new form with the org's zone. Draft state starts on `DEFAULT_TIME_ZONE`; when the org's
 * setting arrives (or the org changes) `move(from, to)` swaps that zone for the org's in whatever
 * the user has not changed, so a form opened before settings load never saves the default.
 * Returns the org zone.
 */
export function useSeededZone(
  orgId: string | undefined,
  move: (from: string, to: string) => void,
): string {
  const zone = useOrgTimeZone(orgId);
  const last = useRef(DEFAULT_TIME_ZONE);
  const apply = useRef(move);
  apply.current = move;
  useEffect(() => {
    if (last.current === zone) return;
    const from = last.current;
    last.current = zone;
    apply.current(from, zone);
  }, [zone]);
  return zone;
}
