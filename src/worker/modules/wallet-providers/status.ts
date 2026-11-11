import {
  type WalletProviderPassStatus,
  WalletProviderPassStatusSchema,
} from '../../../shared/contracts/wallet-provider-status.ts';
import type {
  WalletProvider,
  WalletProviderIssuance,
} from '../../../shared/contracts/wallet-providers.ts';
import type { AuthContext } from '../../platform/auth.ts';
import { ForbiddenError, NotFoundError, UnavailableError } from '../../platform/errors.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import {
  captureCredentialKeyEnv,
  requireCredentialRefKeyset,
} from '../passes/credential-keyset.ts';
import { tenantAuthorityOf } from '../passes/http.ts';
import { tenantPassForRead } from '../passes/pass-access.ts';
import type { PassScope } from '../passes/scope.ts';
import { walletProviderIssuance } from './provider-policy.ts';
import { readWalletProviderStatus } from './repo-status.ts';

/** Authorize the actual pass, then fence both its incarnation and authority in the status read. */
export async function getWalletProviderPassStatus(
  ctx: ServiceContext,
  auth: AuthContext,
  passId: string,
  scope: PassScope,
): Promise<WalletProviderPassStatus> {
  const credentialKeyEnv = captureCredentialKeyEnv(ctx.env);
  try {
    const { pass } = await tenantPassForRead(ctx, auth, passId, scope);
    // Unlike a general pass detail read, provider status is confined to the selected mode.
    if (pass.mode !== scope.mode) throw new NotFoundError('Pass not found.', 'PASS_NOT_FOUND');
    const authority = await tenantAuthorityOf(ctx, auth, pass.orgId, 'passes:read');
    const credentialKeysetCommitment = await requireCredentialRefKeyset(
      ctx.env.DB,
      credentialKeyEnv,
    );
    const rows = await readWalletProviderStatus(
      ctx.env.DB,
      pass,
      authority,
      ctx.clock.now(),
      credentialKeysetCommitment,
    );
    if (rows === null)
      throw new UnavailableError(
        'Credential references are unavailable.',
        'CREDENTIAL_REF_KEYSET_UNAVAILABLE',
      );
    if (rows.length !== 2 || rows[0]?.provider !== 'google' || rows[1]?.provider !== 'samsung')
      throw new NotFoundError('Pass not found.', 'PASS_NOT_FOUND');
    return WalletProviderPassStatusSchema.parse({
      credentialGeneration: pass.credentialGeneration,
      providers: rows.map((row) => ({
        provider: row.provider,
        lifecycle: row.lifecycle ?? 'absent',
        desiredOperation:
          row.operationVersion === null
            ? null
            : {
                version: row.operationVersion,
                kind: row.operationKind,
                state: row.operationState,
                reason: row.operationReason,
              },
        priorGenerationRetirementPending: row.priorRetirementPending === 1,
        installation: 'unknown',
        issuance: walletProviderIssuance(row.provider),
      })),
    });
  } catch (error) {
    if (error instanceof ForbiddenError)
      throw new NotFoundError('Pass not found.', 'PASS_NOT_FOUND');
    throw error;
  }
}
