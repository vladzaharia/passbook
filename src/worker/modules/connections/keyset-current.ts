import { AppError } from '../../platform/errors.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { requireCredentialRefKeyset } from '../passes/credential-keyset.ts';

/** Later workflow steps may verify, but never adopt, a different keyset. */
export async function syncKeysetCurrent(
  sctx: ServiceContext,
  expected: string | undefined,
): Promise<boolean> {
  if (typeof expected !== 'string' || !/^[0-9a-f]{64}$/.test(expected)) return false;
  try {
    return (await requireCredentialRefKeyset(sctx.env.DB, sctx.env)) === expected;
  } catch (error) {
    if (error instanceof AppError && error.code === 'CREDENTIAL_REF_KEYSET_UNAVAILABLE')
      return false;
    throw error;
  }
}
