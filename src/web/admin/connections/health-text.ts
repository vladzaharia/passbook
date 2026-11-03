import type { z } from 'zod';
import type { ConnectionSchema } from '@/shared/contracts/connections.ts';
import { formatDateTime, formatTime } from '../../lib/format.ts';

type Connection = z.infer<typeof ConnectionSchema>;

/** 4:03 AM today, else the full date-time. */
export function clock(ms: number, now: number): string {
  const sameDay = new Date(ms).toDateString() === new Date(now).toDateString();
  return sameDay ? formatTime(ms) : formatDateTime(ms);
}

const failures = (n: number) => `${n} ${n === 1 ? 'failure' : 'failures'}`;

/** "in 1 min", "in 3 h": a short wait until a run. */
export function until(ms: number, now: number): string {
  const min = Math.max(1, Math.round((ms - now) / 60_000));
  return min < 60 ? `in ${min} min` : `in ${Math.round(min / 60)} h`;
}

/** The muted line under a list row's health pill: "1 failure · retries at 4:03 AM". */
export function healthLine(c: Connection, now: number): string | null {
  if (!c.enabled) return null;
  if (c.breakerOpenUntil && c.breakerOpenUntil > now)
    return `Paused after repeated failures · until ${clock(c.breakerOpenUntil, now)}`;
  if (c.consecutiveFailures > 0) {
    const next = c.nextRunAt && c.nextRunAt > now ? ` · retries at ${clock(c.nextRunAt, now)}` : '';
    return `${failures(c.consecutiveFailures)}${next}`;
  }
  if (c.lastSuccessAt) return `Synced ${clock(c.lastSuccessAt, now)}`;
  return null;
}

/**
 * The health card's opening sentence: "Degraded since 4:02 AM · 1 failure in a row · next retry in
 * 1 min". Healthy connections say when they last synced and when they run next.
 */
export function healthSentence(c: Connection, now: number, failingSince?: number): string {
  if (!c.enabled) return 'Disabled. Nothing syncs until it is enabled.';
  const parts: string[] = [];
  if (c.consecutiveFailures > 0) {
    // Same word as the header pill: one state, one name.
    const word = c.health === 'degraded' ? 'Degraded' : 'Failing';
    parts.push(`${word} since ${clock(failingSince ?? c.lastErrorAt ?? now, now)}`);
    parts.push(`${failures(c.consecutiveFailures)} in a row`);
    if (c.breakerOpenUntil && c.breakerOpenUntil > now)
      parts.push(`paused until ${clock(c.breakerOpenUntil, now)}`);
    else if (c.nextRunAt)
      parts.push(`next retry ${c.nextRunAt > now ? until(c.nextRunAt, now) : 'overdue'}`);
    return parts.join(' · ');
  }
  parts.push(c.lastSuccessAt ? `Synced ${clock(c.lastSuccessAt, now)}` : 'Not synced yet');
  if (c.nextRunAt)
    parts.push(`next run ${c.nextRunAt > now ? until(c.nextRunAt, now) : 'overdue'}`);
  return parts.join(' · ');
}

/** The next run is more than a minute late (the scheduler missed it). */
export const overdue = (c: Connection, now: number) =>
  c.enabled && c.nextRunAt !== null && c.nextRunAt < now - 60_000;
