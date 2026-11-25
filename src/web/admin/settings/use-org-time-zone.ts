import { resolveOrgTimeZone } from '@/shared/time-zone.ts';
import { useSettings } from './queries.ts';

/** The org's effective time zone: its setting, else the default. Admin screens read dates in it. */
export function useOrgTimeZone(orgId: string | undefined): string {
  const value = useSettings(`org:${orgId}`, Boolean(orgId)).data?.items.find(
    (i) => i.key === 'org.timeZone',
  )?.value;
  return resolveOrgTimeZone(typeof value === 'string' ? value : null);
}
