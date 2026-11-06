export interface Validity {
  status: 'active' | 'voided' | 'expired';
  validFrom: number | null;
  validUntil: number | null;
}

/** One expiry rule for the pass view and the scanner: voided beats expired. */
export function validityOf(
  pass: { voided?: unknown; expirationDate?: unknown },
  now: number,
): Validity {
  const until =
    typeof pass.expirationDate === 'string' ? new Date(pass.expirationDate).getTime() : Number.NaN;
  const validUntil = Number.isFinite(until) ? until : null;
  const status =
    pass.voided === true
      ? 'voided'
      : validUntil !== null && validUntil < now
        ? 'expired'
        : 'active';
  return { status, validFrom: null, validUntil };
}
