import { z } from 'zod';
import { IdSchema } from '../../../shared/contracts/common.ts';
import { NotFoundError } from '../../platform/errors.ts';
import { createRouter, register } from '../../platform/openapi.ts';
import { rateLimit } from '../../platform/rate-limit.ts';
import { webLogoKey } from './branding-files.ts';

/**
 * Mount at /brand. Org web logos for holder pages and emails, without a session. Content-addressed:
 * the path names the org and the PNG's digest, and only that org's own key is ever read, so one
 * org's path never serves another's file. Nothing else is stored under this prefix.
 */
export const brandAssetRoutes = createRouter();
brandAssetRoutes.use('*', rateLimit('RL_PUBLIC_ASSET'));

const FILE = /^([0-9a-f]{64})\.png$/;

register(
  brandAssetRoutes,
  'public',
  {
    method: 'get',
    path: '/{orgId}/{file}',
    summary: 'An organization web logo',
    params: z.object({ orgId: IdSchema, file: z.string().max(80) }),
    status: 200,
  },
  async (c) => {
    const { orgId, file } = c.req.valid('param');
    const sha = FILE.exec(file)?.[1];
    const object = sha ? await c.env.BUCKET.get(webLogoKey(orgId, sha)) : null;
    if (!sha || !object) throw new NotFoundError('Image not found.', 'BRAND_IMAGE_NOT_FOUND');
    return new Response(object.body, {
      headers: {
        'content-type': 'image/png',
        'content-length': String(object.size),
        'cache-control': 'public, max-age=31536000, immutable',
        etag: `"${sha}"`,
        'x-content-type-options': 'nosniff',
        'content-security-policy': "default-src 'none'",
        // Mail clients and other pages embed it; it is a public, content-addressed logo.
        'cross-origin-resource-policy': 'cross-origin',
      },
    });
  },
);
