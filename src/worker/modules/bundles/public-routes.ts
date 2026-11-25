import { z } from 'zod';
import { PKPASSES_CONTENT_TYPE } from '../../../passkit/index.ts';
import {
  PublicBundleAssetParamSchema,
  PublicBundleParamSchema,
  PublicBundlePassParamSchema,
} from '../../../shared/contracts/bundles.ts';
import { passDevice } from '../../../shared/device.ts';
import { BUNDLE_DOOR_SCRIPT } from '../../../shared/pass-offline.ts';
import { baseUrl } from '../../platform/env.ts';
import { AppError } from '../../platform/errors.ts';
import { createRouter, register } from '../../platform/openapi.ts';
import {
  ASSET_MISSES_PER_MINUTE,
  assetBucket,
  gateMisses,
  rateLimit,
} from '../../platform/rate-limit.ts';
import { renderBundlePage } from '../../ssr/bundle-page.tsx';
import { requestTheme } from '../../ssr/head.ts';
import { renderNotFoundPage } from '../../ssr/pass-page.tsx';
import {
  PRESENTATION_HEADERS,
  presentationHeaders,
  renderPresentationPage,
} from '../../ssr/presentation-page.tsx';
import { appleFileGate, recordCopy } from '../channels/gate.ts';
import { orgBrandOf } from '../orgs/brand.ts';
import { svc } from '../passes/http.ts';
import { serveCurrentPassFile } from '../passes/timed-variant.ts';
import { presentationForPass } from '../public/presentation.ts';
import { EMAILED, langOf, PAGE_HEADERS, zoneOf } from '../public/routes.ts';
import { isTokenShape, openPublicAsset, supportContacts } from '../public/service.ts';
import { readOrgTimeZone } from '../scan/repo-org-clock.ts';
import { bundleItems } from './public-items.ts';
import { registerMemberPage } from './public-member.ts';
import {
  addablePass,
  assertBundleMember,
  assertBundleMembers,
  bundleArchive,
  bundleForToken,
  bundleMembers,
  bundlePass,
  fenceBundleStream,
  recordBundleEvents,
} from './public-service.ts';
import { bundleSwRoutes } from './routes-sw.ts';
import { bundleWalletLocation, bundleWalletProviders } from './wallet-links.ts';

/** /b: bearer-link bundle page, its .pkpasses and per-pass files. No sign-in. */
export const bundlePublicRoutes = createRouter();
// Registered first, so the /:token limits below never see /sw.js.
bundlePublicRoutes.route('/', bundleSwRoutes);
// Valid assets are limited per token and network prefix; a prefix's misses are counted and, past
// a threshold, refused before any lookup.
bundlePublicRoutes.use('/:token/:passId/assets/*', gateMisses(ASSET_MISSES_PER_MINUTE));
bundlePublicRoutes.use(
  '/:token/:passId/assets/*',
  rateLimit('RL_PUBLIC_ASSET', (c) => assetBucket(c, isTokenShape)),
);
bundlePublicRoutes.use('/:token', rateLimit('RL_PUBLIC'));
bundlePublicRoutes.use('/:token/passes.pkpasses', rateLimit('RL_PUBLIC'));
// The member page's limit; the archive path matches this pattern too and has its own, so skip it.
const memberLimit = rateLimit('RL_PUBLIC');
bundlePublicRoutes.use('/:token/:passId', (c, next) =>
  c.req.param('passId') === 'passes.pkpasses' ? next() : memberLimit(c, next),
);
bundlePublicRoutes.use('/:token/:passId/pass.pkpass', rateLimit('RL_PUBLIC'));
bundlePublicRoutes.use('/:token/:passId/barcode', rateLimit('RL_PUBLIC'));
bundlePublicRoutes.use('/:token/:passId/wallet/:provider', rateLimit('RL_PUBLIC'));

register(
  bundlePublicRoutes,
  'public',
  {
    method: 'get',
    path: '/{token}',
    summary: 'Bundle page (server-rendered HTML)',
    params: PublicBundleParamSchema,
  },
  async (c) => {
    const ctx = svc(c);
    const nonce = c.var.nonce;
    const theme = requestTheme(c);
    try {
      const { token } = c.req.valid('param');
      const bundle = await bundleForToken(ctx, token);
      const members = await bundleMembers(ctx, bundle);
      const lang = langOf(c.req.header('accept-language'));
      const zone = zoneOf(c) ?? (await readOrgTimeZone(ctx.env.DB, bundle.org_id));
      const now = new Date(ctx.clock.now());
      const wallets = await Promise.all(
        members.map(({ pass }) => bundleWalletProviders(ctx, pass)),
      );
      const items = bundleItems(token, members, wallets, { lang, now, zone });
      const org = members[0]?.model.orgName ?? '';
      const html = renderBundlePage({
        nonce,
        theme,
        orgName: items[0]?.view.organizationName || org,
        orgLabel: org,
        brand: await orgBrandOf(ctx, bundle.org_id),
        name: bundle.name,
        mode: bundle.mode,
        items,
        addAllHref: `/b/${token}/passes.pkpasses`,
        publicUrl: `${baseUrl(c.env)}/b/${token}`,
        device: passDevice(c.req.header('user-agent')),
        support: await supportContacts(ctx, bundle.org_id),
      });
      await assertBundleMembers(
        ctx,
        bundle,
        members.map((member) => member.pass),
      );
      ctx.waitUntil(
        recordBundleEvents(
          ctx,
          bundle,
          'bundle.opened',
          members.map((m) => m.pass.id),
        ),
      );
      return new Response(html, { headers: PAGE_HEADERS });
    } catch (error) {
      if (error instanceof AppError && error.status === 404)
        return new Response(renderNotFoundPage(nonce, theme, { what: 'bundle' }), {
          status: 404,
          headers: PAGE_HEADERS,
        });
      throw error;
    }
  },
);

