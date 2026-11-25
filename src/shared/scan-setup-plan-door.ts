import type { PlannedSession, SetupDoor, SetupLink } from './contracts/scan-setup-intent.ts';
import { ADMITS_TEMPLATE_CAP } from './contracts/scanners.ts';
import type { ScanDeviceOverrides } from './contracts/scanning-sessions.ts';
import { settingsOfflineVerdict } from './scan-offline.ts';
import { deviceName, isTracked, sessionHoursOf } from './scan-setup-plan-derive.ts';
import { type DoorPlanEnv, isRef } from './scan-setup-plan-types.ts';
import { roleForSurface } from './scan-surfaces.ts';
import { resolveOrgTimeZone } from './time-zone.ts';

/** A session admits at most this many events. */
const MAX_EVENTS = 10;
const key = (l: SetupLink) => ('ref' in l ? `r:${l.ref}` : `i:${l.id}`);

function eventOf(env: DoorPlanEnv, l: SetupLink) {
  return 'ref' in l
    ? env.events.find((e) => e.ref === l.ref)
    : env.ctx.events.find((e) => e.id === l.id);
}

function admitsOf(door: SetupDoor, path: (string | number)[], env: DoorPlanEnv) {
  if ('any' in door.admits) return null;
  const { ctx, refs, issues } = env;
  const templateIds = new Set<string>();
  door.admits.templateIds.forEach((id, n) => {
    if (ctx.templates.some((t) => t.id === id)) templateIds.add(id);
    else issues.push({ code: 'TEMPLATE_NOT_FOUND', path: [...path, 'templateIds', n] });
  });
  const events = new Map<string, SetupLink>();
  const add = (l: SetupLink) => events.set(key(l), l);
  door.admits.events.forEach((e, n) => {
    const at = [...path, 'events', n];
    const target = refs.get(e);
    if (target?.kind === 'event') add({ ref: e });
    else if (target?.kind === 'group') {
      templateIds.add(target.templateId);
      target.links.forEach(add);
    } else if (target)
      issues.push({ code: 'SETUP_REF_KIND', path: at, params: { ref: e, kind: 'event' } });
    else if (ctx.events.some((x) => x.id === e)) add({ id: e });
    else
      issues.push({
        code: isRef(e) ? 'SETUP_REF_UNKNOWN' : 'EVENT_NOT_FOUND',
        path: at,
        params: { ref: e },
      });
  });
  const links = [...events.values()];
  const all = new Set([
    ...templateIds,
    ...links.flatMap((l) => eventOf(env, l)?.templateIds ?? []),
  ]);
  const params = { door: door.name };
  if (links.length > MAX_EVENTS) issues.push({ code: 'SETUP_TOO_MANY_EVENTS', path, params });
  if (all.size > ADMITS_TEMPLATE_CAP)
    issues.push({ code: 'SETUP_TOO_MANY_TEMPLATES', path, params });
  if (door.admits.templateIds.length + door.admits.events.length === 0)
    issues.push({ code: 'SETUP_ADMITS_EMPTY', path, params });
  return { templateIds: [...templateIds], events: links };
}

/** The door's zone, and whether people scan out of it. */
function placeOf(door: SetupDoor, path: (string | number)[], env: DoorPlanEnv) {
  const id = door.place;
  if (id === null || id === undefined) return { zone: null, exits: false };
  const { intent, ctx, refs, issues } = env;
  const target = refs.get(id);
  if (target?.kind === 'place') {
    const p = intent.places.find((x) => 'ref' in x && x.ref === id);
    const exits = p !== undefined && 'ref' in p && isTracked(p) && p.tapOut !== false;
    return { zone: { ref: id }, exits };
  }
  if (target) {
    issues.push({ code: 'SETUP_REF_KIND', path, params: { ref: id, kind: 'place' } });
    return { zone: null, exits: false };
  }
  const z = ctx.zones.find((x) => x.id === id);
  if (z && !z.archived) return { zone: { id }, exits: z.occupancy !== 'off' };
  issues.push({
    code: z ? 'ZONE_ARCHIVED' : isRef(id) ? 'SETUP_REF_UNKNOWN' : 'ZONE_NOT_FOUND',
    path,
    params: { ref: id },
  });
  return { zone: null, exits: false };
}

/** One door as a session: admits, zone, hours, sign-in, derived direction and its devices. */
export function planDoor(door: SetupDoor, i: number, env: DoorPlanEnv): PlannedSession {
  const ref = `door-${i + 1}`;
  const path = ['doors', i];
  const accepts = admitsOf(door, [...path, 'admits'], env);
  const { zone, exits } = placeOf(door, [...path, 'place'], env);
  const reentry = (accepts?.events ?? []).some((l) => eventOf(env, l)?.reentry === true);
  const hours = sessionHoursOf(door.hours);
  if (hours === 'empty')
    env.issues.push({
      code: 'SETUP_HOURS_EMPTY',
      path: [...path, 'hours'],
      params: { door: door.name },
    });
  const scanners = door.scanners ?? { by: 'anyone', as: 'door' };
  const more = door.more ?? {};
  const needsExit = exits || reentry;
  // No place and no re-entry: no direction, so a plain door checks in by the pass's rules.
  const direction = more.direction ?? (needsExit ? 'both' : undefined);
  const settings: PlannedSession['settings'] = {
    ...more,
    ...(direction ? { direction } : {}),
    staffSignIn: scanners.by === 'staff',
    ...(scanners.by === 'anyone' ? { roleWithoutSignIn: scanners.as } : {}),
  };
  const sessionReader = settings.reader ?? 'none';
  const devices = (door.devices ?? [{}]).map((d, n) => {
    const layout = d.layout ?? 'auto';
    const reader =
      d.reader === 'barcode' ? 'barcode' : d.reader === 'camera' ? 'none' : sessionReader;
    const dir = d.direction ?? (reader === 'barcode' && needsExit ? 'in' : direction);
    const overrides: ScanDeviceOverrides = {};
    if (reader !== sessionReader) overrides.reader = reader;
    if (dir !== undefined && dir !== direction) overrides.direction = dir;
    if (layout === 'operator' && settings.lookup === false) overrides.lookup = true;
    if (layout === 'operator' && settings.showPhoto === false) overrides.showPhoto = true;
    return {
      ref: `${ref}-${n + 1}`,
      name: d.name ?? deviceName(door.name, n + 1),
      surface: layout,
      overrides,
      role: roleForSurface(layout),
    };
  });
  // A direction or re-entry does nothing unless the check-in type tracks in and out.
  const directed = direction !== undefined || devices.some((d) => d.overrides.direction);
  if ((directed || reentry) && more.checkIn?.mode === undefined)
    settings.checkIn = { ...more.checkIn, mode: 'in_out' };
  // event_night keeps the line moving offline, but only for a door that needs no exits.
  const desk = devices.some((d) => d.surface === 'operator');
  if (
    env.intent.preset === 'event_night' &&
    !desk &&
    more.offline === undefined &&
    more.whenOffline === undefined &&
    settingsOfflineVerdict(settings, zone ? 1 : 0).ok
  ) {
    settings.offline = true;
    settings.whenOffline = 'list';
  }
  return {
    ref,
    name: door.name,
    timeZone: env.intent.timeZone ?? resolveOrgTimeZone(env.ctx.orgTimeZone),
    accepts,
    zones: zone ? [zone] : [],
    hours: hours === 'empty' ? null : hours,
    settings,
    devices,
  };
}
