import { Hono } from 'hono';
import { MARKETING_PATHS, SITEMAP_PATHS } from '../../../shared/marketing.ts';
import type { AppBindings } from '../../platform/context.ts';
import { accessSentPage, homePage, marketingPage } from './pages.ts';

/** The public site's pages (GET and HEAD), the sitemap, and the one-URL-per-page redirects. */
export const marketingPageRoutes = new Hono<AppBindings>();

marketingPageRoutes.get(MARKETING_PATHS.home, homePage);
marketingPageRoutes.get(MARKETING_PATHS.door, (c) => marketingPage(c, MARKETING_PATHS.door));
marketingPageRoutes.get(MARKETING_PATHS.blueprints, (c) =>
  marketingPage(c, MARKETING_PATHS.blueprints),
);
marketingPageRoutes.get(MARKETING_PATHS.build, (c) => marketingPage(c, MARKETING_PATHS.build));
marketingPageRoutes.get(MARKETING_PATHS.access, (c) => marketingPage(c, MARKETING_PATHS.access));
marketingPageRoutes.get(MARKETING_PATHS.accessSent, accessSentPage);

// A trailing slash is the page without it.
for (const path of [
  MARKETING_PATHS.door,
  MARKETING_PATHS.blueprints,
  MARKETING_PATHS.build,
  MARKETING_PATHS.access,
  MARKETING_PATHS.accessSent,
]) {
  marketingPageRoutes.get(`${path}/`, (c) =>
    c.redirect(`${path}${new URL(c.req.url).search}`, 308),
  );
}

marketingPageRoutes.get('/sitemap.xml', (c) => {
  const base = c.env.PUBLIC_BASE_URL.replace(/\/$/, '');
  const urls = SITEMAP_PATHS.map(
    (path) => `  <url><loc>${base}${path === MARKETING_PATHS.home ? '/' : path}</loc></url>`,
  ).join('\n');
  const body = `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls}\n</urlset>\n`;
  return new Response(c.req.method === 'HEAD' ? null : body, {
    headers: {
      'content-type': 'application/xml; charset=utf-8',
      'cache-control': 'public, max-age=300',
    },
  });
});
