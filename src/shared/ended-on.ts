/**
 * The date a voided or expired pass stopped working: the expiry the pass names, else the day it
 * last changed (a voided pass changes when it is voided). Null when neither is a date.
 */
export function endedOn(
  state: 'voided' | 'expired',
  pass: { modifiedAt: number; expirationDate?: unknown },
  locale = 'en',
  timeZone = 'UTC',
): string | null {
  const expiry = typeof pass.expirationDate === 'string' ? Date.parse(pass.expirationDate) : NaN;
  const at = state === 'expired' && Number.isFinite(expiry) ? expiry : pass.modifiedAt;
  if (!Number.isFinite(at)) return null;
  try {
    return new Intl.DateTimeFormat(locale, { dateStyle: 'long', timeZone }).format(at);
  } catch {
    return null;
  }
}
