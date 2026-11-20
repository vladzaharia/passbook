/** The developer portal's paths, shared by the generator, the Worker route and the tests. */
export const PATHS = {
  home: '/developers',
  quickstart: '/developers/quickstart',
  guides: '/developers/guides',
  playground: '/developers/playground',
  webhooks: '/developers/webhooks',
  reference: '/developers/reference',
  errors: '/developers/errors',
  protocols: '/developers/reference/protocols',
  changelog: '/developers/changelog',
  llms: '/developers/llms.txt',
  sitemap: '/developers/sitemap.xml',
  /** Every starter's sample, built at deploy: the anonymous playground's only data. */
  previews: '/developers/blueprint-previews.json',
  assets: '/developers/assets',
  openapi: '/api/v1/openapi.json',
} as const;

/**
 * The portal stays out of search until it is linked (W5). One switch: the pages' robots meta,
 * the Worker's X-Robots-Tag, robots.txt's Allow and the sitemap line all follow it.
 */
export const DEVELOPERS_INDEXABLE = false;

/** The markdown twin of a page: `/developers/reference/passes` -> `….md`; the home page is `index.md`. */
export const twin = (path: string) =>
  path === PATHS.home ? `${PATHS.home}/index.md` : `${path}.md`;
