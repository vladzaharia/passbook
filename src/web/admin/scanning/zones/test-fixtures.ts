import { type ScanZone, ScanZoneSchema } from '@/shared/contracts/scan-access.ts';

const base = {
  orgId: 'o1',
  timeZone: null,
  effectiveTimeZone: null,
  sort: 0,
  sessions: 0,
  checkedAt: [],
  plans: [],
  inNow: null,
  archivedAt: null,
  occupancy: 'off',
  capacity: null,
  maxStayMinutes: null,
  clearAt: null,
};
const zone = (over: Record<string, unknown>): ScanZone =>
  ScanZoneSchema.parse({ ...base, ...over });

export const gym = zone({
  id: 'z-gym',
  key: 'gym',
  name: 'Gym',
  parentId: null,
  depth: 0,
  timeZone: 'America/New_York',
  effectiveTimeZone: 'America/New_York',
  occupancy: 'enforce',
  capacity: 60,
  maxStayMinutes: 720,
  inNow: 42,
  sessions: 2,
  checkedAt: [
    { id: 's-front', name: 'Front door' },
    { id: 's-desk', name: 'Desk' },
  ],
  plans: [
    { templateId: 't1', templateName: 'Membership', planId: 'p1', label: 'Off-peak' },
    { templateId: 't1', templateName: 'Membership', planId: 'p2', label: '24/7 Gold' },
  ],
});
export const pool = zone({
  id: 'z-pool',
  key: 'pool',
  name: 'Pool',
  parentId: 'z-gym',
  depth: 1,
  effectiveTimeZone: 'America/New_York',
  sort: 1,
  occupancy: 'track',
  capacity: 25,
  maxStayMinutes: 720,
  inNow: 25,
  sessions: 1,
  checkedAt: [{ id: 's-pool', name: 'Pool gate' }],
});
export const sauna = zone({
  id: 'z-sauna',
  key: 'sauna',
  name: 'Sauna',
  parentId: 'z-pool',
  depth: 2,
  effectiveTimeZone: 'America/New_York',
  occupancy: 'track',
  capacity: 8,
  maxStayMinutes: 720,
  inNow: 3,
});
export const lobby = zone({
  id: 'z-lobby',
  key: 'lobby',
  name: 'Lobby',
  parentId: null,
  depth: 0,
  sort: 2,
});
export const annex = zone({
  id: 'z-annex',
  key: 'annex',
  name: 'Annex',
  parentId: null,
  depth: 0,
  archivedAt: 1_700_000_000_000,
});
export const ACTIVE_ZONES = [gym, pool, sauna, lobby];
