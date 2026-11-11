import type { Mode } from '../../../shared/contracts/common.ts';
import { sha256Hex } from '../../platform/ids.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { requireCredentialRefKeyset } from '../passes/credential-keyset.ts';
import {
  readSamsungTombstoneVerification,
  snapshotWalletCredentialContext,
} from './account-service.ts';
import { runtimeAccountUnavailable, WalletRuntimeError } from './runtime-core.ts';
import {
  SamsungCredentialError,
  SamsungReplayStoreError,
  SamsungTokenError,
  validateSamsungCallbackCredentials,
  verifySamsungTombstoneRequest,
} from './samsung.ts';
import type { ValidatedSamsungCallbackCredentials } from './samsung-credentials.ts';

/** Scope from an immutable tombstone, not from the callback request itself. */
interface SamsungTombstoneRuntimeScope {
  orgId: string;
  mode: Mode;
  accountId: string;
  accountRevision: number;
  credentialKeysetCommitment: string;
  refHash: string;
}

interface SamsungTombstoneRuntimeRequest {
  request: Request;
  refId: string;
  /** Atomically claim replay protection and the matching tombstone in the same database fence. */
  claimReplay: (
    key: string,
    expiresAt: number,
    signedAt: number,
    queryBound: boolean,
  ) => Promise<boolean>;
}

/**
 * Historic public verification only: never signs, renders card data, or enables a revoked account.
 * The retained tombstone selects the originally approved immutable credential, even after rotation.
 */
export async function verifySamsungTombstoneRuntimeRequest(
  ctx: ServiceContext,
  inputScope: SamsungTombstoneRuntimeScope,
  input: SamsungTombstoneRuntimeRequest,
): Promise<void> {
  ctx = snapshotWalletCredentialContext(ctx);
  let scope: SamsungTombstoneRuntimeScope;
  let request: Request;
  let refId: string;
  let claimReplay: SamsungTombstoneRuntimeRequest['claimReplay'];
  if (
    typeof inputScope?.credentialKeysetCommitment !== 'string' ||
    !/^[0-9a-f]{64}$/.test(inputScope.credentialKeysetCommitment)
  )
    throw runtimeAccountUnavailable();
  try {
    const { orgId, mode, accountId, accountRevision, refHash, credentialKeysetCommitment } =
      inputScope;
    ({ request, refId, claimReplay } = input);
    if (
      typeof orgId !== 'string' ||
      !orgId.trim() ||
      (mode !== 'live' && mode !== 'test') ||
      typeof accountId !== 'string' ||
      !accountId.trim() ||
      !Number.isSafeInteger(accountRevision) ||
      accountRevision < 1 ||
      typeof refHash !== 'string' ||
      !/^[0-9a-f]{64}$/.test(refHash) ||
      typeof refId !== 'string' ||
      !/^[A-Za-z0-9_-]{32}$/.test(refId) ||
      (await sha256Hex(refId)) !== refHash
    )
      throw new SamsungTokenError();
    scope = { orgId, mode, accountId, accountRevision, refHash, credentialKeysetCommitment };
  } catch {
    throw new SamsungTokenError();
  }

  async function assertKeyset(): Promise<void> {
    try {
      if (
        (await requireCredentialRefKeyset(ctx.env.DB, ctx.env)) !== scope.credentialKeysetCommitment
      )
        throw runtimeAccountUnavailable();
    } catch {
      throw runtimeAccountUnavailable();
    }
  }

  async function readHistorical() {
    try {
      const value = await readSamsungTombstoneVerification(ctx, scope);
      if (
        !value ||
        value.accountId !== scope.accountId ||
        value.accountRevision !== scope.accountRevision
      )
        throw runtimeAccountUnavailable();
      return value;
    } catch {
      throw runtimeAccountUnavailable();
    }
  }

  const original = await readHistorical();
  let account: ValidatedSamsungCallbackCredentials;
  try {
    account = await validateSamsungCallbackCredentials(original, ctx.clock.now());
    await assertKeyset();
  } catch (error) {
    await assertKeyset();
    if (error instanceof SamsungCredentialError) throw new SamsungTokenError();
    throw new WalletRuntimeError('provider_failure');
  }
  try {
    await verifySamsungTombstoneRequest(account, {
      request,
      refId,
      method: 'GET',
      now: ctx.clock.now(),
      claimReplay: async (key, expiresAt, signedAt, queryBound) => {
        await assertKeyset();
        const claimed = await claimReplay(key, expiresAt, signedAt, queryBound);
        await assertKeyset();
        return claimed;
      },
    });
  } catch (error) {
    await assertKeyset();
    if (error instanceof SamsungTokenError) throw new SamsungTokenError();
    if (error instanceof SamsungReplayStoreError) throw new SamsungReplayStoreError();
    throw new WalletRuntimeError('provider_failure');
  }
  const current = await readHistorical();
  if (
    current.partnerId !== original.partnerId ||
    current.certificateId !== original.certificateId ||
    current.cardId !== original.cardId ||
    current.samsungCertificatePem !== original.samsungCertificatePem
  )
    throw runtimeAccountUnavailable();
}
