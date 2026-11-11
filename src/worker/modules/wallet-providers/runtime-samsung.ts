import { sha256Hex } from '../../platform/ids.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { snapshotWalletCredentialContext } from './account-service.ts';
import {
  copyRuntimeScope,
  type RuntimeRefreshPurpose,
  runtimeAccountUnavailable,
  runtimeExecution,
  runtimeRetirementPurpose,
  runtimeSamsungAccount,
  type SamsungRuntimeRefresh,
  type WalletRetirementClaim,
  WalletRuntimeError,
  type WalletRuntimeScope,
} from './runtime-core.ts';
import type { WalletRuntimeResponseSink } from './runtime-response.ts';
import {
  buildSamsungDataFetchLink,
  type SamsungCardProjection,
  type SamsungUpdateInput,
  samsungCardDataResponse,
  sendSamsungUpdate,
  type ValidatedSamsungCredentials,
  type VerifiedSamsungRequest,
  verifySamsungRequest,
} from './samsung.ts';

interface SamsungRuntimeOfferInput {
  refId: string;
  /** Recheck the caller's approved projection and pass before generating the link. */
  assertCurrent?: () => Promise<void>;
}

/** refId is a bearer capability; the caller must protect the returned link. */
export async function createSamsungRuntimeOffer(
  ctx: ServiceContext,
  inputScope: WalletRuntimeScope,
  input: SamsungRuntimeOfferInput,
): Promise<string> {
  ctx = snapshotWalletCredentialContext(ctx);
  const scope = copyRuntimeScope(inputScope);
  const account = await runtimeSamsungAccount(ctx, scope);
  const call = runtimeExecution(ctx, scope, 'samsung', input.assertCurrent);
  return call.finish(async () => {
    if (input.assertCurrent) await input.assertCurrent();
    return buildSamsungDataFetchLink(account, input.refId, ctx.clock.now());
  });
}

type SamsungRuntimeUpdateInput = Omit<SamsungUpdateInput, 'now'> & {
  /** Recheck the caller's claim, pass and approved projection before each provider request. */
  assertCurrent?: () => Promise<void>;
  /** Persist every raw provider response encrypted before resolving. */
  onProviderResponse: WalletRuntimeResponseSink;
  /** Required only for DELETED and bound to the claimed revoke and exact reference. */
  retirement?: WalletRetirementClaim;
};

/** Per-card update only; cancellation of an entire event has a different authority boundary. */
export async function sendSamsungRuntimeUpdate(
  ctx: ServiceContext,
  inputScope: WalletRuntimeScope,
  input: SamsungRuntimeUpdateInput,
): Promise<void> {
  ctx = snapshotWalletCredentialContext(ctx);
  const scope = copyRuntimeScope(inputScope);
  if (typeof input.onProviderResponse !== 'function')
    throw new WalletRuntimeError('provider_failure');
  const { assertCurrent, onProviderResponse, retirement: inputClaim, ...update } = input;
  const claim = inputClaim ? { ...inputClaim } : undefined;
  if ((update.state === 'DELETED') !== (claim !== undefined)) throw runtimeAccountUnavailable();
  if (typeof update.refId !== 'string' || !/^[A-Za-z0-9_-]{32}$/.test(update.refId))
    throw runtimeAccountUnavailable();
  const retirement = claim
    ? await runtimeRetirementPurpose(claim, {
        provider: 'samsung',
        refHash: await sha256Hex(update.refId),
      })
    : undefined;
  const account = await runtimeSamsungAccount(ctx, scope, retirement);
  const call = runtimeExecution(
    ctx,
    scope,
    'samsung',
    assertCurrent,
    {
      stage: 'samsung-update',
      sink: onProviderResponse,
    },
    retirement,
  );
  await call.finish(() =>
    sendSamsungUpdate(account, { ...update, now: ctx.clock.now() }, call.fetcher),
  );
}

declare const samsungRequestBrand: unique symbol;

/** An in-process, scope-bound verification capability; it contains no authorization token. */
export interface VerifiedSamsungRuntimeRequest {
  readonly [samsungRequestBrand]: true;
  readonly method: 'GET' | 'POST';
  readonly refId: string;
  readonly requestId: string;
  readonly signedAt: number;
  readonly queryBound: boolean;
}

