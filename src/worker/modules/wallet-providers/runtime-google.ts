import type { GoogleType } from '../../../passkit/wallets/google/types.ts';
import { sha256Hex } from '../../platform/ids.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { snapshotWalletCredentialContext } from './account-service.ts';
import { upsertClassForRelease } from './google-class-release.ts';
import { googleObjectIds } from './google-ids.ts';
import { dropGoogleAccessToken, getGoogleAccessToken } from './google-oauth.ts';
import { createGoogleSaveOffer, type GoogleSaveOffer } from './google-offer.ts';
import type { GoogleGenericProjection } from './google-projection.ts';
import {
  type GoogleWalletRestContext,
  patchGoogleGenericClass,
  patchGoogleGenericObject,
  upsertGoogleGenericClass,
  upsertGoogleGenericObject,
} from './google-rest.ts';
import {
  patchGoogleObjectBody,
  revokeGoogleObject,
  upsertGoogleClass,
  upsertGoogleObject,
} from './google-rest-typed.ts';
import type { GoogleClassWrite } from './repo-google-class.ts';
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

/** A typed class partition. Absent `type` is the original Generic path (schema 1 releases). */
interface GoogleRuntimePartition {
  type?: GoogleType;
  /** `googleClassKeyDigest` of the pass's `google.classKey`; absent means `default`. */
  classKey?: string;
}

interface GoogleRuntimeClassInput extends GoogleRuntimePartition {
  releaseId: string;
  /** The approved release compiling this body; a typed class is rewritten only for a newer one. */
  writer?: GoogleClassWrite;
  projection: GoogleGenericProjection;
  /** Persist every raw provider response encrypted before resolving. */
  onProviderResponse: WalletRuntimeResponseSink;
  /** Recheck the caller's claim, pass and approved projection before each provider request. */
  assertCurrent?: () => Promise<void>;
}

interface GoogleRuntimeObjectInput extends GoogleRuntimeClassInput {
  passId: string;
  credentialGeneration: number;
  channelEpoch: number;
}

export interface GoogleRuntimeObjectIdentity extends GoogleRuntimePartition {
  releaseId: string;
  passId: string;
  credentialGeneration: number;
  channelEpoch: number;
  assertCurrent?: () => Promise<void>;
}

interface GoogleRuntimeInactivateInput extends GoogleRuntimeObjectIdentity {
  /** The hash of the class the instance was issued under (its callback binding); the revoke keeps to it. */
  classIdHash?: string;
  onProviderResponse: WalletRuntimeResponseSink;
  retirement: WalletRetirementClaim;
}

interface GoogleRuntimeOfferInput extends GoogleRuntimeObjectIdentity {
  origins: readonly string[];
  lifetimeSeconds?: number;
}

const ISSUANCE = { kind: 'issuance' } as const;

/** The one message a revoked object carries (architecture 6.1, Void). */
const REVOKED_MESSAGE = 'This pass is no longer valid.';

const partition = ({ type, classKey }: GoogleRuntimePartition): GoogleRuntimePartition => ({
  ...(type === undefined ? {} : { type }),
  ...(classKey === undefined ? {} : { classKey }),
});

/** The object's identity under a verified scope; a partition makes it a typed class's object. */
export const objectScope = (s: WalletRuntimeScope, i: GoogleRuntimeObjectIdentity) => ({
  tenantId: s.orgId,
  mode: s.mode,
  releaseId: i.releaseId,
  passId: i.passId,
  credentialGeneration: i.credentialGeneration,
  channelEpoch: i.channelEpoch,
  ...partition(i),
});

