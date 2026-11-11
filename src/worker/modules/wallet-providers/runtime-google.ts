import { sha256Hex } from '../../platform/ids.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { snapshotWalletCredentialContext } from './account-service.ts';
import { googleObjectIds } from './google-ids.ts';
import { getGoogleAccessToken } from './google-oauth.ts';
import { createGoogleSaveOffer, type GoogleSaveOffer } from './google-offer.ts';
import type { GoogleGenericProjection } from './google-projection.ts';
import {
  type GoogleWalletRestContext,
  inactivateGoogleGenericObject,
  patchGoogleGenericClass,
  patchGoogleGenericObject,
  upsertGoogleGenericClass,
  upsertGoogleGenericObject,
} from './google-rest.ts';
import {
  copyRuntimeScope,
  type RuntimeRetirementPurpose,
  runtimeExecution,
  runtimeGoogleAccount,
  runtimeRetirementPurpose,
  type WalletRetirementClaim,
  WalletRuntimeError,
  type WalletRuntimeScope,
} from './runtime-core.ts';
import type { WalletRuntimeResponseSink, WalletRuntimeResponseStage } from './runtime-response.ts';

interface GoogleRuntimeClassInput {
  releaseId: string;
  projection: GoogleGenericProjection;
  /** Persist every raw provider response encrypted before resolving. */
  onProviderResponse: WalletRuntimeResponseSink;
  /** Recheck the caller's claim, pass and approved projection before each provider request. */
  assertCurrent?: () => Promise<void>;
}

interface GoogleRuntimeObjectInput extends GoogleRuntimeClassInput {
  passId: string;
  credentialGeneration: number;
}

interface GoogleRuntimeObjectIdentity {
  releaseId: string;
  passId: string;
  credentialGeneration: number;
  assertCurrent?: () => Promise<void>;
}

interface GoogleRuntimeInactivateInput extends GoogleRuntimeObjectIdentity {
  onProviderResponse: WalletRuntimeResponseSink;
  retirement: WalletRetirementClaim;
}

interface GoogleRuntimeOfferInput extends GoogleRuntimeObjectIdentity {
  origins: readonly string[];
  lifetimeSeconds?: number;
}

/** Hashes provider IDs without exposing the stable HMAC key or the raw identifiers. */
export async function googleRuntimeIdHashes(
  ctx: ServiceContext,
  inputScope: WalletRuntimeScope,
  input: GoogleRuntimeObjectIdentity,
): Promise<{ classIdHash: string; objectIdHash: string }> {
  ctx = snapshotWalletCredentialContext(ctx);
  const scope = copyRuntimeScope(inputScope);
  const { account, hmacKey } = await runtimeGoogleAccount(ctx, scope);
  const call = runtimeExecution(ctx, scope, 'google', input.assertCurrent);
  return call.finish(async () => {
    if (input.assertCurrent) await input.assertCurrent();
    const ids = await googleObjectIds(account.issuerId, hmacKey, {
      tenantId: scope.orgId,
      mode: scope.mode,
      releaseId: input.releaseId,
      passId: input.passId,
      credentialGeneration: input.credentialGeneration,
    });
    const [classIdHash, objectIdHash] = await Promise.all([
      sha256Hex(ids.classId),
      sha256Hex(ids.objectId),
    ]);
    return { classIdHash, objectIdHash };
  });
}

/** Google offers reference an existing object; the caller must fence successful pre-provisioning. */
export async function createGoogleRuntimeOffer(
  ctx: ServiceContext,
  inputScope: WalletRuntimeScope,
  input: GoogleRuntimeOfferInput,
): Promise<GoogleSaveOffer> {
  ctx = snapshotWalletCredentialContext(ctx);
  const scope = copyRuntimeScope(inputScope);
  const { account, hmacKey } = await runtimeGoogleAccount(ctx, scope);
  const call = runtimeExecution(ctx, scope, 'google', input.assertCurrent);
  return call.finish(async () => {
    if (input.assertCurrent) await input.assertCurrent();
    return createGoogleSaveOffer(
      account,
      hmacKey,
      {
        tenantId: scope.orgId,
        mode: scope.mode,
        releaseId: input.releaseId,
        passId: input.passId,
        credentialGeneration: input.credentialGeneration,
      },
      {
        origins: input.origins,
        issuedAt: Math.floor(ctx.clock.now() / 1000),
        lifetimeSeconds: input.lifetimeSeconds,
      },
    );
  });
}

