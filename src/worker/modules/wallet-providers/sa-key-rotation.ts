import { ConflictError, NotFoundError, UnavailableError } from '../../platform/errors.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { recordAudit } from '../audit/service.ts';
import {
  enterStep,
  findOpenRun,
  finishRun,
  getRun,
  insertRun,
  parkRun,
  patchRunRef,
  type RunRow,
} from '../identities/repo-runs.ts';
import { readGoogleSecret, saveSystemCredential } from './credential-system-save.ts';
import { GoogleWalletError } from './google-errors.ts';
import {
  createServiceAccountKey,
  deleteServiceAccountKey,
  listServiceAccountKeys,
} from './google-iam.ts';
import { managedDeps } from './google-managed-deps.ts';
import { type CredentialRow, findCredential } from './repo-credentials.ts';
import { claimRun, liveKeysOf, recordKey, releaseRun, setKeyState } from './repo-google-managed.ts';
import { iamToken, keyAlert } from './sa-key-access.ts';
import { completeRollback, fanOut, retireOld, verifyNewKey } from './sa-key-stages.ts';

const DAY = 86_400_000;
/** A key rotates every 90 days; the old one is deleted a day after the switch (tokens last an hour). */
export const KEY_ROTATION_MS = 90 * DAY;
export const OLD_KEY_COOLDOWN_MS = DAY;
const MAX_KEYS = 2;
const LEASE_MS = 5 * 60_000;
const GOOGLE = 'google' as const;
const TARGET = 'wallet_credential' as const;

export interface Ref {
  /** The version the switch replaced: the rollback target. */
  prevVersionId?: string;
  /** The credential's `next_rotation_at` before the switch; 0 for none (a merge patch cannot hold null). */
  prevRotation?: number;
  oldKey?: string;
  newKey?: string;
  /** Set before a rollback restores anything: a retry finishes the rollback and never verifies or retires. */
  stage?: 'switched' | 'verified' | 'fanned' | 'rolled_back';
  /** The version holding the new key; verify and retire refuse if the credential moved off it. */
  newVersionId?: string;
  fanoutAfter?: string;
  deleteAfter?: number;
}

const refOf = (run: RunRow): Ref => (run.external_ref ? (JSON.parse(run.external_ref) as Ref) : {});

/** Starts a key rotation for a platform Google credential, or returns the open one. */
export async function startKeyRotation(
  ctx: ServiceContext,
  input: { credentialId: string; createdBy: string | null; keyId?: string },
): Promise<{ runId: string; created: boolean }> {
  const db = ctx.env.DB;
  const credential = await findCredential(db, input.credentialId, null);
  if (credential?.provider !== 'google') throw new NotFoundError();
  if (credential.revoked_at !== null || !credential.current_version_id)
    throw new ConflictError('This credential is revoked.', 'WALLET_ACCOUNT_CONFLICT');
  const id = ctx.ids.id();
  const inserted = await insertRun(db, {
    id,
    provider: GOOGLE,
    orgId: null,
    kind: 'rotate',
    targetType: TARGET,
    targetId: credential.id,
    createdBy: input.createdBy,
    ref: {},
    now: ctx.clock.now(),
  });
  if (!inserted) {
    const open = await findOpenRun(db, TARGET, credential.id, 'rotate');
    if (open) return { runId: open.id, created: false };
    return startKeyRotation(ctx, input);
  }
  try {
    await ctx.env.JOBS.send({ kind: 'wallet.google_key_rotate', runId: id });
  } catch (error) {
    await finishRun(db, id, 'failed', 'WALLET_RUN_UNQUEUED', ctx.clock.now());
    throw error;
  }
  await recordAudit(ctx, {
    actorType: input.keyId ? 'api_key' : input.createdBy ? 'user' : 'system',
    actorId: input.keyId ?? input.createdBy,
    orgId: null,
    action: 'wallet.google_key_rotation_requested',
    targetType: 'wallet_credential',
    targetId: credential.id,
    detail: { runId: id, ...(input.keyId ? { via: 'api' } : {}) },
  });
  return { runId: id, created: true };
}

/**
 * The `wallet.google_key_rotate` job (design 5.2). One job holds the run at a time (a lease). Stages, each
 * safe to run twice: switch (create the new key, record it, write it as the credential's next version),
 * verify (a token exchange and an issuer read with that version; a failure marks the run `rolled_back`
 * first, then restores the old version and deletes the new key), fan out (a new version for every
 * credential that holds PassBook's old key), a day's cooldown, then delete the old key if nothing holds it.
 */
