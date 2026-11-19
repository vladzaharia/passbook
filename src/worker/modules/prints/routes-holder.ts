import { sameOriginOnly } from '../../platform/csrf.ts';
import { createRouter } from '../../platform/openapi.ts';
import { ASSET_MISSES_PER_MINUTE, gateMisses, rateLimit } from '../../platform/rate-limit.ts';
import { svc } from '../passes/http.ts';
import { passForToken } from '../public/service.ts';
import { linkWriter } from './repo-write.ts';
import { HOLDER_PRINTS_PER_HOUR, mintPrint, voidPrint } from './service.ts';

/**
 * /p/:token/print: the holder's own print, by bearer link. POSTs only, no pass or page is read here:
 * the first POST mints, `reprint` replaces, `void` ends it. A rotated link or a transfer stops them.
 */
export const holderPrintRoutes = createRouter();
holderPrintRoutes.use('/:token/print', sameOriginOnly);
holderPrintRoutes.use('/:token/print/*', sameOriginOnly);
holderPrintRoutes.use('/:token/print', gateMisses(ASSET_MISSES_PER_MINUTE));
holderPrintRoutes.use('/:token/print/*', gateMisses(ASSET_MISSES_PER_MINUTE));
holderPrintRoutes.use('/:token/print', rateLimit('RL_PUBLIC'));
holderPrintRoutes.use('/:token/print/*', rateLimit('RL_PUBLIC'));

/** An unknown, rotated or malformed link is a plain 404 (passForToken throws it). */
async function holderCall(c: Parameters<typeof svc>[0]) {
  const ctx = svc(c);
  const pass = await passForToken(ctx, c.req.param('token') ?? '');
  return { ctx, pass, caller: { writer: linkWriter(pass), limit: HOLDER_PRINTS_PER_HOUR } };
}

const noStore = { 'cache-control': 'private, no-store' };

holderPrintRoutes.post('/:token/print', async (c) => {
  const call = await holderCall(c);
  const print = await mintPrint(call.ctx, call.caller, call.pass, false);
  return c.json(print, 200, noStore);
});

holderPrintRoutes.post('/:token/print/reprint', async (c) => {
  const call = await holderCall(c);
  return c.json(await mintPrint(call.ctx, call.caller, call.pass, true), 200, noStore);
});

holderPrintRoutes.post('/:token/print/void', async (c) => {
  const call = await holderCall(c);
  return c.json(await voidPrint(call.ctx, call.caller, call.pass, 'holder'), 200, noStore);
});
