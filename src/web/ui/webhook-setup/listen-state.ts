import type { Arrival, SetupTopic } from './types.ts';

export type ListenPhase = 'listening' | 'signed' | 'rejected';

export interface Verdict {
  phase: ListenPhase;
  /** The newest delivery whose signature verified (accepted, duplicate or ignored). */
  verified: Arrival | null;
  /** The newest delivery that was refused. */
  rejected: Arrival | null;
  /** Topic ids named by verified deliveries, from the recipe's list. */
  seen: string[];
}

/** A signed delivery is any that was not refused: ignored ones passed verification too. */
export const isSigned = (a: Pick<Arrival, 'outcome'>) => a.outcome !== 'rejected';

/**
 * What the rows add up to. A bad signature never ends the wait: the next delivery can still pass,
 * and a pass wins over an earlier refusal.
 */
export function judge(rows: readonly Arrival[], topics: readonly SetupTopic[]): Verdict {
  const newest = [...rows].sort((a, b) => b.receivedAt - a.receivedAt);
  const verified = newest.find(isSigned) ?? null;
  const rejected = newest.find((a) => !isSigned(a)) ?? null;
  const known = new Set(topics.map((t) => t.id));
  const seen = [
    ...new Set(
      newest.filter(isSigned).flatMap((a) => (a.topic && known.has(a.topic) ? [a.topic] : [])),
    ),
  ];
  return {
    phase: verified ? 'signed' : rejected ? 'rejected' : 'listening',
    verified,
    rejected,
    seen,
  };
}
