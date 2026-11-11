import {
  credentialAad,
  decryptSecretText,
  type Envelope,
  encryptSecret,
  loadKekRing,
} from '../../platform/crypto.ts';
import { UnavailableError } from '../../platform/errors.ts';
import { sha256Hex } from '../../platform/ids.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import {
  captureCredentialKeyEnv,
  requireCredentialRefKeyset,
} from '../passes/credential-keyset.ts';
import { walletClaimHash } from './instance-claims.ts';
import { walletProviderEnabled } from './provider-policy.ts';
import {
  getSamsungRefForSync,
  listSamsungCountryHints,
  putSamsungFetchRef,
  type SamsungOperationScope,
  type SamsungRefEnvelope,
  samsungRefStillCurrent,
} from './repo-callbacks.ts';
import {
  inspectSamsungRetirement,
  retireSamsungUnpromotedRef,
  type SamsungRefRetirement,
} from './repo-callbacks-retirement.ts';

/** Keep the commitment and envelope operations on one immutable KEK binding snapshot. */
export function pinSamsungCredentialContext(ctx: ServiceContext): ServiceContext {
  const env = { ...ctx.env };
  Object.assign(env, captureCredentialKeyEnv(env));
  return { ...ctx, env: Object.freeze(env) };
}

/** A later environment/singleton must never replace the operation's original proof. */
export async function requireSamsungCredentialKeyset(
  ctx: ServiceContext,
  expected: string,
): Promise<void> {
  if ((await requireCredentialRefKeyset(ctx.env.DB, ctx.env)) !== expected)
    throw new UnavailableError(
      'Credential references are unavailable.',
      'CREDENTIAL_REF_KEYSET_UNAVAILABLE',
    );
}

function aad(id: string, scope: SamsungOperationScope): string {
  return credentialAad(id, scope.orgId, `samsung-ref|${scope.mode}|${scope.instanceId}`);
}

function bytes(value: number[] | Uint8Array | ArrayBuffer): Uint8Array {
  if (value instanceof Uint8Array) return value;
  return Array.isArray(value) ? new Uint8Array(value) : new Uint8Array(value);
}

function envelope(row: SamsungRefEnvelope): Envelope {
  return {
    kekVersion: row.kek_version,
    iv: bytes(row.iv),
    wrappedDek: bytes(row.wrapped_dek),
    ciphertext: bytes(row.ciphertext),
  };
}

async function openRef(
  ctx: ServiceContext,
  scope: SamsungOperationScope,
  row: SamsungRefEnvelope,
): Promise<string> {
  let ref: string;
  try {
    ref = await decryptSecretText(await loadKekRing(ctx.env), envelope(row), aad(row.id, scope));
    if (!/^[A-Za-z0-9_-]{32}$/.test(ref) || (await sha256Hex(ref)) !== row.ref_hash) {
      throw new Error();
    }
  } catch {
    throw new Error('Samsung reference is unavailable.');
  }
  await requireSamsungCredentialKeyset(ctx, scope.credentialKeysetCommitment);
  return ref;
}

/** Reuse one encrypted ref per instance; only a redeemed wrapper reopens its initial window. */
export async function ensureSamsungFetchRef(
  ctx: ServiceContext,
  scope: SamsungOperationScope & { expiresAt: number },
): Promise<string | null> {
  if (!walletProviderEnabled('samsung')) return null;
  ctx = pinSamsungCredentialContext(ctx);
  scope = { ...scope };
  await requireSamsungCredentialKeyset(ctx, scope.credentialKeysetCommitment);
  const now = ctx.clock.now();
  if (
    !Number.isSafeInteger(scope.expiresAt) ||
    scope.expiresAt <= now ||
    scope.expiresAt > now + 300_000
  )
    return null;
  const id = ctx.ids.id();
  const ref = ctx.ids.token(24);
  const encrypted = await encryptSecret(await loadKekRing(ctx.env), ref, aad(id, scope));
  const commitNow = ctx.clock.now();
  if (scope.expiresAt <= commitNow) return null;
  const row = await putSamsungFetchRef(ctx.env.DB, scope, {
    id,
    hash: await sha256Hex(ref),
    envelope: encrypted,
    now: commitNow,
    expiresAt: scope.expiresAt,
  });
  if (!row) return null;
  const actual = row.id === id ? ref : await openRef(ctx, scope, row);
  if (!(await samsungRefStillCurrent(ctx.env.DB, scope, row.id, false, ctx.clock.now())))
    return null;
  await requireSamsungCredentialKeyset(ctx, scope.credentialKeysetCommitment);
  return actual;
}

/** Server-only notification target. Country codes are untrusted fixed-host routing hints. */
export async function getSamsungRefreshTarget(
  ctx: ServiceContext,
  scope: SamsungOperationScope,
): Promise<{ refId: string; countryCodes: string[] } | null> {
  ctx = pinSamsungCredentialContext(ctx);
  scope = { ...scope };
  await requireSamsungCredentialKeyset(ctx, scope.credentialKeysetCommitment);
  const row = await getSamsungRefForSync(ctx.env.DB, scope, ctx.clock.now());
  if (!row) return null;
  const refId = await openRef(ctx, scope, row);
  const countryCodes = await listSamsungCountryHints(ctx.env.DB, row.id);
  if (!(await samsungRefStillCurrent(ctx.env.DB, scope, row.id, true, ctx.clock.now())))
    return null;
  await requireSamsungCredentialKeyset(ctx, scope.credentialKeysetCommitment);
  return { refId, countryCodes };
}

/** Preflight never proves retirement: the claimant must still run the atomic retirement step. */
export async function inspectSamsungRefRetirement(
  ctx: ServiceContext,
  scope: SamsungOperationScope,
): Promise<SamsungRefRetirement> {
  ctx = pinSamsungCredentialContext(ctx);
  scope = { ...scope };
  await requireSamsungCredentialKeyset(ctx, scope.credentialKeysetCommitment);
  const result = await inspectSamsungRetirement(ctx.env.DB, scope, ctx.clock.now());
  await requireSamsungCredentialKeyset(ctx, scope.credentialKeysetCommitment);
  return result;
}

export async function retireExpiredUnpromotedRef(
  ctx: ServiceContext,
  scope: SamsungOperationScope & { claimHandle: string },
): Promise<SamsungRefRetirement> {
  if (!/^[A-Za-z0-9_-]{43}$/.test(scope.claimHandle)) return 'pending';
  ctx = pinSamsungCredentialContext(ctx);
  scope = { ...scope };
  await requireSamsungCredentialKeyset(ctx, scope.credentialKeysetCommitment);
  const result = await retireSamsungUnpromotedRef(
    ctx.env.DB,
    scope,
    ctx.clock.now(),
    await walletClaimHash(scope.claimHandle),
  );
  await requireSamsungCredentialKeyset(ctx, scope.credentialKeysetCommitment);
  return result;
}
