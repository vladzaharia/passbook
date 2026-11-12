import { randomBytes, sha256Hex, toBase64Url } from '../../platform/ids.ts';
import {
  nonnegative,
  requestHash,
  sameProof,
  scopeValid,
  validAuthority,
  validProof,
  validRequest,
} from './instance-input.ts';
import type {
  WalletCredentialKeysetProof,
  WalletInstanceProof,
  WalletOfferAuthority,
  WalletOfferBinding,
  WalletOperation,
  WalletOperationRef,
} from './instance-types.ts';
import { isCredentialKeysetCommitment as validCommitment } from './instance-types.ts';
import { walletProviderEnabled } from './provider-policy.ts';
import {
  getInstanceByPass,
  getOperation,
  getOperationByRequest,
  insertDesiredOperation,
  insertInstance,
} from './repo-instance.ts';
import { operationFresh } from './repo-instance-claims.ts';
import {
  consumeOffer,
  deleteOffer,
  insertOffer,
  purgeExpiredOffers,
  readOffer,
} from './repo-instance-offers.ts';

const OFFER_TTL = 300_000;
const newRef = () => toBase64Url(randomBytes(32));
const validRef = (ref: string) => /^[A-Za-z0-9_-]{43}$/.test(ref);

export async function createWalletOfferRef(
  db: D1Database,
  p: WalletOperationRef &
    WalletCredentialKeysetProof & {
      authority: WalletOfferAuthority;
      now: number;
    },
): Promise<{ ref: string; expiresAt: number } | null> {
  p = { ...p, authority: { ...p.authority } };
  if (
    !walletProviderEnabled(p.provider) ||
    !validCommitment(p.credentialKeysetCommitment) ||
    !scopeValid(p) ||
    !nonnegative(p.now) ||
    !validAuthority(p.authority)
  )
    return null;
  const op = await getOperation(db, p);
  if (!op || op.credentialKeysetCommitment !== p.credentialKeysetCommitment) return null;
  const ref = newRef();
  const expiresAt = p.now + OFFER_TTL;
  const inserted = await insertOffer(db, {
    ...p,
    operationId: op.id,
    hash: await sha256Hex(ref),
    expiresAt,
  });
  return inserted ? { ref, expiresAt } : null;
}

/** Atomically commits a new instance/desired operation and its first bearer-fenced wrapper. */
export async function createWalletInstanceAndOffer(
  db: D1Database,
  p: WalletInstanceProof & {
    instanceId: string;
    requestKey: string;
    now: number;
    newId: () => string;
    authority: WalletOfferAuthority;
  },
): Promise<{ operation: WalletOperation; ref: string; expiresAt: number } | null> {
  p = { ...p, authority: { ...p.authority } };
  if (
    !walletProviderEnabled(p.provider) ||
    !validProof(p, 'upsert') ||
    !validRequest(p.requestKey, p.now) ||
    !p.instanceId ||
    !validAuthority(p.authority)
  )
    return null;
  const hash = await requestHash(p.requestKey);
  const ref = newRef();
  const refHash = await sha256Hex(ref);
  const expiresAt = p.now + OFFER_TTL;
  const offer = { hash: refHash, expiresAt, authority: p.authority };
  let instance = await getInstanceByPass(db, p);
  if (instance && instance.credentialKeysetCommitment !== p.credentialKeysetCommitment) return null;
  if (!instance || instance.lifecycle === 'ready') {
    const instanceId = instance?.id ?? p.instanceId;
    await insertInstance(
      db,
      { ...p, instanceId, operationId: p.newId(), requestHash: hash },
      offer,
    );
    instance = await getInstanceByPass(db, p);
    if (
      !instance ||
      instance.credentialKeysetCommitment !== p.credentialKeysetCommitment ||
      instance.lifecycle === 'ready' ||
      instance.lifecycle === 'blocked'
    )
      return null;
  }
  if (instance.lifecycle === 'retired') return null;
  const previous = await getOperationByRequest(db, {
    ...p,
    instanceId: instance.id,
    requestHash: hash,
  });
  if (previous && !sameProof(previous, p, 'upsert')) return null;
  let operation = await getOperation(db, {
    ...p,
    instanceId: instance.id,
    version: instance.desiredVersion,
  });
  if (!operation) return null;
  if (!sameProof(operation, p, 'upsert')) {
    if (previous) return null;
    await insertDesiredOperation(
      db,
      {
        ...p,
        instanceId: instance.id,
        expectedVersion: instance.desiredVersion,
        kind: 'upsert',
        operationId: p.newId(),
        requestHash: hash,
      },
      offer,
    );
    operation = await getOperationByRequest(db, {
      ...p,
      instanceId: instance.id,
      requestHash: hash,
    });
    if (!operation || !sameProof(operation, p, 'upsert')) return null;
  }
  let binding = await readOffer(db, refHash, p.now, p.credentialKeysetCommitment);
  if (
    !binding &&
    (await operationFresh(db, {
      ...p,
      instanceId: instance.id,
      version: operation.version,
      now: p.now,
    }))
  ) {
    const inserted = await insertOffer(db, {
      ...p,
      instanceId: instance.id,
      version: operation.version,
      operationId: operation.id,
      hash: refHash,
      expiresAt,
    });
    if (inserted) binding = await readOffer(db, refHash, p.now, p.credentialKeysetCommitment);
  }
  return binding ? { operation, ref, expiresAt } : null;
}

export async function consumeWalletOfferRef(
  db: D1Database,
  ref: string,
  now: number,
  credentialKeysetCommitment: string,
): Promise<WalletOfferBinding | null> {
  if (!validCommitment(credentialKeysetCommitment) || !validRef(ref) || !nonnegative(now))
    return null;
  const hash = await sha256Hex(ref);
  const binding = await readOffer(db, hash, now, credentialKeysetCommitment);
  return binding && walletProviderEnabled(binding.provider)
    ? consumeOffer(db, hash, now, credentialKeysetCommitment)
    : null;
}
/** Call after generating provider links and before returning them to the bearer. */
export async function walletOfferFresh(
  db: D1Database,
  ref: string,
  now: number,
  credentialKeysetCommitment: string,
): Promise<boolean> {
  if (!validCommitment(credentialKeysetCommitment) || !validRef(ref) || !nonnegative(now))
    return false;
  const binding = await readOffer(db, await sha256Hex(ref), now, credentialKeysetCommitment);
  return !!binding && walletProviderEnabled(binding.provider);
}
export async function expireWalletOfferRef(
  db: D1Database,
  ref: string,
  _now: number,
): Promise<boolean> {
  return validRef(ref) ? deleteOffer(db, await sha256Hex(ref)) : false;
}

export function purgeExpiredWalletOffers(
  db: D1Database,
  now: number,
  limit: number,
): Promise<number> {
  if (!nonnegative(now) || !Number.isFinite(limit)) return Promise.resolve(0);
  return purgeExpiredOffers(db, now, Math.max(1, Math.min(100, Math.trunc(limit))));
}
