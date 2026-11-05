import type { PassJson } from '../../passkit/types.ts';

export type Validity = {
  status: 'active' | 'voided' | 'expired';
  /** Wallet has no start date: always null. */
  validFrom: number | null;
  /** `expirationDate` in ms, null when absent or unparseable. */
  validUntil: number | null;
};

/** The one expiry rule: voided wins, then an `expirationDate` strictly before `now`. */
export function validityOf(pass: PassJson, now: Date): Validity {
  const parsed =
    typeof pass.expirationDate === 'string' ? new Date(pass.expirationDate).getTime() : Number.NaN;
  const validUntil = Number.isNaN(parsed) ? null : parsed;
  const status =
    pass.voided === true
      ? 'voided'
      : validUntil !== null && validUntil < now.getTime()
        ? 'expired'
        : 'active';
  return { status, validFrom: null, validUntil };
}
