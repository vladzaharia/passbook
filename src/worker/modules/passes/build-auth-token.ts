import { revealToken, type SealRaw, unsealToken } from '../../platform/capability-token.ts';

/** The sealed copy of a pass's device token, read with the build's other reads. */
export interface PrefetchedAuthSeal {
  stored: string;
  row: SealRaw | null;
}

/**
 * The plain device token a build embeds in pass.json. `authToken` is the column value (a MAC once
 * sealed) or a token just made; a prefetched copy is used only while it still names that value.
 */
export function plainAuthToken(
  env: { DB: D1Database },
  req: {
    passId: string;
    orgId: string;
    authToken: string;
    prefetched?: { authSeal?: PrefetchedAuthSeal };
  },
): Promise<string> {
  const seal = req.prefetched?.authSeal;
  return seal && seal.stored === req.authToken
    ? unsealToken(env, 'apple-auth', req.passId, req.orgId, req.authToken, seal.row)
    : revealToken(env, 'apple-auth', req.passId, req.orgId, req.authToken);
}
