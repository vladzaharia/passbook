import { BASE } from './api.ts';

/**
 * Runs the platform's minute cron once, as the clock would. workerd serves this path itself in
 * local dev and in `vite preview`; a deployed Worker has no such route, so nothing here can reach
 * production. Hooks that wait out a quiet minute (the rollout rebuild) need a call after it.
 */
export async function runMinuteCron(): Promise<void> {
  const res = await fetch(
    `${BASE}/cdn-cgi/handler/scheduled?cron=${encodeURIComponent('* * * * *')}`,
  );
  if (!res.ok) throw new Error(`The minute cron did not run: ${res.status}`);
}
