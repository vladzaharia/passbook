import type { ScannerSettings } from './contracts/scan.ts';

/** What a door does with no connection (O8): refuse, queue an unverified entry, or decide on the roster. */
export type OfflineMode = NonNullable<ScannerSettings['whenOffline']>;

export const offlineModeOf = (s: Pick<ScannerSettings, 'offline' | 'whenOffline'>): OfflineMode =>
  s.whenOffline ?? (s.offline ? 'list' : 'stop');

export type OfflineVerdict = { ok: true } | { ok: false; code: string; message: string };

const no = (code: string, message: string): OfflineVerdict => ({ ok: false, code, message });

/**
 * What settings and zones alone settle about the offline list. It lets a door admit with no server,
 * so only entry-only, check-in once or daily, zone-free sessions qualify. The server adds the
 * templates' own actions when the list is asked for.
 */
export function settingsOfflineVerdict(
  settings: Pick<ScannerSettings, 'checkIn' | 'direction'>,
  zoneCount: number,
): OfflineVerdict {
  const mode = settings.checkIn?.mode;
  if (mode !== undefined && mode !== 'single' && mode !== 'daily')
    return no('OFFLINE_NEEDS_ONCE_OR_DAILY', 'The offline list needs check-in once or daily.');
  if (settings.direction !== undefined && settings.direction !== 'in')
    return no('OFFLINE_NEEDS_ENTRY_ONLY', 'The offline list is for entry only.');
  if (zoneCount > 0) return no('OFFLINE_NO_ZONES', 'A session with zones stays online.');
  return { ok: true };
}

/** The roster is a day old at most; past that the door asks for a refresh before it decides. */
export const ROSTER_TTL_MS = 24 * 60 * 60 * 1000;
/** More hashes than this and the session is too big for a device list. */
export const ROSTER_MAX_ENTRIES = 50_000;
/** A queued read stamped further ahead than this is clamped to the server's now. */
export const CLIENT_TS_SLACK_MS = 5 * 60 * 1000;
/** A queued read older than the roster's life is recorded as ended and changes nothing. */
export const CLIENT_TS_MAX_AGE_MS = ROSTER_TTL_MS;