async function withGoogleRest<T>(
  ctx: ServiceContext,
  inputScope: WalletRuntimeScope,
  assertCurrent: (() => Promise<void>) | undefined,
  stage: WalletRuntimeResponseStage,
  onProviderResponse: WalletRuntimeResponseSink,
  operation: (rest: GoogleWalletRestContext, scope: WalletRuntimeScope) => Promise<T>,
  retirement?: RuntimeRetirementPurpose,
): Promise<T> {
  ctx = snapshotWalletCredentialContext(ctx);
  if (typeof onProviderResponse !== 'function') throw new WalletRuntimeError('provider_failure');
  const scope = copyRuntimeScope(inputScope);
  const { account, hmacKey } = await runtimeGoogleAccount(ctx, scope, retirement);
  const call = runtimeExecution(
    ctx,
    scope,
    'google',
    assertCurrent,
    { stage, sink: onProviderResponse },
    retirement,
  );
  return call.finish(async () => {
    const token = await getGoogleAccessToken(account, {
      issuedAt: Math.floor(ctx.clock.now() / 1000),
      fetcher: call.fetcher,
    });
    return operation(
      { account, objectIdHmacKey: hmacKey, accessToken: token.accessToken, fetcher: call.fetcher },
      scope,
    );
  });
}

export async function upsertGoogleRuntimeClass(
  ctx: ServiceContext,
  scope: WalletRuntimeScope,
  input: GoogleRuntimeClassInput,
): Promise<void> {
  ctx = snapshotWalletCredentialContext(ctx);
  await withGoogleRest(
    ctx,
    scope,
    input.assertCurrent,
    'google-class',
    input.onProviderResponse,
    (rest, s) =>
      upsertGoogleGenericClass(
        rest,
        { tenantId: s.orgId, releaseId: input.releaseId },
        input.projection,
      ),
  );
}

export async function patchGoogleRuntimeClass(
  ctx: ServiceContext,
  scope: WalletRuntimeScope,
  input: GoogleRuntimeClassInput,
): Promise<void> {
  ctx = snapshotWalletCredentialContext(ctx);
  await withGoogleRest(
    ctx,
    scope,
    input.assertCurrent,
    'google-class',
    input.onProviderResponse,
    (rest, s) =>
      patchGoogleGenericClass(
        rest,
        { tenantId: s.orgId, releaseId: input.releaseId },
        input.projection,
      ),
  );
}

export async function upsertGoogleRuntimeObject(
  ctx: ServiceContext,
  scope: WalletRuntimeScope,
  input: GoogleRuntimeObjectInput,
): Promise<void> {
  ctx = snapshotWalletCredentialContext(ctx);
  await withGoogleRest(
    ctx,
    scope,
    input.assertCurrent,
    'google-object',
    input.onProviderResponse,
    (rest, s) =>
      upsertGoogleGenericObject(
        rest,
        {
          tenantId: s.orgId,
          mode: s.mode,
          releaseId: input.releaseId,
          passId: input.passId,
          credentialGeneration: input.credentialGeneration,
        },
        input.projection,
      ),
  );
}

export async function patchGoogleRuntimeObject(
  ctx: ServiceContext,
  scope: WalletRuntimeScope,
  input: GoogleRuntimeObjectInput,
): Promise<void> {
  ctx = snapshotWalletCredentialContext(ctx);
  await withGoogleRest(
    ctx,
    scope,
    input.assertCurrent,
    'google-object',
    input.onProviderResponse,
    (rest, s) =>
      patchGoogleGenericObject(
        rest,
        {
          tenantId: s.orgId,
          mode: s.mode,
          releaseId: input.releaseId,
          passId: input.passId,
          credentialGeneration: input.credentialGeneration,
        },
        input.projection,
      ),
  );
}

export async function inactivateGoogleRuntimeObject(
  ctx: ServiceContext,
  scope: WalletRuntimeScope,
  input: GoogleRuntimeInactivateInput,
): Promise<void> {
  ctx = snapshotWalletCredentialContext(ctx);
  scope = copyRuntimeScope(scope);
  const {
    releaseId,
    passId,
    credentialGeneration,
    retirement: claim,
    assertCurrent,
    onProviderResponse,
  } = input;
  const retirement = await runtimeRetirementPurpose(claim, {
    provider: 'google',
    passId,
    identityProjectionReleaseId: releaseId,
    credentialGeneration,
  });
  await withGoogleRest(
    ctx,
    scope,
    assertCurrent,
    'google-object',
    onProviderResponse,
    (rest, s) =>
      inactivateGoogleGenericObject(rest, {
        tenantId: s.orgId,
        mode: s.mode,
        releaseId,
        passId,
        credentialGeneration,
      }),
    retirement,
  );
}
