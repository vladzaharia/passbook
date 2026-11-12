import type { ServiceContext } from '../../platform/service-context.ts';
import { snapshotWalletCredentialContext } from './account-service.ts';
import { GoogleWalletError } from './google-errors.ts';
import { walletClaimHash } from './instance-claims.ts';
import {
  assertRuntimeCredentialKeyset,
  copyRuntimeScope,
  runtimeCredentialCurrent as current,
  type Provider,
  type RetirementTarget,
  type RuntimeCredentialPurpose,
  type RuntimeRetirementPurpose,
  runtimeAccountUnavailable,
  runtimeGoogleAccount,
  runtimeSamsungAccount,
  type WalletRetirementClaim,
  WalletRuntimeError,
  type WalletRuntimeScope,
} from './runtime-core-credentials.ts';
import {
  captureRuntimeResponse,
  type WalletRuntimeResponseSink,
  type WalletRuntimeResponseStage,
} from './runtime-response.ts';
import { SamsungNotificationError, SamsungReplayStoreError, SamsungTokenError } from './samsung.ts';

/** Every outbound provider request is bounded; a timeout is an ambiguous provider failure. */
const PROVIDER_FETCH_TIMEOUT_MS = 15_000;

export type {
  RuntimeRefreshPurpose,
  RuntimeRetirementPurpose,
  SamsungRuntimeRefresh,
  WalletRetirementClaim,
  WalletRuntimeScope,
} from './runtime-core-credentials.ts';
export {
  copyRuntimeScope,
  runtimeAccountUnavailable,
  runtimeGoogleAccount,
  runtimeSamsungAccount,
  WalletRuntimeError,
};

/** A raw handle never leaves the runtime; its hash is checked against the claimed revoke. */
export async function runtimeRetirementPurpose(
  claim: WalletRetirementClaim,
  target: RetirementTarget,
): Promise<RuntimeRetirementPurpose> {
  try {
    const { instanceId, operationId, version, claimHandle } = claim;
    if (
      typeof instanceId !== 'string' ||
      !instanceId.trim() ||
      typeof operationId !== 'string' ||
      !operationId.trim() ||
      !Number.isSafeInteger(version) ||
      version < 1 ||
      typeof claimHandle !== 'string' ||
      !/^[A-Za-z0-9_-]{43}$/.test(claimHandle)
    ) {
      throw runtimeAccountUnavailable();
    }
    return {
      kind: 'retirement',
      instanceId,
      operationId,
      version,
      claimHash: await walletClaimHash(claimHandle),
      target,
    };
  } catch {
    throw runtimeAccountUnavailable();
  }
}

function safeProviderError(error: unknown, ambiguous: boolean): Error {
  // Reconstruct errors rather than forwarding arbitrary properties or provider response bodies.
  if (error instanceof GoogleWalletError)
    return new GoogleWalletError(error.code, 'runtime', error.status);
  if (error instanceof SamsungNotificationError) {
    return new SamsungNotificationError({
      kind: error.kind,
      status: error.status,
      retryable: error.retryable,
      ambiguous: error.ambiguous,
      retryAfterMs: error.retryAfterMs,
    });
  }
  if (error instanceof SamsungTokenError) return new SamsungTokenError();
  if (error instanceof SamsungReplayStoreError) return new SamsungReplayStoreError();
  return new WalletRuntimeError('provider_failure', ambiguous);
}

interface Execution {
  fetcher: typeof fetch;
  finish<T>(operation: () => Promise<T>): Promise<T>;
}

