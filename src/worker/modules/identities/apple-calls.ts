import type { z } from 'zod';
import type { AppleCallListSchema } from '../../../shared/contracts/identities.ts';
import { UnavailableError } from '../../platform/errors.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { ascClient } from './asc-client.ts';

/** The provisioner's ledger since `since` (ms). An unbound provisioner reads as `available: false`. */
export async function listAppleCalls(
  ctx: ServiceContext,
  since: number,
): Promise<z.infer<typeof AppleCallListSchema>> {
  try {
    const calls = await ascClient(ctx.env as { APPLE?: unknown }).calls(since);
    return {
      available: true,
      items: calls.map(({ appleRequestId: _id, ...c }) => c),
    };
  } catch (error) {
    if (error instanceof UnavailableError && error.code === 'ASC_UNAVAILABLE')
      return { available: false, items: [] };
    throw error;
  }
}
