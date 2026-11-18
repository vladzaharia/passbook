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
export type PinNote = { triesLeft: number } | { locked: true };
