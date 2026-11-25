import { useQuery } from '@tanstack/react-query';
import { useEffect } from 'react';
import { z } from 'zod';
import { ScanStaffSchema } from '@/shared/contracts/scanners.ts';
import type { SetupPlanContext } from '@/shared/scan-setup-plan-types.ts';
import { resolveOrgTimeZone } from '@/shared/time-zone.ts';
import { api } from '@/web/lib/api.ts';
import { useMode } from '@/web/lib/mode.ts';
import { useSettings } from '../../settings/queries.ts';
import { useEligibleTemplates, useScanEvents } from '../scanner-api.ts';
import { useZones } from '../zones-query.ts';

const StaffPageSchema = z.object({ items: z.array(ScanStaffSchema) });

/**
 * What the planner reads, from the admin APIs the tabs already use. Template plans and issued
 * counts have no admin API: the server's dry run reports the checks that need them.
 */
export function useSetupFacts(orgId: string) {
  const mode = useMode();
  const templates = useEligibleTemplates(orgId, true);
  const zones = useZones();
  const events = useScanEvents(orgId);
  const staff = useQuery({
    queryKey: ['admin', 'scanning', 'staff', orgId, mode, 'setup-facts'],
    queryFn: ({ signal }) =>
      api.get('/api/v1/scan-staff', StaffPageSchema, { query: { orgId, limit: 200 }, signal }),
  });
  const settings = useSettings(`org:${orgId}`);
  const orgZone = settings.data?.items.find((i) => i.key === 'org.timeZone')?.value;
  const timeZone = resolveOrgTimeZone(typeof orgZone === 'string' ? orgZone : null);

  const { hasNextPage, isFetchingNextPage, fetchNextPage } = templates;
  useEffect(() => {
    if (hasNextPage && !isFetchingNextPage) void fetchNextPage();
  }, [hasNextPage, isFetchingNextPage, fetchNextPage]);

  const queries = [templates, zones, events, staff];
  const error = queries.find((q) => q.isError)?.error;
  const ready = queries.every((q) => q.isSuccess) && !templates.hasNextPage;
  const ctx: SetupPlanContext = {
    mode,
    orgTimeZone: timeZone,
    templates: (templates.data?.pages.flatMap((p) => p.items) ?? []).map((t) => ({
      id: t.templateId,
      name: t.name,
      plans: null,
      issued: { live: 1, test: 1 },
    })),
    zones: (zones.data?.items ?? []).map((z) => ({
      id: z.id,
      key: z.key,
      name: z.name,
      parentId: z.parentId,
      archived: z.archivedAt !== null,
      occupancy: z.occupancy,
      capacity: z.capacity,
    })),
    events: (events.data?.items ?? [])
      .filter((e) => e.status === 'upcoming' || e.status === 'live')
      .map((e) => ({
        id: e.id,
        name: e.name,
        templateIds: e.templateIds,
        reentry: e.reentry,
        capacity: e.capacity,
      })),
    staff: (staff.data?.items ?? []).map((s) => ({
      id: s.id,
      role: s.role,
      active: s.disabledAt === null,
    })),
  };
  return {
    ctx,
    ready,
    error,
    timeZone,
    /** Settings settle the zone default; wait for them so the draft starts right. */
    zoneReady: !settings.isPending,
    retry: () => queries.forEach((q) => void q.refetch()),
  };
}
