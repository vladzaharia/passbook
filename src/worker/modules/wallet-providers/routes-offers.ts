import { z } from 'zod';
import { PublicTokenParamSchema } from '../../../shared/contracts/public.ts';
import { createRouter, register } from '../../platform/openapi.ts';
import { rateLimit } from '../../platform/rate-limit.ts';
import { svc } from '../passes/http.ts';
import { issueWalletOffer, redeemSamsungOffer } from './offers.ts';

/** Mount at /p alongside the public pass routes. */
export const walletOfferRoutes = createRouter();

walletOfferRoutes.use('/:token/wallet/:provider', rateLimit('RL_PUBLIC'));
walletOfferRoutes.use('/wallet/samsung/:offer', rateLimit('RL_PUBLIC'));

const headers = {
  'cache-control': 'private, no-store',
  'referrer-policy': 'no-referrer',
  'x-robots-tag': 'noindex, nofollow',
};

register(
  walletOfferRoutes,
  'public',
  {
    method: 'get',
    path: '/{token}/wallet/{provider}',
    summary: 'Add a pass to a native wallet',
    params: PublicTokenParamSchema.extend({ provider: z.enum(['google', 'samsung']) }),
    status: 302,
  },
  async (c) => {
    const { token, provider } = c.req.valid('param');
    const location = await issueWalletOffer(svc(c), token, provider);
    return new Response(null, { status: 302, headers: { ...headers, location } });
  },
);

register(
  walletOfferRoutes,
  'public',
  {
    method: 'get',
    path: '/wallet/samsung/{offer}',
    summary: 'Open a Samsung Wallet offer',
    params: z.object({ offer: z.string().min(1).max(256) }),
    status: 302,
  },
  async (c) => {
    const location = await redeemSamsungOffer(svc(c), c.req.valid('param').offer);
    return new Response(null, { status: 302, headers: { ...headers, location } });
  },
);
