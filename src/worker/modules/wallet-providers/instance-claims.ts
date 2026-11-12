import { credentialAad, type Envelope, encryptSecret, loadKekRing } from '../../platform/crypto.ts';
import { randomBytes, sha256Hex, toBase64Url } from '../../platform/ids.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { requireCredentialRefKeyset } from '../passes/credential-keyset.ts';
import { snapshotWalletCredentialContext } from './account-service.ts';
import type {
  WalletClaimRef,
  WalletClaimResult,
  WalletCredentialKeysetProof,
  WalletOperationRef,
  WalletOperationState,
  WalletProviderResult,
  WalletReasonCode,
} from './instance-types.ts';
import { isCredentialKeysetCommitment as validCommitment } from './instance-types.ts';
import { getOperation } from './repo-instance.ts';
import {
  claimOperation,
  expireClaims,
  finishOperation,
  markUncertain,
  operationFresh,
  settleClaim,
} from './repo-instance-claims.ts';
import { insertOutcome, type OutcomeReceipt } from './repo-instance-outcomes.ts';

const reasons: Record<WalletReasonCode, true> = {
  ok: true,
  not_issued: true,
  rate_limited: true,
  unavailable: true,
  timeout: true,
  unauthorized: true,
  rejected: true,
  invalid_response: true,
  provider_error: true,
};
const validHandle = (value: string) => /^[A-Za-z0-9_-]{43}$/.test(value);
const validTime = (value: number) => Number.isSafeInteger(value) && value >= 0;
const validStatus = (status: number | undefined) =>
  status === undefined || (Number.isInteger(status) && status >= 100 && status <= 599);
export const walletClaimHash = (handle: string) => sha256Hex(`wallet-claim-v1\0${handle}`);

/** A lost handle cannot be recovered; after expiry the claim stays uncertain until settled. */
export function newWalletClaimHandle(): string {
  return toBase64Url(randomBytes(32));
}
export async function claimWalletOperation(
  db: D1Database,
  p: WalletClaimRef,
): Promise<WalletClaimResult> {
  if (
    !validCommitment(p.credentialKeysetCommitment) ||
    !validHandle(p.claimHandle) ||
    !validTime(p.now)
  )
    return 'not_claimable';
  return claimOperation(db, { ...p, hash: await walletClaimHash(p.claimHandle) });
}
export async function walletOperationFresh(
  db: D1Database,
  p: WalletOperationRef &
    WalletCredentialKeysetProof & {
      now: number;
      claimHandle?: string;
    },
): Promise<boolean> {
  if (
    !validCommitment(p.credentialKeysetCommitment) ||
    !validTime(p.now) ||
    (p.claimHandle !== undefined && !validHandle(p.claimHandle))
  )
    return false;
  return operationFresh(db, {
    ...p,
    hash: p.claimHandle === undefined ? undefined : await walletClaimHash(p.claimHandle),
  });
}
export async function markWalletClaimUncertain(
  db: D1Database,
  p: WalletClaimRef,
): Promise<boolean> {
  return validCommitment(p.credentialKeysetCommitment) &&
    validHandle(p.claimHandle) &&
    validTime(p.now)
    ? markUncertain(db, { ...p, hash: await walletClaimHash(p.claimHandle) })
    : false;
}
/** Only after independently confirming the old transport is no longer in flight. */
export async function settleWalletClaim(
  db: D1Database,
  p: WalletOperationRef & WalletCredentialKeysetProof & { now: number },
): Promise<boolean> {
  return validCommitment(p.credentialKeysetCommitment) && validTime(p.now)
    ? settleClaim(db, p)
    : false;
}
export function expireWalletClaims(
  db: D1Database,
  now: number,
  limit: number,
  credentialKeysetCommitment: string,
): Promise<number> {
  if (!validCommitment(credentialKeysetCommitment) || !validTime(now) || !Number.isFinite(limit))
    return Promise.resolve(0);
  return expireClaims(
    db,
    now,
    Math.max(1, Math.min(100, Math.trunc(limit))),
    credentialKeysetCommitment,
  );
}

