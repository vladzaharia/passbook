import { createJobContext, type ServiceContext } from '../platform/service-context.ts';

/**
 * A holder's first tap on Google builds the object itself, so the pass's pending upsert runs inside the
 * request. A request holds no job authority; this is the one place a wallet sync gets it, for one exact
 * operation the caller has just created. `tools/authority-scope.ts` allows only `wallet-providers/offers.ts`
 * to import it.
 */
export function walletFirstTapContext(ctx: ServiceContext): ServiceContext {
  return {
    ...createJobContext(ctx.env, 'wallet-first-tap', { clock: ctx.clock, log: ctx.log }),
    ids: ctx.ids,
    requestId: ctx.requestId,
    waitUntil: ctx.waitUntil,
  };
}
