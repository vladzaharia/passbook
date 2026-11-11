import { z } from 'zod';
import { createRouter, register } from '../../platform/openapi.ts';
import { clientIp, rateLimit } from '../../platform/rate-limit.ts';
import { type C, svc } from '../passes/http.ts';
import { handleGoogleCallback } from './google-callback-handler.ts';

/** Mount at /wallet/v1/google; the canonical class URL ends in /{accountId}. */
export const googleCallbackRoutes = createRouter({ bodyLimit: false });
googleCallbackRoutes.use(
  '*',
  rateLimit('RL_APPLE_IP', (c) => `google:${clientIp(c)}`),
);

async function googleCallback(c: C): Promise<Response> {
  await handleGoogleCallback(svc(c), c.req.raw, c.req.param('accountId') ?? '');
  return new Response(null, {
    status: 204,
    headers: {
      'cache-control': 'private, no-store',
      'referrer-policy': 'no-referrer',
      'x-content-type-options': 'nosniff',
    },
  });
}

register(
  googleCallbackRoutes,
  'google-wallet',
  {
    method: 'post',
    path: '/{accountId}',
    params: z.object({ accountId: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/) }),
    status: 204,
    summary: 'Receive a signed Google Wallet save or delete callback',
  },
  googleCallback,
);
