import { z } from 'zod';
import { IdSchema } from '../../../shared/contracts/common.ts';
import type { AppBindings } from '../../platform/context.ts';
import { NotFoundError } from '../../platform/errors.ts';
import { createRouter, register } from '../../platform/openapi.ts';
import { rateLimit } from '../../platform/rate-limit.ts';
import { brandingKey, webLogoKey } from './branding-files.ts';
import { currentBranding } from './repo-branding-gc.ts';

type BrandingJson = { logo?: { sha: string; storageVersion?: string } };

/**
 * Mount at /brand. Org web logos for holder pages and emails, without a session. Content-addressed:
 * the path names the org and the PNG's digest, and only that org's own key is ever read, so one
 * org's path never serves another's file. Nothing else is stored under this prefix.
 */
export const brandAssetRoutes = createRouter();
brandAssetRoutes.use('*', rateLimit('RL_PUBLIC_ASSET'));

/** The org's web logo by digest, else its pass logo when that is the one named (the web logo may be the pass logo). */
async function logoObject(env: AppBindings['Bindings'], orgId: string, sha: string) {
  const web = await env.BUCKET.get(webLogoKey(orgId, sha));
  if (web) return web;
  const json = await currentBranding(env.DB, orgId);
  const logo = (json ? (JSON.parse(json) as BrandingJson) : {}).logo;
  return logo?.sha === sha
    ? env.BUCKET.get(brandingKey(orgId, 'logo', 3, logo.storageVersion))
    : null;
}

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
    const object = sha ? await logoObject(c.env, orgId, sha) : null;
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
