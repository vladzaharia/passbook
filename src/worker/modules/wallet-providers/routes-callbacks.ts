import { z } from 'zod';
import { createRouter, register } from '../../platform/openapi.ts';
import { clientIp, rateLimit } from '../../platform/rate-limit.ts';
import { type C, svc } from '../passes/http.ts';
import { handleSamsungCallback } from './callbacks-samsung.ts';

/** Configure Samsung's Partner Server URL as /wallet/v1/samsung. */
export const samsungCallbackRoutes = createRouter({ bodyLimit: false });
samsungCallbackRoutes.use(
  '*',
  rateLimit('RL_APPLE_IP', (c) => `samsung:${clientIp(c)}`),
);

const params = z.object({
  cardId: z.string().regex(/^[A-Za-z0-9_-]{1,32}$/),
  refId: z.string().regex(/^[A-Za-z0-9_-]{32}$/),
});
const headers = {
  'cache-control': 'private, no-store',
  'referrer-policy': 'no-referrer',
  'x-content-type-options': 'nosniff',
};

async function samsungCallback(c: C): Promise<Response> {
  const result = await handleSamsungCallback(svc(c), c.req.raw);
  if (result.kind === 'missing') return new Response(null, { status: 204, headers });
  if (result.kind === 'accepted') return new Response(null, { status: 200, headers });
  return new Response(JSON.stringify({ cdata: result.cdata }), {
    status: 200,
    headers: { ...headers, 'content-type': 'application/json' },
  });
}

register(
  samsungCallbackRoutes,
  'samsung',
  {
    method: 'get',
    path: '/cards/{cardId}/{refId}',
    params,
    summary: 'Fetch approved Samsung Wallet card data',
  },
  samsungCallback,
);
register(
  samsungCallbackRoutes,
  'samsung',
  {
    method: 'post',
    path: '/cards/{cardId}/{refId}',
    params,
    summary: 'Receive a Samsung Wallet card-state callback',
  },
  samsungCallback,
);
