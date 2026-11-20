import type { QUICKSTART_STEPS } from '../../../shared/contracts/developer.ts';

type Step = (typeof QUICKSTART_STEPS)[number];

/**
 * Tells the funnel a step happened. The body is a step name and, for a failure, the problem's stable code: the
 * server knows the org from the session, so nothing about the person, the pass or the key leaves the page. It never
 * blocks or surfaces: a lost beacon is a missed data point, not a broken quickstart.
 */
export function beacon(csrf: string, step: Step, code?: string): void {
  void fetch('/developers/beacon', {
    method: 'POST',
    keepalive: true,
    headers: { 'content-type': 'application/json', 'x-csrf-token': csrf },
    body: JSON.stringify({ step, ...(code ? { code } : {}) }),
  }).catch(() => undefined);
}