const verifiedSamsungRequests = new WeakMap<
  VerifiedSamsungRuntimeRequest,
  {
    scope: WalletRuntimeScope;
    request: VerifiedSamsungRequest;
    account: ValidatedSamsungCredentials;
    refresh: RuntimeRefreshPurpose;
  }
>();

interface SamsungRuntimeRequestInput {
  request: Request;
  refId: string;
  method: 'GET' | 'POST';
  /** Trusted lookup of an already promoted provider reference and current operation. */
  refresh: SamsungRuntimeRefresh;
  /** Must atomically reserve the replay key across Workers and fail closed on storage errors. */
  claimReplay: (
    key: string,
    expiresAt: number,
    signedAt: number,
    queryBound: boolean,
  ) => Promise<boolean>;
}

export async function verifySamsungRuntimeRequest(
  ctx: ServiceContext,
  inputScope: WalletRuntimeScope,
  input: SamsungRuntimeRequestInput,
): Promise<VerifiedSamsungRuntimeRequest> {
  ctx = snapshotWalletCredentialContext(ctx);
  const scope = copyRuntimeScope(inputScope);
  const { request: inbound, refId, method, claimReplay } = input;
  const refresh = input.refresh ? { ...input.refresh } : input.refresh;
  if (
    !refresh ||
    typeof refresh.instanceId !== 'string' ||
    !refresh.instanceId.trim() ||
    typeof refresh.refHash !== 'string' ||
    !/^[0-9a-f]{64}$/.test(refresh.refHash) ||
    !Number.isSafeInteger(refresh.operationVersion) ||
    refresh.operationVersion < 1 ||
    typeof refId !== 'string' ||
    !/^[A-Za-z0-9_-]{32}$/.test(refId) ||
    (await sha256Hex(refId)) !== refresh.refHash
  )
    throw runtimeAccountUnavailable();
  const purpose: RuntimeRefreshPurpose = {
    kind: 'refresh',
    instanceId: refresh.instanceId,
    refHash: refresh.refHash,
    operationVersion: refresh.operationVersion,
  };
  const account = await runtimeSamsungAccount(ctx, scope, purpose);
  const call = runtimeExecution(ctx, scope, 'samsung', undefined, undefined, purpose);
  const request = await call.finish(() =>
    verifySamsungRequest(account, {
      request: inbound,
      refId,
      method,
      claimReplay,
      now: ctx.clock.now(),
    }),
  );
  const handle = Object.freeze({
    method: request.method,
    refId: request.refId,
    requestId: request.requestId,
    signedAt: request.signedAt,
    queryBound: request.queryBound,
  }) as VerifiedSamsungRuntimeRequest;
  verifiedSamsungRequests.set(handle, { scope, request, account, refresh: purpose });
  return handle;
}

/** A verified GET handle is single-use and cannot be forged or transferred across scopes. */
export async function samsungRuntimeCardDataResponse(
  ctx: ServiceContext,
  inputScope: WalletRuntimeScope,
  handle: VerifiedSamsungRuntimeRequest,
  projection: SamsungCardProjection,
): Promise<{ cdata: string }> {
  ctx = snapshotWalletCredentialContext(ctx);
  const scope = copyRuntimeScope(inputScope);
  const proof = verifiedSamsungRequests.get(handle);
  if (!proof) throw new WalletRuntimeError('provider_failure');
  verifiedSamsungRequests.delete(handle);
  if (
    proof.scope.orgId !== scope.orgId ||
    proof.scope.mode !== scope.mode ||
    proof.scope.accountId !== scope.accountId ||
    proof.scope.accountRevision !== scope.accountRevision ||
    proof.scope.credentialKeysetCommitment !== scope.credentialKeysetCommitment ||
    proof.scope.providerIdentityHash !== scope.providerIdentityHash ||
    proof.scope.providerReleaseId !== scope.providerReleaseId
  )
    throw runtimeAccountUnavailable();
  // The adapter binds its verified request to the exact validated account object. Revalidate the
  // current account, but use that original object only after confirming its pinned revision.
  await runtimeSamsungAccount(ctx, scope, proof.refresh);
  const call = runtimeExecution(ctx, scope, 'samsung', undefined, undefined, proof.refresh);
  return call.finish(() =>
    samsungCardDataResponse(proof.account, proof.request, projection, ctx.clock.now()),
  );
}
