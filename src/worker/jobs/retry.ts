export const JOBS_QUEUE = 'wallet-jobs';
export const DLQ_QUEUE = 'wallet-jobs-dlq';

/** Exponential backoff in seconds for the nth attempt (30 s, 1 min, 2 min, ... capped at 1 h). */
export function retryDelaySeconds(attempts: number): number {
  return Math.min(3600, 30 * 2 ** Math.max(0, attempts - 1));
}
