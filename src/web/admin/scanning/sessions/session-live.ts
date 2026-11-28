import { useQuery } from '@tanstack/react-query';
import { useEffect, useMemo } from 'react';
import { z } from 'zod';
import type { ScanZone } from '@/shared/contracts/scan-access.ts';
import type { ScanSetupCheck } from '@/shared/contracts/scan-setup-intent.ts';
import { admitsOf, type ScanEventDto, ScanStaffSchema } from '@/shared/contracts/scanners.ts';
import type { ScanningSessionDetailSchema } from '@/shared/contracts/scanning-sessions.ts';
import { settingsOfflineVerdict } from '@/shared/scan-offline.ts';
import { type DoorFacts, setupChecks } from '@/shared/scan-setup-checks.ts';
import { api } from '@/web/lib/api.ts';
import { useMode } from '@/web/lib/mode.ts';
import { useEligibleTemplates, useScanEvents } from '../scanner-api.ts';
import { useZones } from '../zones/zones-api.ts';

export type SessionStaff = z.infer<typeof ScanStaffSchema>;
const StaffPageSchema = z.object({ items: z.array(ScanStaffSchema) });
const direction = (d: string | undefined): 'in' | 'out' | 'both' | null =>
  d === 'in' || d === 'out' || d === 'both' ? d : null;

/** The zone's key, then each ancestor's. */
function keysOf(zone: ScanZone, zones: readonly ScanZone[]): string[] {
  const keys: string[] = [];
  for (let at: ScanZone | undefined = zone; at && keys.length < 5; ) {
    keys.push(at.key);
    const parent: string | null = at.parentId;
    at = parent ? zones.find((z) => z.id === parent) : undefined;
  }
  return keys;
}

export type SessionDetailData = z.infer<typeof ScanningSessionDetailSchema>;

/** A live session as the shared checks see it: ids are refs. */
export function liveDoorFacts(
  s: SessionDetailData,
  data: {
    zones: readonly ScanZone[];
    events: readonly ScanEventDto[];
    templates: readonly { id: string; name: string }[];
  },
): DoorFacts {
  const admits = s.accepts ? admitsOf(s.accepts) : { templateIds: [], eventIds: [] };
  const eventOnly = s.accepts !== null && admits.templateIds.length === 0;
  const zone = data.zones.find((z) => s.zoneIds?.includes(z.id));
  const settings = s.settings;
  const offline = (settings.whenOffline ?? (settings.offline ? 'list' : 'stop')) === 'list';
  const verdict = offline ? settingsOfflineVerdict(settings, s.zoneIds?.length ?? 0) : null;
  return {
    ref: s.id,
    name: s.name,
    eventOnly,
    place: zone
      ? {
          ref: zone.id,
          name: zone.name,
          keys: keysOf(zone, data.zones),
          counted: zone.occupancy !== 'off',
          exits: zone.occupancy !== 'off',
          max: zone.capacity,
        }
      : null,
    events: data.events
      .filter((e) => admits.eventIds.includes(e.id))
      .map((e) => ({
        ref: e.id,
        name: e.name,
        reentry: e.reentry,
        max: e.capacity,
        issued: e.expected,
      })),
    templates: data.templates
      .filter((t) => admits.templateIds.includes(t.id))
      .map((t) => ({ ...t, plans: null })),
    hours: s.hours ?? null,
    direction: direction(settings.direction),
    tracks: settings.checkIn?.mode === 'in_out',
    staffSignIn: settings.staffSignIn === true,
    offlineBlocked: verdict && !verdict.ok ? verdict.message : null,
    devices: s.devices.map((d) => ({
      ref: d.id,
      name: d.name,
      role: d.deviceRole === 'customer' ? 'customer' : 'scan',
      direction: direction(d.settings.direction),
      reader: d.settings.reader,
      revoked: d.revoked,
    })),
  };
}

/** The org's staff, newest data first; a write elsewhere invalidates the `staff` prefix. */
export function useSessionStaff(orgId: string) {
  const mode = useMode();
  return useQuery({
    queryKey: ['admin', 'scanning', 'staff', orgId, mode, 'session'],
    queryFn: ({ signal }) =>
      api.get('/api/v1/scan-staff', StaffPageSchema, { query: { orgId, limit: 200 }, signal }),
    refetchInterval: 15_000,
  });
}

/** Everything the page reads besides the session, and the checks over it, live. */
export function useSessionLive(s: SessionDetailData) {
  const mode = useMode();
  const zones = useZones(s.orgId);
  const events = useScanEvents(s.orgId);
  const templates = useEligibleTemplates(s.orgId, true);
  const staff = useSessionStaff(s.orgId);
  const { hasNextPage, isFetchingNextPage, fetchNextPage } = templates;
  useEffect(() => {
    if (hasNextPage && !isFetchingNextPage) void fetchNextPage();
  }, [hasNextPage, isFetchingNextPage, fetchNextPage]);
  const templateList = useMemo(
    () =>
      (templates.data?.pages.flatMap((p) => p.items) ?? []).map((t) => ({
        id: t.templateId,
        name: t.name,
      })),
    [templates.data],
  );
  const ready = [zones, events, templates, staff].every((q) => q.isSuccess);
  const checks: ScanSetupCheck[] = useMemo(
    () =>
      ready
        ? setupChecks({
            mode,
            staff: (staff.data?.items ?? []).map((p) => ({
              role: p.role,
              active: p.disabledAt === null,
            })),
            doors: [
              liveDoorFacts(s, {
                zones: zones.data ?? [],
                events: events.data?.items ?? [],
                templates: templateList,
              }),
            ],
          })
        : [],
    [ready, mode, s, staff.data, zones.data, events.data, templateList],
  );
  return { zones, events, staff, templates: templateList, checks, ready };
}
