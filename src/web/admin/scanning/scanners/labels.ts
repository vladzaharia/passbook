import type { ScannerSetup } from '@/shared/contracts/scan-setups.ts';
import type { ScannerDto } from '@/shared/contracts/scanners.ts';

export type ScannerStatus = 'revoked' | 'not_paired' | 'online' | 'offline';

/** One pill per scanner: revoked and not paired beat the heartbeat (seen within 2 min). */
export function scannerStatus(s: Pick<ScannerDto, 'status' | 'online'>): ScannerStatus {
  if (s.status === 'revoked') return 'revoked';
  if (s.status === 'not_paired') return 'not_paired';
  return s.online ? 'online' : 'offline';
}

/** "Saturday gala" (once the event name is known), "An event", or "2 templates". */
export function acceptsText(
  s: Pick<ScannerDto, 'accepts'> & Partial<Pick<ScannerSetup, 'settings' | 'deviceRole' | 'watch'>>,
  eventName?: string,
): string {
  if (s.deviceRole === 'customer' || s.deviceRole === 'monitor')
    return s.watch?.allOrg ? 'All scanners' : `${s.watch?.scannerIds.length ?? 0} scanners`;
  if (!s.accepts) return s.settings?.acceptAllTemplates ? 'All passes' : '—';
  if ('eventId' in s.accepts) return eventName ?? 'An event';
  const n = s.accepts.templateIds.length;
  return `${n} ${n === 1 ? 'template' : 'templates'}`;
}

/** The typed form of a pairing code: "K7QH2-M9XTR". Case and the dash do not matter to the server. */
export function formatCode(code: string): string {
  const c = code.replace(/[^0-9a-z]/gi, '').toUpperCase();
  return c.length > 5 ? `${c.slice(0, 5)}-${c.slice(5)}` : c;
}

/** The QR payload: this origin, never a fixed host (wallet.plrs.im and passbook.mobile both serve). */
export const pairingUrl = (code: string): string =>
  `${window.location.origin}/scan#pair=${code.replace(/[^0-9a-z]/gi, '').toUpperCase()}`;

/** "9:42" from milliseconds left; never negative. */
export function formatCountdown(ms: number): string {
  const total = Math.max(0, Math.ceil(ms / 1000));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
}
