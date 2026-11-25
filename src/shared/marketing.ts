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