export function runtimeExecution(
  ctx: ServiceContext,
  scope: WalletRuntimeScope,
  provider: Provider,
  assertCurrent?: () => Promise<void>,
  capture?: { stage: WalletRuntimeResponseStage; sink: WalletRuntimeResponseSink },
  purpose?: RuntimeCredentialPurpose,
): Execution {
  ctx = snapshotWalletCredentialContext(ctx);
  scope = copyRuntimeScope(scope);
  let sent = false;
  let captureFailed = false;
  // Fence every request, including OAuth and each GET/POST/PATCH in an upsert. There is no
  // exported transport injection: the bearer stays inside this server-only boundary.
  const fetcher: typeof fetch = async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    const method = (
      init?.method ?? (input instanceof Request ? input.method : 'GET')
    ).toUpperCase();
    const oauth =
      provider === 'google' &&
      url.href === 'https://oauth2.googleapis.com/token' &&
      method === 'POST';
    if (capture && !oauth) {
      const validGoogle =
        provider === 'google' &&
        url.origin === 'https://walletobjects.googleapis.com' &&
        ((capture.stage === 'google-class' &&
          /^\/walletobjects\/v1\/genericClass(?:\/[^/]+)?$/.test(url.pathname)) ||
          (capture.stage === 'google-object' &&
            /^\/walletobjects\/v1\/genericObject(?:\/[^/]+)?$/.test(url.pathname)));
      const validSamsung =
        provider === 'samsung' &&
        capture.stage === 'samsung-update' &&
        url.origin === 'https://tsapi-card.walletsvc.samsung.com' &&
        /^\/[A-Za-z]{2}\/wltex\/cards\/[^/]+\/updates$/.test(url.pathname);
      if (
        (!validGoogle && !validSamsung) ||
        url.search ||
        url.hash ||
        (method !== 'GET' && method !== 'POST' && method !== 'PATCH') ||
        typeof capture.sink !== 'function'
      )
        throw new WalletRuntimeError('provider_failure');
    }
    await current(ctx, scope, provider, purpose);
    if (assertCurrent) {
      await assertCurrent();
      await current(ctx, scope, provider, purpose);
    }
    sent = true;
    const signal = init?.signal
      ? AbortSignal.any([init.signal, AbortSignal.timeout(PROVIDER_FETCH_TIMEOUT_MS)])
      : AbortSignal.timeout(PROVIDER_FETCH_TIMEOUT_MS);
    const response = await globalThis.fetch(input, { ...init, signal });
    await assertRuntimeCredentialKeyset(ctx, scope);
    if (!capture || oauth) return response;
    try {
      return await captureRuntimeResponse(
        response,
        capture.stage,
        method as 'GET' | 'POST' | 'PATCH',
        async (value) => {
          await assertRuntimeCredentialKeyset(ctx, scope);
          await capture.sink(value);
          await assertRuntimeCredentialKeyset(ctx, scope);
        },
      );
    } catch {
      captureFailed = true;
      throw new WalletRuntimeError('provider_failure', true);
    }
  };
  return {
    fetcher,
    async finish<T>(operation: () => Promise<T>): Promise<T> {
      try {
        await current(ctx, scope, provider, purpose);
        const result = await operation();
        await current(ctx, scope, provider, purpose);
        if (assertCurrent) {
          await assertCurrent();
          await current(ctx, scope, provider, purpose);
        }
        return result;
      } catch (error) {
        try {
          await current(ctx, scope, provider, purpose);
        } catch {
          throw runtimeAccountUnavailable(sent);
        }
        if (captureFailed) throw new WalletRuntimeError('provider_failure', true);
        throw safeProviderError(error, sent);
      }
    },
  };
}

/** New issuance remains unavailable without provider-verifiable eligibility and replay guarantees. */
export async function assertWalletRuntimeAccount(
  ctx: ServiceContext,
  input: WalletRuntimeScope,
  provider: Provider,
): Promise<void> {
  ctx = snapshotWalletCredentialContext(ctx);
  const scope = copyRuntimeScope(input);
  if (provider !== 'google' && provider !== 'samsung') throw runtimeAccountUnavailable();
  if (provider === 'google') await runtimeGoogleAccount(ctx, scope);
  else await runtimeSamsungAccount(ctx, scope);
  await current(ctx, scope, provider);
}