export async function runKeyRotation(ctx: ServiceContext, runId: string): Promise<void> {
  const db = ctx.env.DB;
  const claim = await claimRun(db, runId, ctx.clock.now(), LEASE_MS);
  if (claim === 'closed') return;
  if (claim === 'busy')
    throw new UnavailableError('Another job holds this run.', 'WALLET_RUN_BUSY');
  try {
    await work(ctx, runId);
  } catch (error) {
    await releaseRun(db, runId);
    if (
      error instanceof GoogleWalletError &&
      !['network', 'timeout', 'rate_limited', 'server_error'].includes(error.code)
    )
      return void (await fail(ctx, runId, `GOOGLE_${error.code.toUpperCase()}`, error));
    throw error;
  }
  await releaseRun(db, runId);
}

async function work(ctx: ServiceContext, runId: string): Promise<void> {
  const db = ctx.env.DB;
  const run = await getRun(db, runId, GOOGLE);
  if (!run) return;
  const now = () => ctx.clock.now();
  let ref = refOf(run);
  const patch = async (p: Partial<Ref>) => {
    ref = { ...ref, ...p };
    await patchRunRef(db, runId, p, now());
  };
  let cred = await findCredential(db, run.target_id, null);
  if (!cred || cred.revoked_at !== null)
    return void (await fail(ctx, runId, 'WALLET_CREDENTIAL_REVOKED'));

  if (ref.stage === 'rolled_back') {
    await completeRollback(ctx, cred, ref);
    return void (await fail(ctx, runId, 'WALLET_KEY_VERIFY_FAILED'));
  }
  if (!ref.stage) {
    await enterStep(db, runId, 'switch', now());
    const switched = await switchKey(ctx, cred, ref, patch);
    if (!switched) return void (await fail(ctx, runId, 'WALLET_KEY_UNKNOWN'));
    cred = switched;
  }
  if (ref.stage === 'switched') {
    await enterStep(db, runId, 'verify', now());
    const verdict = await verifyNewKey(ctx, cred, ref);
    if (verdict === 'changed') return void (await fail(ctx, runId, 'WALLET_KEY_CHANGED'));
    if (verdict === 'bad') {
      await patch({ stage: 'rolled_back' });
      await completeRollback(ctx, cred, ref);
      return void (await fail(ctx, runId, 'WALLET_KEY_VERIFY_FAILED'));
    }
    await patch({ stage: 'verified' });
  }
  if (ref.stage === 'verified') {
    await enterStep(db, runId, 'fan_out', now());
    await fanOut(ctx, cred, ref, patch);
    await patch({ stage: 'fanned', deleteAfter: now() + OLD_KEY_COOLDOWN_MS });
  }
  if (ref.deleteAfter !== undefined && now() < ref.deleteAfter) {
    await parkRun(db, runId, 'old_key_cooldown', now());
    return;
  }
  await enterStep(db, runId, 'retire', now());
  const outcome = await retireOld(ctx, cred, ref);
  if (outcome === 'held') {
    await patch({ deleteAfter: now() + OLD_KEY_COOLDOWN_MS });
    await parkRun(db, runId, 'old_key_held', now());
    await keyAlert(
      ctx,
      'WALLET_KEY_HELD',
      'The old Google service-account key is still in use',
      'A credential still holds the key that rotation replaced, so it was not deleted. Check the platform credentials of every mode, then the run retries tomorrow.',
    );
    return;
  }
  if (outcome === 'refused') return void (await fail(ctx, runId, 'WALLET_KEY_NOT_RETIRING'));
  await finishRun(db, runId, 'succeeded', null, now());
  await recordAudit(ctx, {
    actorType: 'system',
    action: 'wallet.google_key_rotated',
    targetType: 'wallet_credential',
    targetId: cred.id,
    detail: { runId },
  });
  ctx.log.info('wallet.google_key_rotated', { runId, credentialId: cred.id });
}

async function fail(ctx: ServiceContext, runId: string, code: string, error?: unknown) {
  await finishRun(ctx.env.DB, runId, 'failed', code, ctx.clock.now());
  ctx.log.error('wallet.google_key_rotate_failed', { runId, code, ...(error ? { error } : {}) });
  await keyAlert(
    ctx,
    code,
    'Google service-account key rotation failed',
    `Rotating the Google service-account key stopped (${code}). Wallet issuance keeps using a working key. Check the key inventory and retry.`,
  );
}

