import { z } from 'zod';
import { NotFoundError } from '../../platform/errors.ts';
import { createRouter, register } from '../../platform/openapi.ts';
import { rateLimit } from '../../platform/rate-limit.ts';
import { serviceContext } from '../../platform/service-context.ts';
import { downloadByCode } from './device-pass-download.ts';
import { devicePassEnabled } from './device-pass-identity.ts';

/** Mount at /d. The one-time download a phone opens from the QR code. */
export const devicePassPublicRoutes = createRouter();
devicePassPublicRoutes.use('/:code', async (c, next) => {
  if (!devicePassEnabled(c.env)) throw new NotFoundError();
  await next();
});
devicePassPublicRoutes.use('/:code', rateLimit('RL_PUBLIC'));

register(
  devicePassPublicRoutes,
  'public',
  {
    method: 'get',
    path: '/{code}',
    summary:
      'A device pass, once: the signed Test pass for a one-time code (410 when used or expired)',
    operationId: 'public.getDevicePassByCode',
    params: z.object({ code: z.string().min(16).max(128) }),
    public: true,
  },
  async (c) => {
    // Link previewers send HEAD; it must not spend the one-time code.
    if (c.req.method === 'HEAD')
      return new Response(null, {
        status: 200,
        headers: { 'cache-control': 'no-store', 'referrer-policy': 'no-referrer' },
      });
    return downloadByCode(serviceContext(c), c.req.valid('param').code);
  },
);
