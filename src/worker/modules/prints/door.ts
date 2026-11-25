import type { ServiceContext } from '../../platform/service-context.ts';
import { existingChannels } from '../channels/door.ts';
import type { Pass } from '../passes/repo-map.ts';

export interface PrintHit {
  status: string;
  voidedAt: number | null;
  cause: string | null;
}

/**
 * A print code that no longer admits: replaced by a reprint, or voided. An active print goes on to
 * the pass's own rules, and so does one voided with its pass while the pass is still void: the
 * door then says why the pass is refused.
 */
export function printRefusal(candidate: {
  print?: PrintHit;
  pass: Pick<Pass, 'status'>;
}): { reason: 'print_replaced' | 'print_voided'; at: number | null } | null {
  const print = candidate.print;
  if (print?.status !== 'voided') return null;
  if (print.cause === 'pass_voided' && candidate.pass.status === 'voided') return null;
  return {
    reason: print.cause === 'replaced' ? 'print_replaced' : 'print_voided',
    at: print.voidedAt,
  };
}

/**
 * A print hit on a pass whose paper channel is not effectively on (template, org, platform or pass). The
 * plan is set aside: a ticket already printed keeps admitting after a downgrade, and only a new print is
 * refused. A refusal does not void, so turning paper back on restores the ticket.
 */
export async function paperOff(
  ctx: ServiceContext,
  candidate: { print?: PrintHit; pass: Pass },
): Promise<boolean> {
  return candidate.print ? !(await existingChannels(ctx, candidate.pass)).paper.on : false;
}
