import { credentialAad, encryptSecret, loadKekRing } from '../../platform/crypto.ts';
import {
  PayloadTooLargeError,
  UnauthenticatedError,
  UnavailableError,
} from '../../platform/errors.ts';
import { sha256Hex, toHex } from '../../platform/ids.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import {
  captureCredentialKeyEnv,
  requireCredentialRefKeyset,
} from '../passes/credential-keyset.ts';
import { readGoogleCallbackVerification } from './account-service.ts';
import {
  GoogleCallbackInvalid,
  readGoogleCallbackBody,
  verifyGoogleCallback,
} from './google-callback-crypto.ts';
import { googleObjectIds } from './google-ids.ts';
import { walletProviderDisabledReason } from './provider-policy.ts';
import {
  findGoogleCallbackAccount,
  findGoogleCallbackBinding,
  isGoogleCallbackReceiptCurrent,
  putGoogleCallbackReceipt,
} from './repo-google-callback.ts';

const rejected = () =>
  new UnauthenticatedError('Google Wallet callback is invalid.', 'GOOGLE_CALLBACK_INVALID');
const unavailable = () =>
  new UnavailableError(
    'Google Wallet callback service is unavailable.',
    'GOOGLE_CALLBACK_UNAVAILABLE',
  );

async function assertCallbackKeyset(
  ctx: ServiceContext,
  credentialKeyEnv: object,
  credentialKeysetCommitment: string,
): Promise<void> {
  if (
    (await requireCredentialRefKeyset(ctx.env.DB, credentialKeyEnv)) !==
      credentialKeysetCommitment ||
    (await requireCredentialRefKeyset(ctx.env.DB, ctx.env)) !== credentialKeysetCommitment
  )
    throw unavailable();
}

async function nonceHash(secret: Uint8Array, accountId: string, nonce: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    secret as BufferSource,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const input = new TextEncoder().encode(
    JSON.stringify(['google-wallet-callback-nonce-v1', accountId, nonce]),
  );
  return toHex(new Uint8Array(await crypto.subtle.sign('HMAC', key, input)));
}

/** Accept a signed, scoped callback without making any per-holder installation inference. */
export async function handleGoogleCallback(
  ctx: ServiceContext,
  request: Request,
  accountId: string,
): Promise<void> {
  let credentialKeysetCommitment: string | undefined;
  let credentialKeyEnv: Readonly<Record<string, string>> | undefined;
  try {
    credentialKeyEnv = captureCredentialKeyEnv(ctx.env);
    const pinnedCtx: ServiceContext = {
      ...ctx,
      env: Object.freeze({ ...ctx.env, ...credentialKeyEnv }),
    };
    const url = new URL(request.url);
    if (
      request.method !== 'POST' ||
      !/^[A-Za-z0-9_-]{1,128}$/.test(accountId) ||
      url.pathname !== `/wallet/v1/google/${accountId}`
    )
      throw rejected();
    // The size cap needs no stored state, so it applies even before the keyset is initialized.
    const raw = await readGoogleCallbackBody(request);
    credentialKeysetCommitment = await requireCredentialRefKeyset(ctx.env.DB, credentialKeyEnv);
    await assertCallbackKeyset(ctx, credentialKeyEnv, credentialKeysetCommitment);
    const scope = await findGoogleCallbackAccount(
      ctx.env.DB,
      accountId,
      credentialKeysetCommitment,
    );
    if (!scope) throw rejected();
    const account = await readGoogleCallbackVerification(pinnedCtx, scope);
    await assertCallbackKeyset(ctx, credentialKeyEnv, credentialKeysetCommitment);
    if (!account) throw rejected();
    const event = await verifyGoogleCallback(raw, account.issuerId, () => ctx.clock.now());
    // Verified, then acknowledged: a disabled provider records nothing and binds nothing.
    const disabled = walletProviderDisabledReason('google');
    if (disabled) {
      ctx.log.info('wallet.callback_ignored', {
        code: 'WALLET_PROVIDER_DISABLED',
        provider: 'google',
        reason: disabled,
      });
      return;
    }
    const [classIdHash, objectIdHash] = await Promise.all([
      sha256Hex(event.classId),
      sha256Hex(event.objectId),
    ]);
    const binding = await findGoogleCallbackBinding(ctx.env.DB, scope, classIdHash, objectIdHash);
    if (!binding) throw rejected();
    // Independently derive both IDs from the immutable initial release and instance generation.
    // A corrupt lookup row cannot attach an old callback to a different incarnation.
    const expected = await googleObjectIds(account.issuerId, account.objectIdHmacKey, {
      tenantId: binding.orgId,
      mode: binding.mode,
      releaseId: binding.releaseId,
      passId: binding.passId,
      credentialGeneration: binding.credentialGeneration,
    });
    if (event.classId !== expected.classId || event.objectId !== expected.objectId)
      throw rejected();
    const now = ctx.clock.now();
    if (event.validUntil <= now) throw rejected();
    await assertCallbackKeyset(ctx, credentialKeyEnv, credentialKeysetCommitment);
    const receiptId = ctx.ids.id();
    const envelope = await encryptSecret(
      await loadKekRing(credentialKeyEnv),
      raw,
      credentialAad(
        receiptId,
        binding.orgId,
        `google-callback|${binding.mode}|${binding.instanceId}`,
      ),
    );
    const hash = await nonceHash(account.objectIdHmacKey, accountId, event.nonce);
    const receipt = {
      id: receiptId,
      classIdHash,
      objectIdHash,
      nonceHash: hash,
      eventType: event.eventType,
      expiresAt: event.expiresAt,
      validUntil: event.validUntil,
      now: ctx.clock.now(),
      envelope,
    };
    if (!(await putGoogleCallbackReceipt(ctx.env.DB, binding, receipt))) {
      await assertCallbackKeyset(ctx, credentialKeyEnv, credentialKeysetCommitment);
      // A changed or legacy binding proof is unavailable rather than an invalid signature.
      await findGoogleCallbackBinding(ctx.env.DB, scope, classIdHash, objectIdHash);
      throw rejected();
    }
    await assertCallbackKeyset(ctx, credentialKeyEnv, credentialKeysetCommitment);
    if (
      !(await isGoogleCallbackReceiptCurrent(ctx.env.DB, binding, {
        ...receipt,
        now: ctx.clock.now(),
      }))
    ) {
      await assertCallbackKeyset(ctx, credentialKeyEnv, credentialKeysetCommitment);
      await findGoogleCallbackBinding(ctx.env.DB, scope, classIdHash, objectIdHash);
      throw rejected();
    }
  } catch (error) {
    if (error instanceof PayloadTooLargeError) throw error;
    if (error instanceof GoogleCallbackInvalid || error instanceof UnauthenticatedError) {
      if (credentialKeysetCommitment !== undefined && credentialKeyEnv !== undefined) {
        try {
          await assertCallbackKeyset(ctx, credentialKeyEnv, credentialKeysetCommitment);
        } catch {
          throw unavailable();
        }
      }
      throw rejected();
    }
    // Network/crypto/storage exceptions can carry provider material; replace them before they reach logging.
    // The provider keyset, credential store, or local crypto may be temporarily unavailable.
    ctx.log.warn('wallet.google_callback_unavailable', { code: 'GOOGLE_CALLBACK_UNAVAILABLE' });
    throw unavailable();
  }
}
