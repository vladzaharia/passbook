import { credentialAad, encryptSecret, loadKekRing } from '../../platform/crypto.ts';
import { BadRequestError, UnauthenticatedError, UnavailableError } from '../../platform/errors.ts';
import { sha256Hex } from '../../platform/ids.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { requireCredentialRefKeyset } from '../passes/credential-keyset.ts';
import { canPresent } from '../public/presentation.ts';
import { readSamsungCallbackBody } from './callbacks-body.ts';
import {
  filterSamsungCardFields,
  samsungCountryHint,
  samsungRequestedFields,
} from './callbacks-fields.ts';
import { pinSamsungCredentialContext, requireSamsungCredentialKeyset } from './callbacks-ref.ts';
import { authenticateSamsungTombstone } from './callbacks-tombstone.ts';
import { offerPassSnapshot } from './offers-eligibility.ts';
import { getApprovedProjection } from './projection-service.ts';
import { walletProviderDisabledReason } from './provider-policy.ts';
import { renderSamsungProjection } from './render-projection.ts';
import { findSamsungFetchSnapshot, samsungFetchSnapshotCurrent } from './repo-callbacks.ts';
import { claimSamsungFetch, claimSamsungReceipt } from './repo-callbacks-events.ts';
import {
  samsungRuntimeCardDataResponse,
  type VerifiedSamsungRuntimeRequest,
  verifySamsungRuntimeRequest,
  WalletRuntimeError,
} from './runtime.ts';
import { SamsungReplayStoreError, SamsungTokenError } from './samsung.ts';

export type SamsungCallbackResult =
  | { kind: 'card'; cdata: string }
  | { kind: 'accepted' }
  | { kind: 'missing' };

