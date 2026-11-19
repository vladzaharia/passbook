import { bump, read } from '../../platform/counters.ts';

export const PROVIDERS = ['apple', 'google', 'samsung'] as const;
export type Provider = (typeof PROVIDERS)[number];
export type Cost = Partial<Record<Provider, number>>;

/** Provider calls one page may start. */
export const PAGE_CAP: Record<Provider, number> = { apple: 100, google: 50, samsung: 50 };
/**
 * Provider calls all channel-apply runs together may start in a minute. Google's quota on the shared
 * issuer is unknown: the owner confirms these before Google ships.
 */
export const MINUTE_CAP: Record<Provider, number> = { apple: 1200, google: 300, samsung: 300 };

const MINUTE = 60_000;
export const minuteOf = (now: number): number => now - (now % MINUTE);
export const msToNextMinute = (now: number): number => minuteOf(now) + MINUTE - now;

const key = (p: Provider, minute: number) => `channels:budget:${p}:${minute}`;

/** What a page may still spend: the lower of the page cap and the minute's remainder. */
export class PageBudget {
  private readonly left: Record<Provider, number>;
  private readonly minuteLeft: Record<Provider, number>;

  private constructor(left: Record<Provider, number>, minuteLeft: Record<Provider, number>) {
    this.left = left;
    this.minuteLeft = minuteLeft;
  }

  static async open(db: D1Database, now: number): Promise<PageBudget> {
    const minute = minuteOf(now);
    const used = await Promise.all(PROVIDERS.map((p) => read(db, key(p, minute), minute)));
    const minuteLeft = Object.fromEntries(
      PROVIDERS.map((p, i) => [p, Math.max(0, MINUTE_CAP[p] - (used[i] ?? 0))]),
    ) as Record<Provider, number>;
    return new PageBudget({ ...PAGE_CAP }, minuteLeft);
  }

  /** Why the cost does not fit: the minute budget (wait for the next minute) or the page cap (the page ends). */
  blocked(cost: Cost): 'minute' | 'page' | null {
    for (const p of PROVIDERS) {
      const n = cost[p] ?? 0;
      if (n > this.minuteLeft[p]) return 'minute';
    }
    for (const p of PROVIDERS) if ((cost[p] ?? 0) > this.left[p]) return 'page';
    return null;
  }

  take(cost: Cost): void {
    for (const p of PROVIDERS) {
      this.left[p] -= cost[p] ?? 0;
      this.minuteLeft[p] -= cost[p] ?? 0;
    }
  }
}

/** Records what a committed pass cost against the minute. */
export async function spend(db: D1Database, now: number, cost: Cost): Promise<void> {
  const minute = minuteOf(now);
  for (const p of PROVIDERS) if (cost[p]) await bump(db, key(p, minute), minute, cost[p]);
}