/** Only status/reason enter columns; an optional bounded raw body is encrypted with org/event AAD. */
export async function completeWalletOperation(
  ctx: ServiceContext,
  p: WalletClaimRef & {
    result: WalletProviderResult;
  },
): Promise<WalletOperationState | null> {
  ctx = snapshotWalletCredentialContext(ctx);
  p = { ...p };
  const result = p.result;
  if (
    !validCommitment(p.credentialKeysetCommitment) ||
    !validHandle(p.claimHandle) ||
    !validTime(p.now) ||
    !validStatus(result.httpStatus) ||
    (result.rawBody !== undefined &&
      (!(result.rawBody instanceof Uint8Array) || result.rawBody.length > 262_144)) ||
    (result.kind !== 'success' &&
      result.kind !== 'not_issued' &&
      (result.kind !== 'failure' ||
        !Object.hasOwn(reasons, result.reason) ||
        (result.reason as string) === 'ok' ||
        (result.reason as string) === 'not_issued' ||
        (result.retryAfterMs !== undefined &&
          (!validTime(result.retryAfterMs) || result.retryAfterMs > 300_000)))) ||
    (result.kind === 'not_issued' &&
      (result.httpStatus !== undefined || result.rawBody !== undefined))
  )
    return null;
  if ((await requireCredentialRefKeyset(ctx.env.DB, ctx.env)) !== p.credentialKeysetCommitment)
    return null;
  const op = await getOperation(ctx.env.DB, p);
  if (!op || op.credentialKeysetCommitment !== p.credentialKeysetCommitment || op.attempts < 1)
    return null;
  let raw: { id: string; eventHash: string; payloadHash: string; envelope: Envelope } | undefined;
  if (result.rawBody !== undefined) {
    const id = ctx.ids.id();
    raw = {
      id,
      eventHash: await sha256Hex('wallet-completion-v1'),
      payloadHash: await sha256Hex(result.rawBody),
      envelope: await encryptSecret(
        await loadKekRing(ctx.env),
        result.rawBody,
        credentialAad(id, p.orgId, 'wallet.provider.outcome'),
      ),
    };
  }
  if ((await requireCredentialRefKeyset(ctx.env.DB, ctx.env)) !== p.credentialKeysetCommitment)
    return null;
  return finishOperation(ctx.env.DB, {
    ...p,
    hash: await walletClaimHash(p.claimHandle),
    operationId: op.id,
    attempt: op.attempts,
    result,
    raw,
  });
}

/** Each distinct provider HTTP response is retained encrypted, without authorizing state changes. */
export async function recordWalletOperationOutcome(
  ctx: ServiceContext,
  p: WalletClaimRef & {
    sequence: number;
    eventKey: string;
    body: Uint8Array;
    reason: WalletReasonCode;
    httpStatus?: number;
  },
): Promise<OutcomeReceipt> {
  ctx = snapshotWalletCredentialContext(ctx);
  p = { ...p };
  if (
    !validCommitment(p.credentialKeysetCommitment) ||
    !validHandle(p.claimHandle) ||
    !validTime(p.now) ||
    typeof p.eventKey !== 'string' ||
    !p.eventKey ||
    p.eventKey.length > 256 ||
    p.eventKey === 'wallet-completion-v1' ||
    !Number.isSafeInteger(p.sequence) ||
    p.sequence < 1 ||
    !(p.body instanceof Uint8Array) ||
    p.body.length > 262_144 ||
    !Object.hasOwn(reasons, p.reason) ||
    !validStatus(p.httpStatus)
  )
    return 'stale';
  if ((await requireCredentialRefKeyset(ctx.env.DB, ctx.env)) !== p.credentialKeysetCommitment)
    return 'stale';
  const op = await getOperation(ctx.env.DB, p);
  if (!op || op.credentialKeysetCommitment !== p.credentialKeysetCommitment || op.attempts < 1)
    return 'stale';
  const id = ctx.ids.id();
  const envelope = await encryptSecret(
    await loadKekRing(ctx.env),
    p.body,
    credentialAad(id, p.orgId, 'wallet.provider.outcome'),
  );
  if ((await requireCredentialRefKeyset(ctx.env.DB, ctx.env)) !== p.credentialKeysetCommitment)
    return 'stale';
  return insertOutcome(ctx.env.DB, {
    ...p,
    id,
    operationId: op.id,
    attempt: op.attempts,
    claimHash: await walletClaimHash(p.claimHandle),
    eventHash: await sha256Hex(`wallet-response-v1\0${p.eventKey}`),
    payloadHash: await sha256Hex(p.body),
    envelope,
    httpStatus: p.httpStatus ?? null,
  });
}
