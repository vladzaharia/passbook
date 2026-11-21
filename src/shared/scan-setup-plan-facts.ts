import type {
  PlannedSession,
  ScanSetupIntent,
  ScanSetupPlan,
  SetupLink,
} from './contracts/scan-setup-intent.ts';
import type { DoorFacts, SetupCheckFacts } from './scan-setup-checks.ts';
import type { SetupPlanContext } from './scan-setup-plan-types.ts';

const linkId = (l: SetupLink) => ('ref' in l ? l.ref : l.id);

/** The plan as the checks see it: the same shape the session page builds from a live session. */
export function planCheckFacts(
  plan: ScanSetupPlan,
  intent: ScanSetupIntent,
  ctx: SetupPlanContext,
): SetupCheckFacts {
  const issued = (templateIds: readonly string[]) =>
    templateIds.reduce(
      (n, id) => n + (ctx.templates.find((t) => t.id === id)?.issued[ctx.mode] ?? 0),
      0,
    );
  /** The zone's key, then each ancestor's, through new and existing zones. */
  const keysOf = (link: SetupLink | null): string[] => {
    const keys: string[] = [];
    const seen = new Set<string>();
    for (let at = link; at !== null && !seen.has(linkId(at)); ) {
      seen.add(linkId(at));
      const ref = 'ref' in at ? at.ref : null;
      const made = ref ? plan.zones.find((z) => z.ref === ref) : undefined;
      const id = 'id' in at ? at.id : null;
      const known = id === null ? undefined : ctx.zones.find((z) => z.id === id);
      const key = made?.key ?? known?.key;
      if (key !== undefined) keys.push(key);
      at = made ? made.parent : known?.parentId ? { id: known.parentId } : null;
    }
    return keys;
  };
  const placeOf = (link: SetupLink | undefined): DoorFacts['place'] => {
    if (!link) return null;
    if ('ref' in link) {
      const z = plan.zones.find((x) => x.ref === link.ref);
      const p = intent.places.find((x) => 'ref' in x && x.ref === link.ref);
      if (!z) return null;
      const counted = z.occupancy !== 'off';
      const exits = counted && !(p && 'ref' in p && p.tapOut === false);
      return { ref: z.ref, name: z.name, keys: keysOf(link), counted, exits, max: z.capacity };
    }
    const z = ctx.zones.find((x) => x.id === link.id);
    if (!z) return null;
    const counted = z.occupancy !== 'off';
    return {
      ref: z.id,
      name: z.name,
      keys: keysOf(link),
      counted,
      exits: counted,
      max: z.capacity,
    };
  };
  const eventOf = (link: SetupLink): DoorFacts['events'][number] | [] => {
    if ('ref' in link) {
      const e = plan.events.find((x) => x.ref === link.ref);
      if (!e) return [];
      const { ref, name, reentry, capacity: max } = e;
      return { ref, name, reentry, max, issued: issued(e.templateIds) };
    }
    const e = ctx.events.find((x) => x.id === link.id);
    if (!e) return [];
    const { id: ref, name, reentry, capacity: max } = e;
    return { ref, name, reentry, max, issued: issued(e.templateIds) };
  };
  const door = (s: PlannedSession): DoorFacts => ({
    ref: s.ref,
    name: s.name,
    eventOnly: s.accepts !== null && s.accepts.templateIds.length === 0,
    place: placeOf(s.zones[0]),
    events: (s.accepts?.events ?? []).flatMap(eventOf),
    templates: (s.accepts?.templateIds ?? []).flatMap((id) => {
      const t = ctx.templates.find((x) => x.id === id);
      return t ? { id: t.id, name: t.name, plans: t.plans } : [];
    }),
    hours: s.hours,
    direction: s.settings.direction ?? null,
    tracks: s.settings.checkIn?.mode === 'in_out',
    staffSignIn: s.settings.staffSignIn === true,
    devices: s.devices.map((d) => ({
      ref: d.ref,
      name: d.name,
      role: d.role,
      direction: d.overrides.direction ?? s.settings.direction ?? null,
      reader: d.overrides.reader ?? s.settings.reader ?? 'none',
    })),
  });
  return {
    mode: plan.mode,
    staff: [
      ...ctx.staff.map((s) => ({ role: s.role, active: s.active })),
      ...plan.staff.map((s) => ({ role: s.role, active: true })),
    ],
    doors: plan.sessions.map(door),
  };
}
