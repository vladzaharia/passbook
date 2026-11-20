import { credentialAad, type Envelope, encryptSecret, loadKekRing } from '../../platform/crypto.ts';
import { UnavailableError } from '../../platform/errors.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { canPresent } from '../public/presentation.ts';
import { filterSamsungCardFields } from './callbacks-fields.ts';
import { requireSamsungCredentialKeyset } from './callbacks-ref.ts';
import type { SamsungCallbackInput, SamsungCallbackResult } from './callbacks-samsung-types.ts';
import { recordWalletHolderEvent } from './holder-events.ts';
import { offerPassSnapshot } from './offers-eligibility.ts';
import { getApprovedProjection } from './projection-service.ts';
import { renderSamsungProjection } from './render-projection.ts';
import { type SamsungFetchSnapshot, samsungFetchSnapshotCurrent } from './repo-callbacks.ts';
import { claimSamsungFetch, claimSamsungReceipt } from './repo-callbacks-events.ts';
import { samsungRefLive } from './repo-callbacks-live.ts';
import { samsungTokenRecorded } from './repo-callbacks-state.ts';
import {
  samsungRuntimeCardDataResponse,
  type VerifiedSamsungRuntimeRequest,
  verifySamsungRuntimeRequest,
  WalletRuntimeError,
} from './runtime.ts';
import { SamsungReplayStoreError, SamsungTokenError } from './samsung.ts';

/**
 * The live path: the ref's current operation, pass and approved projection all still hold. Null
 * means they do not, and the caller falls back to answering as an issued ref.
 */
export async function serveSamsungLive(
  ctx: ServiceContext,
  input: SamsungCallbackInput,
  snapshot: SamsungFetchSnapshot,
): Promise<SamsungCallbackResult | null> {
  const { request, refId, refHash, method, fields, countryHint, body, event, requestId } = input;
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
    return null;
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
    return null;
  }
  const projection =
    method === 'GET'
      ? renderSamsungProjection(
          approved.projection,
          materialized.passJson,
          refId,
          snapshot.instanceCreatedAt,
          materialized.pass.modifiedAt,
        )
      : null;
  if (method === 'GET' && !projection) return null;
  // The receipt id is minted now, but the body is sealed only once a token has verified.
  const receiptId = method === 'POST' ? ctx.ids.id() : null;
  let sealed: Envelope | null = null;
  const delivery = { duplicate: false };
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
      claimReplay: async (tokenHash, expiresAt, signedAt, queryBound) => {
        const claim = { tokenHash, expiresAt, claimId: ctx.ids.id(), now: ctx.clock.now() };
        if (method === 'GET') {
          if (!canPresent(materialized.pass, materialized.passJson, claim.now)) return false;
          return claimSamsungFetch(ctx.env.DB, snapshot, claim, materialized.rawPassJson);
        }
        if (!receiptId || !body) return false;
        sealed ??= await encryptSecret(
          await loadKekRing(ctx.env),
          body,
          credentialAad(
            receiptId,
            snapshot.orgId,
            `samsung-callback|${snapshot.mode}|${snapshot.instanceId}`,
          ),
        );
        const receipt = {
          id: receiptId,
          signedAt,
          envelope: sealed,
          countryHint,
          event,
          requestId,
          queryBound,
        };
        if (
          await claimSamsungReceipt(ctx.env.DB, snapshot, claim, receipt, materialized.rawPassJson)
        )
          return true;
        // A token already recorded for this ref is a redelivery, whatever its request id (Samsung
        // retries with fresh trace ids): answered like the first, changing nothing. Reuse of a
        // token that left no receipt is a replay.
        delivery.duplicate = await samsungTokenRecorded(
          ctx.env.DB,
          tokenHash,
          snapshot.referenceId,
        );
        return delivery.duplicate;
      },
    });
  } catch (error) {
    if (error instanceof SamsungTokenError) return null;
    if (error instanceof SamsungReplayStoreError || error instanceof WalletRuntimeError)
      throw new UnavailableError('Samsung Wallet service is unavailable.', 'SAMSUNG_UNAVAILABLE');
    throw error;
  }
  await requireSamsungCredentialKeyset(ctx, snapshot.credentialKeysetCommitment);
  if (method === 'POST') {
    // Send Card State documents only 200/401/500/503: a receipt that lost a race is still accepted.
    ctx.log.info('wallet.callback_state', {
      code: delivery.duplicate ? 'WALLET_CALLBACK_DUPLICATE' : 'WALLET_CALLBACK_RECORDED',
      provider: 'samsung',
      orgId: snapshot.orgId,
      event: event ?? 'unknown',
    });
    if (!delivery.duplicate && (event === 'ADDED' || event === 'DELETED')) {
      // A retired ref's holder is not this pass's holder: its callbacks are recorded, never shown.
      if (await samsungRefLive(ctx.env.DB, snapshot.referenceId))
        await recordWalletHolderEvent(ctx, {
          orgId: snapshot.orgId,
          passId: snapshot.passId,
          mode: snapshot.mode,
          provider: 'samsung',
          event: event === 'ADDED' ? 'saved' : 'removed',
        });
    }
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