/** Hashes provider IDs without exposing the stable HMAC key or the raw identifiers. */
export async function googleRuntimeIdHashes(
  ctx: ServiceContext,
  inputScope: WalletRuntimeScope,
  input: GoogleRuntimeObjectIdentity,
): Promise<{ classIdHash: string; objectIdHash: string }> {
  ctx = snapshotWalletCredentialContext(ctx);
  const scope = copyRuntimeScope(inputScope);
  const { account, hmacKey } = await runtimeGoogleAccount(ctx, scope, ISSUANCE);
  const call = runtimeExecution(ctx, scope, 'google', input.assertCurrent, undefined, ISSUANCE);
  return call.finish(async () => {
    if (input.assertCurrent) await input.assertCurrent();
    const ids = await googleObjectIds(account.issuerId, hmacKey, objectScope(scope, input));
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
  const { account, hmacKey } = await runtimeGoogleAccount(ctx, scope, ISSUANCE);
  const call = runtimeExecution(ctx, scope, 'google', input.assertCurrent, undefined, ISSUANCE);
  return call.finish(async () => {
    if (input.assertCurrent) await input.assertCurrent();
    return createGoogleSaveOffer(account, hmacKey, objectScope(scope, input), {
      origins: input.origins,
      issuedAt: Math.floor(ctx.clock.now() / 1000),
      lifetimeSeconds: input.lifetimeSeconds,
      ...(input.type === undefined ? {} : { type: input.type }),
    });
  });
}

export async function withGoogleRest<T>(
  ctx: ServiceContext,
  inputScope: WalletRuntimeScope,
  assertCurrent: (() => Promise<void>) | undefined,
  stage: WalletRuntimeResponseStage,
  onProviderResponse: WalletRuntimeResponseSink | null,
  operation: (rest: GoogleWalletRestContext, scope: WalletRuntimeScope) => Promise<T>,
  retirement?: RuntimeRetirementPurpose,
): Promise<T> {
  ctx = snapshotWalletCredentialContext(ctx);
  if (onProviderResponse !== null && typeof onProviderResponse !== 'function')
    throw new WalletRuntimeError('provider_failure');
  const scope = copyRuntimeScope(inputScope);
  const purpose = retirement ?? ISSUANCE;
  const { account, hmacKey, credentialVersionId } = await runtimeGoogleAccount(ctx, scope, purpose);
  const call = runtimeExecution(
    ctx,
    scope,
    'google',
    assertCurrent,
    onProviderResponse ? { stage, sink: onProviderResponse } : undefined,
    purpose,
  );
  return call.finish(async () => {
    const token = await getGoogleAccessToken(account, {
      issuedAt: Math.floor(ctx.clock.now() / 1000),
      fetcher: call.fetcher,
      cacheKey: {
        accountId: scope.accountId,
        revision: scope.accountRevision,
        credentialVersionId,
      },
    });
    return operation(
      {
        account,
        objectIdHmacKey: hmacKey,
        accessToken: token.accessToken,
        fetcher: call.fetcher,
        now: () => ctx.clock.now(),
        tokenCached: token.cached === true,
        onUnauthorized: () => dropGoogleAccessToken(scope.accountId),
      },
      scope,
    );
  });
}

export async function upsertGoogleRuntimeClass(
  ctx: ServiceContext,
  scope: WalletRuntimeScope,
  input: GoogleRuntimeClassInput,
): Promise<'ok' | 'drift'> {
  ctx = snapshotWalletCredentialContext(ctx);
  return withGoogleRest(
    ctx,
    scope,
    input.assertCurrent,
    'google-class',
    input.onProviderResponse,
    async (rest, s) => {
      if (input.type === undefined) {
        await upsertGoogleGenericClass(
          rest,
          { tenantId: s.orgId, releaseId: input.releaseId },
          input.projection,
        );
        return 'ok';
      }
      const scope = { tenantId: s.orgId, releaseId: input.releaseId, ...partition(input) };
      if (!input.writer) {
        const { result } = await upsertGoogleClass(rest, input.type, scope, input.projection);
        return result === 'drift' ? 'drift' : 'ok';
      }
      const result = await upsertClassForRelease(
        rest,
        ctx.env.DB,
        ctx.clock.now(),
        input.type,
        scope,
        input.projection,
        input.writer,
      );
      return result === 'drift' ? 'drift' : 'ok';
    },
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
      input.type === undefined
        ? upsertGoogleGenericObject(rest, objectScope(s, input), input.projection)
        : upsertGoogleObject(rest, input.type, objectScope(s, input), input.projection),
  );
}

/** The one runtime entry that PATCHes an existing object; change messages (GM2) send through it. */
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
      input.type === undefined
        ? patchGoogleGenericObject(rest, objectScope(s, input), input.projection)
        : patchGoogleObjectBody(rest, input.type, objectScope(s, input), input.projection),
  );
}

export async function inactivateGoogleRuntimeObject(
  ctx: ServiceContext,
  scope: WalletRuntimeScope,
  input: GoogleRuntimeInactivateInput,
): Promise<'inactive' | 'absent'> {
  ctx = snapshotWalletCredentialContext(ctx);
  scope = copyRuntimeScope(scope);
  const {
    releaseId,
    passId,
    credentialGeneration,
    channelEpoch,
    retirement: claim,
    assertCurrent,
    onProviderResponse,
  } = input;
  const retirement = await runtimeRetirementPurpose(claim, {
    provider: 'google',
    passId,
    identityProjectionReleaseId: releaseId,
    credentialGeneration,
    channelEpoch,
  });
  return withGoogleRest(
    ctx,
    scope,
    assertCurrent,
    'google-object',
    onProviderResponse,
    (rest, s) =>
      revokeGoogleObject(
        rest,
        input.type ?? 'generic',
        objectScope(s, input),
        { id: claim.operationId, header: 'Pass status', body: REVOKED_MESSAGE },
        input.classIdHash,
      ),
    retirement,
  );
}
