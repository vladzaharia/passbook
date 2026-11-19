import { PKPASSES_CONTENT_TYPE } from '../../../passkit/index.ts';
import {
  PublicBundleAssetParamSchema,
  PublicBundleParamSchema,
  PublicBundlePassParamSchema,
} from '../../../shared/contracts/bundles.ts';
import { passDevice } from '../../../shared/device.ts';
import { distinguishingLine, normalize } from '../../../shared/pass-view/index.ts';
import { stateWordOption } from '../../../shared/state-word.ts';
import { baseUrl } from '../../platform/env.ts';
import { AppError } from '../../platform/errors.ts';
import { ipRatePrefix } from '../../platform/ip.ts';
import { createRouter, register } from '../../platform/openapi.ts';
import {
  ASSET_MISSES_PER_MINUTE,
  clientIp,
  gateMisses,
  rateLimit,
} from '../../platform/rate-limit.ts';
import { renderBundlePage } from '../../ssr/bundle-page.tsx';
import { requestTheme } from '../../ssr/head.ts';
import { renderNotFoundPage } from '../../ssr/pass-page.tsx';
import { PRESENTATION_HEADERS, renderPresentationPage } from '../../ssr/presentation-page.tsx';
import { servePassFile } from '../passes/file.ts';
import { svc } from '../passes/http.ts';
import { presentationForPass } from '../public/presentation.ts';
import { EMAILED, langOf, PAGE_HEADERS, zoneOf } from '../public/routes.ts';
import { isTokenShape, openPublicAsset, supportContacts } from '../public/service.ts';
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

/** /b: bearer-link bundle page, its .pkpasses and per-pass files. No sign-in. */
export const bundlePublicRoutes = createRouter();
// Valid assets are limited per token and network prefix; a prefix's misses are counted and, past
// a threshold, refused before any lookup.
bundlePublicRoutes.use('/:token/:passId/assets/*', gateMisses(ASSET_MISSES_PER_MINUTE));
bundlePublicRoutes.use(
  '/:token/:passId/assets/*',
  rateLimit('RL_PUBLIC_ASSET', (c) => {
    const prefix = ipRatePrefix(clientIp(c)) ?? 'unknown';
    const token = c.req.param('token') ?? '';
    return isTokenShape(token) ? `${token}:${prefix}` : `prefix:${prefix}`;
  }),
);
bundlePublicRoutes.use('/:token', rateLimit('RL_PUBLIC'));
bundlePublicRoutes.use('/:token/passes.pkpasses', rateLimit('RL_PUBLIC'));
bundlePublicRoutes.use('/:token/:passId/pass.pkpass', rateLimit('RL_PUBLIC'));
bundlePublicRoutes.use('/:token/:passId/barcode', rateLimit('RL_PUBLIC'));

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
      const zone = zoneOf(c) ?? 'UTC';
      const now = new Date(ctx.clock.now());
      const items = members.map(({ pass, model }) => {
        const view = normalize(model.passJson, {
          assets: model.assets,
          locale: lang,
          now,
          timeZone: zone,
          ...stateWordOption(pass),
        });
        const title = pass.displayTitle ?? view.description ?? model.orgName;
        return {
          id: pass.id,
          view,
          title,
          detail: distinguishingLine(model.passJson, title),
          state:
            pass.removedAt !== null
              ? ('removed' as const)
              : pass.status === 'voided' || view.voided
                ? ('voided' as const)
                : ('active' as const),
          downloadHref: `/b/${token}/${pass.id}/pass.pkpass`,
          barcodeHref: `/b/${token}/${pass.id}/barcode`,
        };
      });
      const org = members[0]?.model.orgName ?? '';
      const html = renderBundlePage({
        nonce,
        theme,
        orgName: items[0]?.view.organizationName || org,
        orgLabel: org,
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
    const response = await servePassFile(c.env.BUCKET, pass, c.req.raw);
    try {
      await assertBundleMember(ctx, bundle, pass);
      if (response.status === 200)
        await recordBundleEvents(ctx, bundle, 'bundle.downloaded', [pass.id]);
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
        backHref: `/b/${p.token}`,
        nonce: c.var.nonce,
        theme,
      });
      await assertBundleMember(ctx, bundle, pass);
      return new Response(html, { headers: PRESENTATION_HEADERS });
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
