import type { BenchGet } from '../bench/trace-events.ts';
import { readWithToken } from './send.ts';

/** GET under /api/v1 with the console's try token (it counts against the Run budget): what the Trace reads events with. */
export const tokenGet =
  (csrf: string): BenchGet =>
  async <T>(path: string): Promise<T> => {
    const res = await readWithToken(`/api/v1${path}`, { accept: 'application/json' }, csrf);
    if (!res.ok) throw new Error(`Events did not load (${res.status}).`);
    return (await res.json()) as T;
  };

/** Webhook events follow the call by a moment: ask once they have had it. */
export const EVENTS_AFTER_MS = 1500;

/** A string `secret` in the answer, at the top or one object down: a key or signing secret shown in full. */
export function showsSecret(json: unknown): boolean {
  if (json === null || typeof json !== 'object') return false;
  return Object.entries(json).some(
    ([k, v]) =>
      (k === 'secret' && typeof v === 'string') ||
      (v !== null &&
        typeof v === 'object' &&
        !Array.isArray(v) &&
        typeof (v as { secret?: unknown }).secret === 'string'),
  );
}
