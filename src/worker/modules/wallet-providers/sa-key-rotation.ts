import { ConflictError, NotFoundError } from '../../platform/errors.ts';
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
import { liveKeysOf, markKeyDeleted, recordKey } from './repo-google-managed.ts';
import { iamToken, keyAlert } from './sa-key-access.ts';
import { fanOut, retireOld, verifyOrRollback } from './sa-key-stages.ts';

const DAY = 86_400_000;
/** A key rotates every 90 days; the old one is deleted a day after the switch (tokens last an hour). */
export const KEY_ROTATION_MS = 90 * DAY;
export const OLD_KEY_COOLDOWN_MS = DAY;
const MAX_KEYS = 2;
const GOOGLE = 'google' as const;
const TARGET = 'wallet_credential' as const;

export interface Ref {
  /** The version the switch replaced: the rollback target. */
  prevVersionId?: string;
  /** The credential's `next_rotation_at` before the switch; 0 for none (a merge patch cannot hold null). */
  prevRotation?: number;
  oldKey?: string;
  newKey?: string;
  stage?: 'switched' | 'verified' | 'fanned';
  fanoutAfter?: string;
  deleteAfter?: number;
}

const refOf = (run: RunRow): Ref => (run.external_ref ? (JSON.parse(run.external_ref) as Ref) : {});

/** Starts a key rotation for a platform Google credential, or returns the open one. */
export async function startKeyRotation(
  ctx: ServiceContext,
  input: { credentialId: string; createdBy: string | null },
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
  return { runId: id, created: true };
}

/**
 * The `wallet.google_key_rotate` job (design 5.2). Stages, each safe to run twice:
 * switch (create the new key, write it as the credential's next version), verify (a token exchange and an
 * issuer read with it; a failure restores the old version and deletes the new key), fan out (a new version
 * for every credential that signs with this key), cool down a day, then delete the old key.
 */
export async function runKeyRotation(ctx: ServiceContext, runId: string): Promise<void> {
  const db = ctx.env.DB;
  const run = await getRun(db, runId, GOOGLE);
  if (!run || (run.state !== 'queued' && run.state !== 'running')) return;
  const now = () => ctx.clock.now();
  try {
    let ref = refOf(run);
    const patch = async (p: Partial<Ref>) => {
      ref = { ...ref, ...p };
      await patchRunRef(db, runId, p, now());
    };
    let cred = await findCredential(db, run.target_id, null);
    if (!cred || cred.revoked_at !== null)
      return void (await fail(ctx, runId, 'WALLET_CREDENTIAL_REVOKED'));

    if (!ref.stage) {
      await enterStep(db, runId, 'switch', now());
      const switched = await switchKey(ctx, cred, ref, patch);
      if (!switched) return void (await fail(ctx, runId, 'WALLET_KEY_UNKNOWN'));
      cred = switched;
    }
    if (ref.stage === 'switched') {
      await enterStep(db, runId, 'verify', now());
      if (!(await verifyOrRollback(ctx, cred, ref)))
        return void (await fail(ctx, runId, 'WALLET_KEY_VERIFY_FAILED'));
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
    await retireOld(ctx, cred, ref);
    await finishRun(db, runId, 'succeeded', null, now());
    await recordAudit(ctx, {
      actorType: 'system',
      action: 'wallet.google_key_rotated',
      targetType: 'wallet_credential',
      targetId: cred.id,
      detail: { runId },
    });
    ctx.log.info('wallet.google_key_rotated', { runId, credentialId: cred.id });
  } catch (error) {
    if (
      error instanceof GoogleWalletError &&
      !['network', 'timeout', 'rate_limited', 'server_error'].includes(error.code)
    )
      return void (await fail(ctx, runId, `GOOGLE_${error.code.toUpperCase()}`, error));
    throw error;
  }
}

async function fail(ctx: ServiceContext, runId: string, code: string, error?: unknown) {
  await finishRun(ctx.env.DB, runId, 'failed', code, ctx.clock.now());
  ctx.log.error('wallet.google_key_rotate_failed', { runId, code, ...(error ? { error } : {}) });
  await keyAlert(
    ctx,
    code,
    'Google service-account key rotation failed',
    `Rotating the Google service-account key stopped (${code}). Wallet issuance keeps using the previous key. Check the key inventory and retry.`,
  );
}

/**
 * Which key this rotation replaces and the limit check. A single key PassBook did not record is the one an
 * admin uploaded: it is adopted. More than one unknown key is never guessed at.
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
      now: ctx.clock.now(),
    });
    return only.name;
  }
  // Every key is ours, and one slot is free for the new key.
  if (keys.length !== live.length || keys.length >= MAX_KEYS) return null;
  return live.at(-1)?.key_name ?? null;
}

async function switchKey(
  ctx: ServiceContext,
  cred: CredentialRow,
  ref: Ref,
  patch: (p: Partial<Ref>) => Promise<void>,
): Promise<CredentialRow | null> {
  const secret = await readGoogleSecret(ctx, cred.id);
  const iam = managedDeps().iam(ctx.env);
  const token = await iamToken(ctx, secret.credentials);
  const email = secret.credentials.serviceAccountEmail;

  // A retry after the switch landed: the pointer already moved off the version we recorded.
  if (ref.newKey && ref.prevVersionId) {
    if (cred.current_version_id !== ref.prevVersionId) {
      await patch({ stage: 'switched' });
      return cred;
    }
    await deleteServiceAccountKey(iam, token, ref.newKey);
    await markKeyDeleted(ctx.env.DB, ref.newKey, ctx.clock.now());
  }
  const keys = await listServiceAccountKeys(iam, token, email);
  const oldKey = ref.oldKey ?? (await pickOldKey(ctx, cred, email, keys));
  if (!oldKey) return null;
  await patch({
    oldKey,
    prevVersionId: secret.versionId,
    prevRotation: cred.next_rotation_at ?? 0,
  });
  const created = await createServiceAccountKey(iam, token, email);
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
    await deleteServiceAccountKey(iam, token, created.name).catch(() => undefined);
    throw error;
  }
  await recordKey(ctx.env.DB, {
    name: created.name,
    credentialId: cred.id,
    origin: 'created',
    now: ctx.clock.now(),
  });
  await patch({ stage: 'switched' });
  return saved;
}
