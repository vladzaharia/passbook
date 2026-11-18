import { z } from 'zod';
import { NotFoundError } from '../../platform/errors.ts';
import { createRouter, register } from '../../platform/openapi.ts';
import { rateLimit } from '../../platform/rate-limit.ts';
import { openWalletArt } from './assets.ts';

/** Mount at /w/i. Providers fetch these without a session; only template art is ever stored here. */
export const walletImageRoutes = createRouter();
walletImageRoutes.use('*', rateLimit('RL_PUBLIC_ASSET'));

const FILE = /^([0-9a-f]{64})(?:\.png)?$/;

register(
  walletImageRoutes,
  'public',
  {
    method: 'get',
    path: '/{file}',
    summary: 'Fetch a template image for a native wallet',
    params: z.object({ file: z.string().max(80) }),
    status: 200,
  },
  async (c) => {
    const hash = FILE.exec(c.req.valid('param').file)?.[1];
    const object = hash ? await openWalletArt(c.env, hash) : null;
    if (!hash || !object) throw new NotFoundError('Image not found.', 'WALLET_IMAGE_NOT_FOUND');
    return new Response(object.body, {
      headers: {
        'content-type': 'image/png',
        'content-length': String(object.size),
        'cache-control': 'public, max-age=31536000, immutable',
        etag: `"${hash}"`,
        'x-content-type-options': 'nosniff',
      },
    });
  },
);
