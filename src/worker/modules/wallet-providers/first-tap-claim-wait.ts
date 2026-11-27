import type { WalletOperation } from './instance-types.ts';

const FIRST_POLL_MS = 50;
const MAX_POLL_MS = 1000;

/**
 * Waits while another runner (the minute cron) holds the operation's claim: re-reads with a doubling
 * pause, and stops once the row is no longer claimed, its claim has expired (the holder is gone), or the
 * caller's budget is over. A bundle polls one member per link part, so the reads must stay few.
 */
export async function waitForClaimHolder(p: {
  read: () => Promise<WalletOperation | null>;
  now: () => number;
  sleep: (ms: number) => Promise<void>;
  over: () => boolean;
}): Promise<void> {
  let pause = FIRST_POLL_MS;
  while (!p.over()) {
    const row = await p.read();
    if (row?.state !== 'claimed') return;
    if (row.claimExpiresAt !== null && row.claimExpiresAt <= p.now()) return;
    await p.sleep(pause);
    pause = Math.min(pause * 2, MAX_POLL_MS);
  }
}
