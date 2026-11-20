import { PublicAssetParamSchema, PublicTokenParamSchema } from '../../../shared/contracts/index.ts';
import { createRouter, register } from '../../platform/openapi.ts';
import { rateLimit } from '../../platform/rate-limit.ts';
import { requestTheme } from '../../ssr/head.ts';
import { PREVIEW_HEADERS, renderPreviewGone, renderPreviewPage } from '../../ssr/preview-page.tsx';
import { checkPreviewLink } from '../developer/preview-link.ts';
import { svc } from '../passes/http.ts';
import { passOfPreview, previewAsset, previewFor } from './preview.ts';
import { langOf } from './routes.ts';
import { assertPassSnapshot, capturePassSnapshot } from './snapshot.ts';

/** /preview: the TEST preview of a sandbox pass, public by its signed link. No sign-in, no Add button. */
export const previewRoutes = createRouter();
previewRoutes.use('/:token', rateLimit('RL_PUBLIC'));
previewRoutes.use('/:token/assets/*', rateLimit('RL_PUBLIC'));

register(
  previewRoutes,
  'public',
  {
    method: 'get',
    path: '/{token}',
    summary: 'TEST preview page of a sandbox pass (server-rendered HTML)',
    params: PublicTokenParamSchema,
  },
  async (c) => {
    const ctx = svc(c);
    const theme = requestTheme(c);
    const result = await previewFor(
      ctx,
      c.req.valid('param').token,
      langOf(c.req.header('accept-language')),
    );
    if (result.state !== 'ok')
      return new Response(renderPreviewGone(c.var.nonce, result.state, theme), {
        status: result.state === 'expired' ? 410 : 404,
        headers: PREVIEW_HEADERS,
      });
    return new Response(renderPreviewPage({ ...result.page, nonce: c.var.nonce, theme }), {
      headers: PREVIEW_HEADERS,
    });
  },
);

register(
  previewRoutes,
  'public',
  {
    method: 'get',
    path: '/{token}/assets/{name}',
    summary: 'Pass image for the TEST preview page',
    params: PublicAssetParamSchema,
  },
  async (c) => {
    const p = c.req.valid('param');
    const ctx = svc(c);
    const checked = await checkPreviewLink(ctx.env, p.token, ctx.clock.now());
    if (checked.state !== 'ok')
      return new Response(null, { status: checked.state === 'expired' ? 410 : 404 });
    const pass = await passOfPreview(ctx, checked);
    if (!pass) return new Response(null, { status: 404 });
    const snapshot = await capturePassSnapshot(ctx, pass);
    const asset = await previewAsset(ctx, pass, p.name);
    try {
      await assertPassSnapshot(ctx, snapshot);
    } catch (error) {
      await asset.body.cancel();
      throw error;
    }
    return new Response(asset.body, {
      headers: {
        'content-type': 'image/png',
        etag: asset.etag,
        'cache-control': 'private, no-store',
        'x-content-type-options': 'nosniff',
      },
    });
  },
);
