import { z } from 'zod';
import { IdSchema } from '../../../shared/contracts/common.ts';
import { type ScannerSettings, ScannerSettingsSchema } from '../../../shared/contracts/scan.ts';
import { ScanListQuerySchema, type ScannerDto } from '../../../shared/contracts/scanners.ts';
import type { ConsoleScannerRow } from './repo-scanners.ts';
import { STAFF_IDLE_MS, STAFF_MAX_MS } from './staff-binding.ts';

/** "Online" in the console: seen within two minutes. */
export const ONLINE_MS = 120_000;

/** What a new scanner starts with. Anything a console save leaves out stays here. */
export const DEFAULT_SETTINGS: ScannerSettings = {
  flow: 'auto',
  defaultActionId: null,
  roleWithoutSignIn: 'door',
  staffSignIn: false,
  letInAgain: 'anyone',
  reader: 'none',
  lookup: true,
  offline: false,
  dailyAmount: null,
};

export function parseSettings(raw: string): ScannerSettings {
  try {
    const parsed = ScannerSettingsSchema.safeParse(JSON.parse(raw));
    if (parsed.success) return parsed.data;
  } catch {
    // A blob that does not parse reads as the defaults; the guard applies its own strict posture.
  }
  return DEFAULT_SETTINGS;
}

/** Start of the local day in `timeZone`, to the second (a DST day can be an hour off). */
export function dayStartMs(timeZone: string, now: number): number {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone,
    hourCycle: 'h23',
    hour: 'numeric',
    minute: 'numeric',
    second: 'numeric',
  }).formatToParts(now);
  const at = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? 0);
  const sinceMidnight = (at('hour') * 3600 + at('minute') * 60 + at('second')) * 1000;
  return now - sinceMidnight - (now % 1000);
}

/** "iPhone · Safari", from the user agent. Never stores the agent string itself. */
export function deviceLabel(userAgent: string | undefined): string {
  const ua = userAgent ?? '';
  const device = /iPhone/.test(ua)
    ? 'iPhone'
    : /iPad/.test(ua)
      ? 'iPad'
      : /Android/.test(ua)
        ? 'Android'
        : /Macintosh/.test(ua)
          ? 'Mac'
          : /Windows/.test(ua)
            ? 'Windows'
            : /Linux|CrOS/.test(ua)
              ? 'Linux'
              : 'Device';
  const browser = /Edg\//.test(ua)
    ? 'Edge'
    : /(?:CriOS|Chrome)\//.test(ua)
      ? 'Chrome'
      : /(?:FxiOS|Firefox)\//.test(ua)
        ? 'Firefox'
        : /Safari\//.test(ua)
          ? 'Safari'
          : null;
  return browser ? `${device} · ${browser}` : device;
}

function statusOf(row: ConsoleScannerRow): ScannerDto['status'] {
  if (row.revokedAt !== null) return 'revoked';
  return row.hasToken ? 'paired' : 'not_paired';
}

const bound = (row: ConsoleScannerRow, now: number): boolean =>
  row.staffId !== null &&
  now - (row.staffSeenAt ?? 0) <= STAFF_IDLE_MS &&
  now - (row.staffSince ?? 0) <= STAFF_MAX_MS;

export function scannerDto(row: ConsoleScannerRow, now: number, today: number): ScannerDto {
  return {
    id: row.id,
    orgId: row.orgId,
    mode: row.mode,
    kind: row.kind,
    deviceRole: row.deviceRole,
    name: row.name,
    accepts: row.eventId
      ? { eventId: row.eventId }
      : row.templateIds.length > 0
        ? { templateIds: row.templateIds }
        : null,
    settings: parseSettings(row.settings),
    timeZone: row.timeZone,
    status: statusOf(row),
    online: row.lastSeenAt !== null && now - row.lastSeenAt <= ONLINE_MS && row.revokedAt === null,
    pairedAt: row.pairedAt,
    pairedLabel: row.pairedLabel,
    lastSeenAt: row.lastSeenAt,
    expiresAt: row.expiresAt,
    staff:
      row.staffId && row.staffName && bound(row, now)
        ? { id: row.staffId, name: row.staffName }
        : null,
    today,
    createdAt: row.createdAt,
  };
}

/** An export names its org and a window; the other filters of the list apply. */
export const ScanExportQuerySchema = ScanListQuerySchema.omit({ cursor: true, limit: true }).extend(
  {
    orgId: IdSchema,
    from: z.coerce.number().int().nonnegative(),
    to: z.coerce.number().int().nonnegative(),
  },
);