/**
 * Which key this rotation replaces. A single key PassBook has not recorded is the one an admin uploaded:
 * it is adopted. Otherwise every key must be one PassBook recorded, and the active one is replaced.
 */
async function pickOldKey(
  ctx: ServiceContext,
  cred: CredentialRow,
  email: string,
  keys: { name: string }[],
): Promise<string | null> {
  const known = await liveKeysOf(ctx.env.DB, email);
  const present = new Set(keys.map((k) => k.name));
  const live = known.filter((k) => present.has(k.key_name));
  if (live.length === 0) {
    const [only] = keys;
    if (keys.length !== 1 || !only) return null;
    await recordKey(ctx.env.DB, {
      name: only.name,
      credentialId: cred.id,
      origin: 'adopted',
      state: 'active',
      now: ctx.clock.now(),
    });
    return only.name;
  }
  if (keys.length !== live.length) return null;
  return live.filter((k) => k.state === 'active').at(-1)?.key_name ?? null;
}

/**
 * Creates the new key and makes it the credential's current version. The key is recorded as pending and
 * on the run before anything uses it, so a crash leaves a key the retry or the inventory can find.
 * Null: the keys are not ours to rotate.
 */
async function switchKey(
  ctx: ServiceContext,
  cred: CredentialRow,
  ref: Ref,
  patch: (p: Partial<Ref>) => Promise<void>,
): Promise<CredentialRow | null> {
  const db = ctx.env.DB;
  const secret = await readGoogleSecret(ctx, cred.id);
  const iam = managedDeps().iam(ctx.env);
  const token = await iamToken(ctx, secret.credentials);
  const email = secret.credentials.serviceAccountEmail;

  if (ref.newKey && ref.prevVersionId) {
    // A retry after the switch landed: the pointer already moved off the version we recorded.
    if (cred.current_version_id !== ref.prevVersionId) {
      await setKeyState(db, ref.newKey, 'active', ctx.clock.now());
      if (ref.oldKey) await setKeyState(db, ref.oldKey, 'retiring', ctx.clock.now());
      await patch({ stage: 'switched', newVersionId: cred.current_version_id ?? '' });
      return cred;
    }
    await deleteServiceAccountKey(iam, token, ref.newKey);
    await setKeyState(db, ref.newKey, 'retired', ctx.clock.now());
  }
  // A key made by an attempt that died before the run named it: never switched in, so not held.
  for (const orphan of (await liveKeysOf(db, email)).filter(
    (k) => k.state === 'pending' && k.key_name !== ref.newKey,
  )) {
    await deleteServiceAccountKey(iam, token, orphan.key_name);
    await setKeyState(db, orphan.key_name, 'retired', ctx.clock.now());
  }
  const keys = await listServiceAccountKeys(iam, token, email);
  const oldKey = ref.oldKey ?? (await pickOldKey(ctx, cred, email, keys));
  if (!oldKey || keys.length >= MAX_KEYS) return null;
  await patch({
    oldKey,
    prevVersionId: secret.versionId,
    prevRotation: cred.next_rotation_at ?? 0,
  });
  const created = await createServiceAccountKey(iam, token, email);
  await recordKey(db, {
    name: created.name,
    credentialId: cred.id,
    origin: 'created',
    state: 'pending',
    now: ctx.clock.now(),
  });
  await patch({ newKey: created.name });
  let saved: CredentialRow;
  try {
    if (created.email !== email) throw new GoogleWalletError('invalid_response', 'keys.create');
    saved = await saveSystemCredential(
      ctx,
      {
        orgId: null,
        mode: cred.mode,
        current: cred,
        secret: { ...secret.credentials, privateKeyPem: created.privateKeyPem },
        nextRotationAt: ctx.clock.now() + KEY_ROTATION_MS,
      },
      'sa_key',
    );
  } catch (error) {
    try {
      await deleteServiceAccountKey(iam, token, created.name);
      await setKeyState(db, created.name, 'retired', ctx.clock.now());
    } catch (cleanup) {
      ctx.log.error('wallet.google_key_orphaned', { code: 'WALLET_KEY_ORPHANED', error: cleanup });
    }
    throw error;
  }
  await setKeyState(db, created.name, 'active', ctx.clock.now());
  await setKeyState(db, oldKey, 'retiring', ctx.clock.now());
  await patch({ stage: 'switched', newVersionId: saved.current_version_id ?? '' });
  return saved;
}
