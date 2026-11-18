import type { z } from 'zod';
import {
  type CreateScanZoneSchema,
  type ScanZone,
  type UpdateScanZoneSchema,
  ZoneKeySchema,
} from '@/shared/contracts/scan-access.ts';

export const ROOT = '__root';
/** A root with no clock of its own uses each session's clock. */
export const SESSION_CLOCK = '__session';
/** What Max stay becomes when Track turns on (12 h). */
export const DEFAULT_MAX_STAY = 720;

export interface ZoneDraft {
  name: string;
  key: string;
  keyEdited: boolean;
  parentId: string;
  timeZone: string;
  track: boolean;
  enforce: boolean;
  capacity: number | null;
  maxStayMinutes: number | null;
  clearAt: string;
}

export const emptyZoneDraft = (parentId = '', timeZone = SESSION_CLOCK): ZoneDraft => ({
  name: '',
  key: '',
  keyEdited: false,
  parentId: parentId || ROOT,
  timeZone,
  track: false,
  enforce: false,
  capacity: null,
  maxStayMinutes: null,
  clearAt: '',
});

export const zoneDraft = (z: ScanZone): ZoneDraft => ({
  name: z.name,
  key: z.key,
  keyEdited: true,
  parentId: z.parentId ?? ROOT,
  timeZone: z.timeZone ?? SESSION_CLOCK,
  track: z.occupancy !== 'off',
  enforce: z.occupancy === 'enforce',
  capacity: z.capacity,
  maxStayMinutes: z.maxStayMinutes,
  clearAt: z.clearAt ?? '',
});

/** "Front Gate 2" -> "front-gate-2". */
export const slugKey = (name: string): string =>
  name
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
    .replace(/-+$/g, '');

export function withName(d: ZoneDraft, name: string): ZoneDraft {
  return { ...d, name, ...(d.keyEdited ? {} : { key: slugKey(name) }) };
}

/** Track on gives the 12 h default; Track off drops every limit the database would refuse. */
export function withTrack(d: ZoneDraft, track: boolean): ZoneDraft {
  if (track) return { ...d, track, maxStayMinutes: d.maxStayMinutes ?? DEFAULT_MAX_STAY };
  return { ...d, track, enforce: false, capacity: null, maxStayMinutes: null, clearAt: '' };
}

/** The clock `clearAt` runs on: the zone's own (roots) or its parent's. */
export function zoneErrors(
  d: ZoneDraft,
  creating: boolean,
  hasClock: boolean,
): Partial<Record<'name' | 'key' | 'capacity' | 'maxStay' | 'clearAt', string>> {
  return {
    ...(d.name.trim() ? {} : { name: 'Required.' }),
    ...(creating && !ZoneKeySchema.safeParse(d.key).success ? { key: 'Use a-z, 0-9 and -.' } : {}),
    ...(d.capacity !== null &&
    (d.capacity < 1 || d.capacity > 100_000 || !Number.isInteger(d.capacity))
      ? { capacity: '1 to 100,000.' }
      : {}),
    ...(d.maxStayMinutes !== null &&
    (d.maxStayMinutes < 15 || d.maxStayMinutes > 2880 || !Number.isInteger(d.maxStayMinutes))
      ? { maxStay: '15 to 2,880 minutes.' }
      : {}),
    ...(d.clearAt && !hasClock ? { clearAt: 'Give this site a time zone first.' } : {}),
  };
}

const occupancyOf = (d: ZoneDraft) => ({
  occupancy: d.enforce ? ('enforce' as const) : d.track ? ('track' as const) : ('off' as const),
  capacity: d.track ? d.capacity : null,
  maxStayMinutes: d.track ? d.maxStayMinutes : null,
  clearAt: d.track && d.clearAt ? d.clearAt : null,
});

export function createBody(d: ZoneDraft, orgId: string): z.input<typeof CreateScanZoneSchema> {
  const root = d.parentId === ROOT;
  return {
    orgId,
    key: d.key,
    name: d.name.trim(),
    parentId: root ? null : d.parentId,
    timeZone: root && d.timeZone !== SESSION_CLOCK ? d.timeZone : null,
    ...occupancyOf(d),
  };
}

/** Only what changed moves; a child never sends a time zone. */
export function updateBody(d: ZoneDraft, before: ScanZone): z.input<typeof UpdateScanZoneSchema> {
  const root = d.parentId === ROOT;
  const parentId = root ? null : d.parentId;
  const timeZone = root && d.timeZone !== SESSION_CLOCK ? d.timeZone : null;
  return {
    name: d.name.trim(),
    ...(parentId !== before.parentId ? { parentId } : {}),
    ...(root && timeZone !== before.timeZone ? { timeZone } : {}),
    ...(!root && before.timeZone ? { timeZone: null } : {}),
    ...occupancyOf(d),
  };
}
