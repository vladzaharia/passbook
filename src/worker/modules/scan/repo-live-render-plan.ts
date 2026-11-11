import type { OutputPredicate } from './repo-output-predicates.ts';

export function liveRowUnexpiredPredicate(now: number, expiresAt: number): OutputPredicate {
  return { sql: '? < ?', params: [now, expiresAt] };
}
