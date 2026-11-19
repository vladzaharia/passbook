import type { ServiceContext } from '../../platform/service-context.ts';
import { passChannels } from '../channels/service.ts';
import type { Pass } from '../passes/repo-map.ts';

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

/**
 * A print hit on a pass whose paper channel is not effectively on (template, org, platform or pass).
 * It refuses without voiding, so turning paper back on restores the ticket.
 */
export async function paperOff(
  ctx: ServiceContext,
  candidate: { print?: PrintHit; pass: Pass },
): Promise<boolean> {
  return candidate.print ? !(await passChannels(ctx, candidate.pass)).effective.paper.on : false;
}
