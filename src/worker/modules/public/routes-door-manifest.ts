import { createRouter } from '../../platform/openapi.ts';
import { rateLimit } from '../../platform/rate-limit.ts';
import { svc } from '../passes/http.ts';
import { presentationForPass } from './presentation.ts';
import { isTokenShape, passForToken } from './service.ts';

/**
 * /p/:token/barcode/manifest.webmanifest: lets the door view alone be installed from the home
 * screen. Scope and start_url are that one page, so the installed app can open nothing else. It is
 * a bearer URL like the page itself and carries only the org's name and the pass's own icon.
 */
export const doorManifestRoutes = createRouter();
doorManifestRoutes.use('/:token/barcode/manifest.webmanifest', rateLimit('RL_PUBLIC'));
doorManifestRoutes.get('/:token/barcode/manifest.webmanifest', async (c) => {
  const token = c.req.param('token');
  if (!isTokenShape(token)) return c.text('Not found', 404);
  const ctx = svc(c);
  const pass = await passForToken(ctx, token);
  // The page's own gate: a pass that cannot show its code has no door to install.
  const model = await presentationForPass(ctx, pass);
  const door = `/p/${token}/barcode`;
  const name = model.orgName || 'Pass';
  return new Response(
    JSON.stringify({
      name,
      short_name: name.slice(0, 12),
      id: door,
      start_url: door,
      scope: door,
      display: 'standalone',
      background_color: '#ffffff',
      theme_color: '#ffffff',
      icons: [
        {
          src: `/p/${token}/assets/icon@3x.png`,
          sizes: '87x87',
          type: 'image/png',
          purpose: 'any',
        },
      ],
    }),
    {
      headers: {
        'content-type': 'application/manifest+json; charset=utf-8',
        'cache-control': 'private, no-store',
        'x-content-type-options': 'nosniff',
        'x-robots-tag': 'noindex, nofollow',
      },
    },
  );
});
