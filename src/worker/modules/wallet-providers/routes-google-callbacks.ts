import { z } from 'zod';
import { createRouter, register } from '../../platform/openapi.ts';
import { gateMisses, rateLimit } from '../../platform/rate-limit.ts';
import { type C, svc } from '../passes/http.ts';
import { handleGoogleCallback } from './google-callback-handler.ts';

const GOOGLE_CALLBACK_REJECTS_PER_MINUTE = 60;

/** Mount at /wallet/v1/google; the canonical class URL ends in /{accountId}. */
export const googleCallbackRoutes = createRouter({ bodyLimit: false });
// Google calls from a small crawler pool, so callbacks get their own high limit rather than
// sharing the per-IP Apple budget.
googleCallbackRoutes.use('*', rateLimit('RL_GOOGLE_CALLBACK'));
// Rejected callbacks cost keyset reads and signature checks; valid and redelivered ones are free.
// Reuses the D1 miss counters (no extra binding), charged per network prefix on 401 only.
googleCallbackRoutes.use(
  '*',
  gateMisses(GOOGLE_CALLBACK_REJECTS_PER_MINUTE, { status: 401, name: 'google.callback.reject' }),
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