register(
  bundlePublicRoutes,
  'public',
  {
    method: 'get',
    path: '/{token}/passes.pkpasses',
    summary: 'Every addable pass of the bundle as one .pkpasses',
    params: PublicBundleParamSchema,
  },
  async (c) => {
    const ctx = svc(c);
    const bundle = await bundleForToken(ctx, c.req.valid('param').token);
    const archive = await bundleArchive(ctx, bundle);
    try {
      await recordBundleEvents(ctx, bundle, 'bundle.downloaded', archive.passIds);
      await assertBundleMembers(ctx, bundle, archive.passes);
      for (const pass of archive.passes) await recordCopy(ctx, pass, 'apple');
    } catch (error) {
      await archive.body.cancel();
      throw error;
    }
    return new Response(archive.body, {
      headers: {
        'content-type': PKPASSES_CONTENT_TYPE,
        'content-disposition': 'attachment; filename="passes.pkpasses"',
        'cache-control': 'private, no-store',
        'x-content-type-options': 'nosniff',
      },
    });
  },
);

register(
  bundlePublicRoutes,
  'public',
  {
    method: 'get',
    path: '/{token}/{passId}/pass.pkpass',
    summary: 'One pass of the bundle',
    params: PublicBundlePassParamSchema,
  },
  async (c) => {
    const ctx = svc(c);
    const p = c.req.valid('param');
    const bundle = await bundleForToken(ctx, p.token);
    const pass = await addablePass(ctx, bundle, p.passId);
    await appleFileGate(ctx, pass);
    const response = await serveCurrentPassFile(ctx, pass, c.req.raw);
    try {
      await assertBundleMember(ctx, bundle, pass);
      if (response.status === 200) {
        await recordBundleEvents(ctx, bundle, 'bundle.downloaded', [pass.id]);
        await recordCopy(ctx, pass, 'apple');
      }
      await assertBundleMember(ctx, bundle, pass);
    } catch (error) {
      await response.body?.cancel();
      throw error;
    }
    return response.body
      ? new Response(fenceBundleStream(ctx, bundle, [pass], response.body, false), response)
      : response;
  },
);

register(
  bundlePublicRoutes,
  'public',
  {
    method: 'get',
    path: '/{token}/{passId}/wallet/{provider}',
    summary: 'Add one pass of the bundle to a native wallet',
    params: PublicBundlePassParamSchema.extend({ provider: z.enum(['google', 'samsung']) }),
    status: 302,
  },
  async (c) => {
    const p = c.req.valid('param');
    const bundle = await bundleForToken(svc(c), p.token);
    const location = await bundleWalletLocation(svc(c), bundle, p.passId, p.provider);
    return new Response(null, {
      status: 302,
      headers: {
        'cache-control': 'private, no-store',
        'referrer-policy': 'no-referrer',
        'x-robots-tag': 'noindex, nofollow',
        location,
      },
    });
  },
);

register(
  bundlePublicRoutes,
  'public',
  {
    method: 'get',
    path: '/{token}/{passId}/barcode',
    summary: 'Present one pass barcode of the bundle',
    params: PublicBundlePassParamSchema,
  },
  async (c) => {
    const ctx = svc(c);
    const theme = requestTheme(c);
    try {
      const p = c.req.valid('param');
      const bundle = await bundleForToken(ctx, p.token);
      const pass = await addablePass(ctx, bundle, p.passId);
      const model = await presentationForPass(ctx, pass);
      const html = renderPresentationPage({
        ...model,
        backHref: `/b/${p.token}/${pass.id}`,
        offline: true,
        doorScript: BUNDLE_DOOR_SCRIPT,
        nonce: c.var.nonce,
        theme,
      });
      await assertBundleMember(ctx, bundle, pass);
      ctx.waitUntil(recordCopy(ctx, pass, 'mobile'));
      return new Response(html, { headers: presentationHeaders(model.expiresAt) });
    } catch (error) {
      if (error instanceof AppError && error.status === 404) {
        return new Response(
          renderNotFoundPage(c.var.nonce, theme, { what: 'bundle', replay: false }),
          {
            status: 404,
            headers: PRESENTATION_HEADERS,
          },
        );
      }
      throw error;
    }
  },
);

register(
  bundlePublicRoutes,
  'public',
  {
    method: 'get',
    path: '/{token}/{passId}/assets/{name}',
    summary: 'Pass image',
    params: PublicBundleAssetParamSchema,
  },
  async (c) => {
    const p = c.req.valid('param');
    const ctx = svc(c);
    const bundle = await bundleForToken(ctx, p.token);
    const pass = await bundlePass(ctx, bundle, p.passId);
    const asset = await openPublicAsset(ctx, pass, p.name);
    try {
      await assertBundleMember(ctx, bundle, pass);
    } catch (error) {
      await asset.body.cancel();
      throw error;
    }
    const headers = {
      'content-type': 'image/png',
      etag: asset.etag,
      // Member photos are personal and a revoked link must stop serving them, as on /p/*/assets.
      'cache-control': 'private, no-store',
      'x-content-type-options': 'nosniff',
      ...(EMAILED.test(p.name) ? { 'cross-origin-resource-policy': 'cross-origin' } : {}),
    };
    if (c.req.header('if-none-match') === asset.etag) {
      await asset.body.cancel();
      return new Response(null, { status: 304, headers });
    }
    return new Response(fenceBundleStream(ctx, bundle, [pass], asset.body, false), { headers });
  },
);

registerMemberPage(bundlePublicRoutes);
