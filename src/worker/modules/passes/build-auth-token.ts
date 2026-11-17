import { revealToken, type SealRaw, unsealToken } from '../../platform/capability-token.ts';
import { AppError, ConflictError } from '../../platform/errors.ts';

/** The sealed copy of a pass's device token, read with the build's other reads. */
export interface PrefetchedAuthSeal {
  stored: string;
  row: SealRaw | null;
}

/**
 * The plain device token a build embeds in pass.json. `authToken` is the column value (a MAC once
 * sealed) or a token just made; a prefetched copy is used only while it still names that value.
 */
export async function plainAuthToken(
  env: { DB: D1Database },
  req: {
    passId: string;
    orgId: string;
    authToken: string;
    prefetched?: { authSeal?: PrefetchedAuthSeal };
  },
): Promise<string> {
  const seal = req.prefetched?.authSeal;
  try {
    return seal && seal.stored === req.authToken
      ? await unsealToken(env, 'apple-auth', req.passId, req.orgId, req.authToken, seal.row)
      : await revealToken(env, 'apple-auth', req.passId, req.orgId, req.authToken);
  } catch (error) {
    if (!(error instanceof AppError) || !error.code.startsWith('TOKEN_SEAL_')) throw error;
    // The copy belongs to another token: the row moved since the caller read it.
    if (error.code === 'TOKEN_SEAL_MISMATCH')
      throw new ConflictError('The pass changed. Reload and retry.', 'PASS_CONFLICT');
    throw new AppError(
      'DEVICE_TOKEN_UNAVAILABLE',
      500,
      'The pass cannot be built: its device token is unreadable. Issue it again.',
    );
  }
}
