/** The public site's addresses and the one Trusted Types policy its pages make. */
export const MARKETING_PATHS = {
  home: '/',
  door: '/door',
  blueprints: '/blueprints',
  build: '/build',
  access: '/access',
  accessSent: '/access/sent',
} as const;

/** The policy src/web/marketing/trusted-html.ts creates; the marketing CSP admits only this name. */
export const MARKETING_POLICY = 'passbook-marketing';

/**
 * The built pages the Worker serves, by address. Vite writes marketing/<name>.html; the asset layer
 * answers the extensionless path (the home page's `index` as the folder).
 */
export const MARKETING_ASSETS = {
  [MARKETING_PATHS.home]: '/marketing/',
  [MARKETING_PATHS.door]: '/marketing/door',
  [MARKETING_PATHS.blueprints]: '/marketing/blueprints',
  [MARKETING_PATHS.build]: '/marketing/build',
  [MARKETING_PATHS.access]: '/marketing/access',
} as const;

/** The addresses a sitemap lists. */
export const SITEMAP_PATHS = [
  MARKETING_PATHS.home,
  MARKETING_PATHS.door,
  MARKETING_PATHS.blueprints,
  MARKETING_PATHS.build,
  MARKETING_PATHS.access,
] as const;
