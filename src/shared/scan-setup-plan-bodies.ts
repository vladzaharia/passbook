import type { ScanSetupPlan, SetupLink } from './contracts/scan-setup-intent.ts';

/**
 * The plan as the bodies each existing create route takes, in commit order (zones parents first).
 * `idOf` gives the id apply made for a ref; a link to an existing object keeps its id.
 */
export function planBodies(plan: ScanSetupPlan, orgId: string, idOf: (ref: string) => string) {
  const id = (l: SetupLink) => ('ref' in l ? idOf(l.ref) : l.id);
  return {
    zones: plan.zones.map((z) => ({
      orgId,
      key: z.key,
      name: z.name,
      parentId: z.parent ? id(z.parent) : null,
      timeZone: z.timeZone,
      occupancy: z.occupancy,
      capacity: z.capacity,
      maxStayMinutes: z.maxStayMinutes,
      clearAt: z.clearAt,
    })),
    events: plan.events.map((e) => ({
      orgId,
      name: e.name,
      templateIds: e.templateIds,
      match: e.match,
      opensAt: e.opensAt,
      closesAt: e.closesAt,
      timeZone: e.timeZone,
      capacity: e.capacity,
      reentry: e.reentry,
    })),
    staff: plan.staff.map((s) => ({ orgId, name: s.name, role: s.role })),
    sessions: plan.sessions.map((s) => ({
      ref: s.ref,
      body: {
        orgId,
        name: s.name,
        timeZone: s.timeZone,
        accepts: s.accepts && {
          templateIds: s.accepts.templateIds,
          eventIds: s.accepts.events.map(id),
        },
        settings: s.settings,
        zoneIds: s.zones.map(id),
        hours: s.hours,
      },
      devices: s.devices.map((d) => ({
        ref: d.ref,
        body: {
          name: d.name,
          surface: d.surface,
          deviceRole: d.role,
          overrides: d.overrides,
        },
      })),
    })),
  };
}
