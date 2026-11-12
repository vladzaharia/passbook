import type { z } from 'zod';
import type { IdentitySchema } from '@/shared/contracts/identities.ts';
import { remainingDays, WARN_DAYS } from './expiry.tsx';

type Identity = z.infer<typeof IdentitySchema>;

export const ATTENTION_COPY = {
  expired: 'has expired',
  not_yet_valid: 'is not yet valid',
  expiring: 'is nearing expiry',
} as const;

export interface Attention {
  /** The most urgent: expired, then not yet valid, then soonest to expire. */
  identity: Identity;
  reason: keyof typeof ATTENTION_COPY;
  /** How many identities need a look. */
  count: number;
}

/** The identity whose certificate needs a look first, or undefined when none does. */
export function identityAttention(rows: readonly Identity[], now: number): Attention | undefined {
  let top: (Attention & { priority: number; order: number }) | undefined;
  let count = 0;
  for (const identity of rows) {
    const days = remainingDays(identity, now);
    const reason =
      days !== null && days < 0
        ? 'expired'
        : identity.notBefore !== null && identity.notBefore > now
          ? 'not_yet_valid'
          : days !== null && days <= WARN_DAYS
            ? 'expiring'
            : undefined;
    if (!reason) continue;
    count += 1;
    const priority = reason === 'expired' ? 0 : reason === 'not_yet_valid' ? 1 : 2;
    const order = reason === 'not_yet_valid' ? (identity.notBefore ?? now) : (days ?? 0);
    if (!top || priority < top.priority || (priority === top.priority && order < top.order)) {
      top = { identity, reason, count, priority, order };
    }
  }
  return top ? { identity: top.identity, reason: top.reason, count } : undefined;
}
