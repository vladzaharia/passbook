/** Matches the server default (refresh.userCooldownSeconds); an admin may change that setting. */
export const COOLDOWN_MS = 30_000;
/** Stop showing "pending" when the device never pulled the update. */
export const PENDING_TIMEOUT_MS = 2 * 60_000;

export interface RefreshFields {
  lastRefreshedAt: number | null;
  refreshRequestedAt: number | null;
}

export type RefreshPhase = 'idle' | 'pending' | 'cooldown';

export function isPendingRefresh(
  pass: RefreshFields,
  now: number,
  localRequestedAt?: number | null,
): boolean {
  const requested = Math.max(pass.refreshRequestedAt ?? 0, localRequestedAt ?? 0);
  if (!requested) return false;
  if ((pass.lastRefreshedAt ?? 0) >= requested) return false;
  return now - requested < PENDING_TIMEOUT_MS;
}

export function refreshPhase(
  pass: RefreshFields,
  now: number,
  localRequestedAt?: number | null,
): { phase: RefreshPhase; secondsLeft: number } {
  if (isPendingRefresh(pass, now, localRequestedAt)) return { phase: 'pending', secondsLeft: 0 };
  const requested = Math.max(pass.refreshRequestedAt ?? 0, localRequestedAt ?? 0);
  const left = requested + COOLDOWN_MS - now;
  if (requested && left > 0) return { phase: 'cooldown', secondsLeft: Math.ceil(left / 1000) };
  return { phase: 'idle', secondsLeft: 0 };
}
