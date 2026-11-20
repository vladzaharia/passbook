import type { Mode } from '../../../shared/contracts/common.ts';
import { sha256Hex } from '../../platform/ids.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import {
  readSamsungIssuedRefVerification,
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
  refHash: string;
}

interface SamsungTombstoneRuntimeRequest {
  request: Request;
  refId: string;
  /** Send Card State for a dead ref is authenticated and answered like Get Card Data. */
  method?: 'GET' | 'POST';
  /** `issued`: an unretired or untombstoned ref whose live fences no longer hold (callbacks-samsung-issued.ts). */
  source?: 'tombstone' | 'issued';
  /** Atomically claim replay protection and the matching tombstone in the same database fence. */
  claimReplay: (
    key: string,
    expiresAt: number,
    signedAt: number,
    queryBound: boolean,
    /** Issued source only: the verifying credential may write state, not just authenticate. */
    writable: boolean,
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
  let method: 'GET' | 'POST';
  let source: 'tombstone' | 'issued';
  let claimReplay: SamsungTombstoneRuntimeRequest['claimReplay'];
  try {
    const { orgId, mode, accountId, accountRevision, refHash } = inputScope;
    ({ request, refId, method = 'GET', source = 'tombstone', claimReplay } = input);
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
    scope = { orgId, mode, accountId, accountRevision, refHash };
  } catch {
    throw new SamsungTokenError();
  }

  async function readHistorical() {
    try {
      const value = await (source === 'issued'
        ? readSamsungIssuedRefVerification
        : readSamsungTombstoneVerification)(ctx, scope);
      if (
        !value ||
        value.accountId !== scope.accountId ||
        value.accountRevision !== scope.accountRevision
      )
        throw runtimeAccountUnavailable();
      // The pinned credential first, then its later versions (a certificate rotation).
      return [value, ...value.later];
    } catch {
      throw runtimeAccountUnavailable();
    }
  }

  const candidates = await readHistorical();
  let chosen = -1;
  for (const [index, candidate] of candidates.entries()) {
    let account: ValidatedSamsungCallbackCredentials;
    try {
      account = await validateSamsungCallbackCredentials(candidate, ctx.clock.now());
    } catch (error) {
      if (error instanceof SamsungCredentialError) continue;
      throw new WalletRuntimeError('provider_failure');
    }
    try {
      await verifySamsungTombstoneRequest(account, {
        request,
        refId,
        method,
        now: ctx.clock.now(),
        claimReplay: (key, expiresAt, signedAt, queryBound) =>
          claimReplay(
            key,
            expiresAt,
            signedAt,
            queryBound,
            'writable' in candidate && candidate.writable === true,
          ),
      });
      chosen = index;
      break;
    } catch (error) {
      if (error instanceof SamsungTokenError) continue;
      if (error instanceof SamsungReplayStoreError) throw new SamsungReplayStoreError();
      throw new WalletRuntimeError('provider_failure');
    }
  }
  const original = candidates[chosen];
  if (!original) throw new SamsungTokenError();
  const current = (await readHistorical())[chosen];
  if (
    !current ||
    current.partnerId !== original.partnerId ||
    current.certificateId !== original.certificateId ||
    current.cardId !== original.cardId ||
    current.samsungCertificatePem !== original.samsungCertificatePem
  )
    throw runtimeAccountUnavailable();
}
