export interface CheckOutcome {
  ok: boolean;
  /** A short stable code; null on a plain success. */
  code: string | null;
}

export const CERT_WARN_DAYS = 30;
export const DAY_MS = 86_400_000;
