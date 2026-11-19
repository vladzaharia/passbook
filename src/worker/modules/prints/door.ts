export interface PrintHit {
  status: string;
  voidedAt: number | null;
  cause: string | null;
}

/** A print code that no longer admits: replaced by a reprint, or voided. Active and used prints go on to the pass's own rules. */
export function printRefusal(candidate: {
  print?: PrintHit;
}): { reason: 'print_replaced' | 'print_voided'; at: number | null } | null {
  const print = candidate.print;
  if (print?.status !== 'voided') return null;
  return {
    reason: print.cause === 'replaced' ? 'print_replaced' : 'print_voided',
    at: print.voidedAt,
  };
}