/** Only the exact configured partner endpoint is admitted, with no path normalization aliases. */
export async function handleSamsungCallback(
  ctx: ServiceContext,
  request: Request,
): Promise<SamsungCallbackResult> {
  ctx = pinSamsungCredentialContext(ctx);
  const url = new URL(request.url);
  const match = /^\/wallet\/v1\/samsung\/cards\/([A-Za-z0-9_-]{1,32})\/([A-Za-z0-9_-]{32})$/.exec(
    url.pathname,
  );
  if (!match || (request.method !== 'GET' && request.method !== 'POST'))
    throw new BadRequestError();
  const refId = match[2];
  if (!refId) throw new BadRequestError();
  const method = request.method;
  // Credentials cannot be opened while disabled, so nothing can be verified or promoted: the
  // answer is constant, carries no state and records nothing.
  const disabled = walletProviderDisabledReason('samsung');
  if (disabled) {
    ctx.log.info('wallet.callback_ignored', {
      code: 'WALLET_PROVIDER_DISABLED',
      provider: 'samsung',
      reason: disabled,
    });
    return method === 'GET' ? { kind: 'missing' } : { kind: 'accepted' };
  }
  const fields = method === 'GET' ? samsungRequestedFields(url) : null;
  const countryHint = method === 'POST' ? samsungCountryHint(url) : null;
  const body = method === 'POST' ? await readSamsungCallbackBody(request) : null;
  const refHash = await sha256Hex(refId);
  const credentialKeysetCommitment = await requireCredentialRefKeyset(ctx.env.DB, ctx.env);
  const snapshot = await findSamsungFetchSnapshot(
    ctx.env.DB,
    refHash,
    ctx.clock.now(),
    credentialKeysetCommitment,
    true,
  );
  if (!snapshot) {
    if (
      method === 'GET' &&
      (await authenticateSamsungTombstone(ctx, request, refId, refHash, credentialKeysetCommitment))
    )
      return { kind: 'missing' };
    throw new UnauthenticatedError(
      'Samsung Wallet authorization is invalid.',
      'SAMSUNG_UNAUTHENTICATED',
    );
  }
  const approved = await getApprovedProjection(
    ctx,
    {
      orgId: snapshot.orgId,
      mode: snapshot.mode,
      provider: 'samsung',
      templateId: snapshot.templateId,
      templateVersion: snapshot.templateVersion,
      appleReleaseId: snapshot.issuingReleaseId,
    },
    { credentialKeysetCommitment: snapshot.credentialKeysetCommitment },
  );
  if (
    approved?.projection.provider !== 'samsung' ||
    approved.release.id !== snapshot.projectionReleaseId ||
    approved.release.accountId !== snapshot.accountId ||
    approved.release.accountRevision !== snapshot.accountRevision
  ) {
    throw new UnauthenticatedError(
      'Samsung Wallet authorization is invalid.',
      'SAMSUNG_UNAUTHENTICATED',
    );
  }
  const scope = {
    orgId: snapshot.orgId,
    mode: snapshot.mode,
    accountId: snapshot.accountId,
    accountRevision: snapshot.accountRevision,
    providerIdentityHash: approved.release.providerIdentityHash,
    providerReleaseId: snapshot.projectionReleaseId,
    credentialKeysetCommitment: snapshot.credentialKeysetCommitment,
  };
  const materialized = await offerPassSnapshot(
    ctx,
    snapshot.passId,
    snapshot.credentialKeysetCommitment,
  );
  if (
    !materialized ||
    materialized.credentialKeysetCommitment !== snapshot.credentialKeysetCommitment ||
    materialized.pass.orgId !== snapshot.orgId ||
    materialized.pass.mode !== snapshot.mode ||
    materialized.pass.version !== snapshot.passVersion ||
    materialized.pass.revision !== snapshot.passRevision ||
    materialized.pass.credentialGeneration !== snapshot.credentialGeneration ||
    materialized.pass.credentialGeneration !== snapshot.passCredentialGeneration ||
    materialized.pass.releaseId !== snapshot.issuingReleaseId ||
    materialized.pass.templateId !== snapshot.templateId ||
    materialized.pass.templateVersion !== snapshot.templateVersion
  ) {
    throw new UnauthenticatedError(
      'Samsung Wallet authorization is invalid.',
      'SAMSUNG_UNAUTHENTICATED',
    );
  }
  const projection =
    method === 'GET'
      ? renderSamsungProjection(
          approved.projection,
          materialized.passJson,
          refId,
          snapshot.instanceCreatedAt,
          ctx.clock.now(),
        )
      : null;
  if (method === 'GET' && !projection)
    throw new UnauthenticatedError(
      'Samsung Wallet authorization is invalid.',
      'SAMSUNG_UNAUTHENTICATED',
    );
  const receiptId = method === 'POST' ? ctx.ids.id() : null;
  const receiptEnvelope =
    receiptId && body
      ? await encryptSecret(
          await loadKekRing(ctx.env),
          body,
          credentialAad(
            receiptId,
            snapshot.orgId,
            `samsung-callback|${snapshot.mode}|${snapshot.instanceId}`,
          ),
        )
      : null;
  let verified: VerifiedSamsungRuntimeRequest;
  try {
    verified = await verifySamsungRuntimeRequest(ctx, scope, {
      request,
      refId,
      method,
      refresh: {
        instanceId: snapshot.instanceId,
        refHash,
        operationVersion: snapshot.operationVersion,
      },
      claimReplay: (tokenHash, expiresAt, signedAt) => {
        const claim = { tokenHash, expiresAt, claimId: ctx.ids.id(), now: ctx.clock.now() };
        if (!canPresent(materialized.pass, materialized.passJson, claim.now))
          return Promise.resolve(false);
        if (method === 'GET')
          return claimSamsungFetch(ctx.env.DB, snapshot, claim, materialized.rawPassJson);
        if (!receiptId || !receiptEnvelope) return Promise.resolve(false);
        return claimSamsungReceipt(
          ctx.env.DB,
          snapshot,
          claim,
          {
            id: receiptId,
            signedAt,
            envelope: receiptEnvelope,
            countryHint,
          },
          materialized.rawPassJson,
        );
      },
    });
  } catch (error) {
    if (error instanceof SamsungTokenError)
      throw new UnauthenticatedError(
        'Samsung Wallet authorization is invalid.',
        'SAMSUNG_UNAUTHENTICATED',
      );
    if (error instanceof SamsungReplayStoreError || error instanceof WalletRuntimeError)
      throw new UnavailableError('Samsung Wallet service is unavailable.', 'SAMSUNG_UNAVAILABLE');
    throw error;
  }
  await requireSamsungCredentialKeyset(ctx, snapshot.credentialKeysetCommitment);
  if (method === 'POST') {
    if (
      !(await samsungFetchSnapshotCurrent(
        ctx.env.DB,
        snapshot,
        materialized.rawPassJson,
        ctx.clock.now(),
      ))
    )
      return { kind: 'missing' };
    await requireSamsungCredentialKeyset(ctx, snapshot.credentialKeysetCommitment);
    return { kind: 'accepted' };
  }
  if (!projection) return { kind: 'missing' };
  const card = filterSamsungCardFields(projection, fields);
  let response: { cdata: string };
  try {
    response = await samsungRuntimeCardDataResponse(ctx, scope, verified, card);
  } catch (error) {
    if (error instanceof SamsungTokenError || error instanceof WalletRuntimeError)
      throw new UnavailableError('Samsung Wallet service is unavailable.', 'SAMSUNG_UNAVAILABLE');
    throw error;
  }
  if (
    !canPresent(materialized.pass, materialized.passJson, ctx.clock.now()) ||
    !(await samsungFetchSnapshotCurrent(
      ctx.env.DB,
      snapshot,
      materialized.rawPassJson,
      ctx.clock.now(),
    ))
  )
    return { kind: 'missing' };
  await requireSamsungCredentialKeyset(ctx, snapshot.credentialKeysetCommitment);
  return { kind: 'card', cdata: response.cdata };
}
