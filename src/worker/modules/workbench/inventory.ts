/**
 * Writes to state with no mode, which Live shows too: the org and its brand kit, settings, members,
 * identities, users, inbound connections and wallet accounts. No token writes them, a sandbox's included.
 */
export const SHARED_WRITES =
  /^(POST|PUT|PATCH|DELETE) \/api\/v1\/(orgs|brand|settings|identities|identity-runs|users|me|connections|wallet-providers|invitations|platform)(\/|$)/;

/**
 * Routes a member token must never reach, whatever `WORKBENCH_ROUTES` says (design §2.3, check 2). The
 * inventory test holds the allowlist to these. A Live release is refused at run time (`modes`), not here.
 */
export const WORKBENCH_NEVER: readonly (readonly [RegExp, string])[] = [
  [
    /^POST \/api\/v1\/templates\/:id\/(review|review-requests|candidates\/promote|releases\/rollback)$/,
    'review, promotion and rollback move Live',
  ],
  [
    /^(DELETE \/api\/v1\/templates\/:id|\w+ \/api\/v1\/templates\/:id\/(archive|restore|share|clone|channels.*))$/,
    'template delete, archive, assign and share',
  ],
  [SHARED_WRITES, 'org, brand, member, identity, plan, settings and inbound connection writes'],
  [
    /^\w+ \/api\/v1\/(workbench\/token|developer|cli)(\/|$)/,
    'a token never mints a token or a CLI token',
  ],
  [/^\w+ \/api\/v1\/platform(\/|$)/, 'platform administration'],
];
