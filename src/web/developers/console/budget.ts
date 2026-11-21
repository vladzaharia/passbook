/**
 * The Run budget: Try it calls are limited per session (RL_API_TRY, 60 a minute). The limiter
 * answers pass or fail, so this counts the runs this page made in the last minute. It is a gauge
 * for the person, not the limit: the server's 429 has the last word.
 */
export const RUN_LIMIT = 60;
const WINDOW_MS = 60_000;

let hits: number[] = [];
let blockedUntil = 0;
const listeners = new Set<() => void>();
let timer: ReturnType<typeof setTimeout> | undefined;

function prune(now: number): void {
  hits = hits.filter((t) => now - t < WINDOW_MS);
}

export function remaining(now = Date.now()): number {
  prune(now);
  return now < blockedUntil ? 0 : Math.max(0, RUN_LIMIT - hits.length);
}

function emit(): void {
  for (const l of listeners) l();
  clearTimeout(timer);
  const now = Date.now();
  const next = Math.min(
    ...hits.map((t) => t + WINDOW_MS),
    blockedUntil > now ? blockedUntil : Infinity,
  );
  if (Number.isFinite(next)) timer = setTimeout(emit, Math.max(250, next - now));
}

/** A call went out. */
export function spend(now = Date.now()): void {
  hits.push(now);
  emit();
}

/** The server said 429: nothing left until `seconds` pass. */
export function exhausted(seconds: number, now = Date.now()): void {
  blockedUntil = now + Math.max(1, seconds) * 1000;
  emit();
}

export function subscribe(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function resetBudget(): void {
  hits = [];
  blockedUntil = 0;
  clearTimeout(timer);
  listeners.clear();
}
