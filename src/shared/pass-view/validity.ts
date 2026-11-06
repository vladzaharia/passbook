export interface Validity {
  status: 'active' | 'voided' | 'expired';
  validFrom: number | null;
  validUntil: number | null;
}

/** Wallet has no start date; voided takes precedence over expiry. */
export function validityOf(
  pass: { voided?: unknown; expirationDate?: unknown },
  now: number | Date,
): Validity {
  const parsed = typeof pass.expirationDate === 'string' ? Date.parse(pass.expirationDate) : NaN;
  const validUntil = Number.isFinite(parsed) ? parsed : null;
  const at = typeof now === 'number' ? now : now.getTime();
  const status =
    pass.voided === true ? 'voided' : validUntil !== null && validUntil < at ? 'expired' : 'active';
  return { status, validFrom: null, validUntil };
}
