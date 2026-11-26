/** The developer portal's paths, shared by the generator, the Worker route and the tests. */
export const PATHS = {
  home: '/developers',
  /** The Workbench's overview on the home page: its slot is `id="workbench"`. */
  workbench: '/developers#workbench',
  quickstart: '/developers/quickstart',
  guides: '/developers/guides',
  playground: '/developers/playground',
  console: '/developers/console',
  webhooks: '/developers/webhooks',
  logs: '/developers/logs',
  keys: '/developers/keys',
  status: '/developers/status',
  statusJson: '/developers/status.json',
  logsOps: '/developers/logs-ops.json',
  /** The ⌘K index: built with the pages, fetched on first open. */
  searchIndex: '/developers/search-index.json',
  /** Where the search reports a term that found nothing (the term only). */
  searchMiss: '/developers/search-miss',
  reference: '/developers/reference',
  errors: '/developers/errors',
  protocols: '/developers/reference/protocols',
  changelog: '/developers/changelog',
  changelogFeed: '/developers/changelog.atom',
  llms: '/developers/llms.txt',
  sitemap: '/developers/sitemap.xml',
  /** Every starter's sample, built at deploy: the anonymous playground's only data. */
  previews: '/developers/blueprint-previews.json',
  assets: '/developers/assets',
  openapi: '/api/v1/openapi.json',
} as const;

/** Pages the Workbench took over (design §4.2): the Worker answers 301 to the new path and keeps the query. */
export const MOVED: Readonly<Record<string, string>> = {
  [PATHS.console]: '/workbench/console',
  [PATHS.webhooks]: '/workbench/events',
  [PATHS.logs]: '/workbench/logs',
  [PATHS.keys]: '/workbench/keys',
  [PATHS.playground]: '/workbench/design',
  [PATHS.quickstart]: '/workbench/quickstart',
};

/**
 * The portal stays out of search until it is linked (W5). One switch: the pages' robots meta,
 * the Worker's X-Robots-Tag, robots.txt's Allow and the sitemap line all follow it.
 */
export const DEVELOPERS_INDEXABLE = false;

/** The portal's own 404 page, written by the build and served by the Worker with a 404 status (not a route). */
export const NOT_FOUND_FILE = '/developers/not-found.html';

/** The markdown twin of a page: `/developers/reference/passes` -> `….md`; the home page is `index.md`. */
export const twin = (path: string) =>
  path === PATHS.home ? `${PATHS.home}/index.md` : `${path}.md`;

/** An operation's own page: `/developers/reference/passes/create`, `…/passes/memberphoto-get`. */
export const opUrl = (slug: string, anchor: string) =>
  `${PATHS.reference}/${slug}/${anchor.toLowerCase()}`;
