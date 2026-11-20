/** Why a request failed, as the machine's `fail` event names it. */
export type FailCode =
  | 'network'
  | 'timeout'
  | 'server'
  | 'rate_limited'
  | 'revoked'
  | 'suspended'
  | 'signed_out'
  | 'forbidden'
  | 'staff_required'
  | 'pin_invalid'
  | 'pin_locked';

/** Why a Manager's PIN was not taken: `triesLeft` is the lockout's own count. */
export type PinNote =
  | { triesLeft: number }
  | { locked: true; retryAfterMs?: number }
  /** The PIN never got an answer (timeout, no connection): nothing was checked, nothing is let in. */
  | { unreachable: true };

/** No more tries now: locked out, or the last one was spent. */
export const pinSpent = (note: PinNote | undefined): boolean =>
  note !== undefined && ('locked' in note || ('triesLeft' in note && note.triesLeft === 0));
