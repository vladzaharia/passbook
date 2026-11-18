/**
 * The date a voided or expired pass stopped working: the expiry the pass names, else the recorded
 * void time, else the day it last changed. Null when neither is a date.
 */
export function endedOn(
  state: 'voided' | 'expired',
  pass: { modifiedAt: number; voidedAt?: number | null; expirationDate?: unknown },
  locale = 'en',
  timeZone = 'UTC',
): string | null {
  const expiry = typeof pass.expirationDate === 'string' ? Date.parse(pass.expirationDate) : NaN;
  const at =
    state === 'expired' && Number.isFinite(expiry) ? expiry : (pass.voidedAt ?? pass.modifiedAt);
  if (!Number.isFinite(at)) return null;
  try {
    return new Intl.DateTimeFormat(locale, { dateStyle: 'long', timeZone }).format(at);
  } catch {
    return null;
  }
}
