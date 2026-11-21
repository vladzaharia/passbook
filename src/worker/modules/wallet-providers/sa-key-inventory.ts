import { sha256Hex } from '../../platform/ids.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { recordAudit } from '../audit/service.ts';
import { readSystemValue, writeSystemValue } from '../settings/repo.ts';
import { readGoogleSecret } from './credential-system-save.ts';
import { deleteServiceAccountKey, listServiceAccountKeys } from './google-iam.ts';
import { managedDeps } from './google-managed-deps.ts';
import {
  cooledRotationRuns,
  dueKeyRotations,
  expiredLeaseRuns,
  liveKeysOf,
  orphanKeys,
  platformGoogleCredentials,
  recordKey,
  resumeRun,
  setKeyState,
} from './repo-google-managed.ts';
import { iamToken, keyAlert } from './sa-key-access.ts';
import { startKeyRotation } from './sa-key-rotation.ts';

const DAY = 86_400_000;
/** Keys that may exist at once: the current one, and the old one during the overlap. */
export const MAX_SA_KEYS = 2;

/**
 * Daily: Google's key list of each platform service account against the keys PassBook created. A key it
 * did not create, or more than two keys, raises `wallet.key_unknown` (audit, error log, email); nothing is
 * ever deleted here. A single key found where PassBook has recorded none is the uploaded one and is adopted.
 */
export async function runKeyInventory(ctx: ServiceContext): Promise<void> {
  const seen = new Set<string>();
  for (const cred of await platformGoogleCredentials(ctx.env.DB)) {
    const { credentials } = await readGoogleSecret(ctx, cred.id);
    const email = credentials.serviceAccountEmail;
    if (seen.has(email)) continue;
    seen.add(email);
    try {
      await inventoryOf(ctx, cred.id, email, credentials);
    } catch (error) {
      ctx.log.error('wallet.key_inventory_failed', { code: 'WALLET_KEY_INVENTORY_FAILED', error });
    }
  }
}

async function inventoryOf(
  ctx: ServiceContext,
  credentialId: string,
  email: string,
  credentials: Parameters<typeof iamToken>[1],
): Promise<void> {
  const db = ctx.env.DB;
  const now = ctx.clock.now();
  const keys = await listServiceAccountKeys(
    managedDeps().iam(ctx.env),
    await iamToken(ctx, credentials),
    email,
  );
  let known = await liveKeysOf(db, email);
  const present = new Set(keys.map((k) => k.name));
  // A key deleted outside PassBook is closed in the table.
  for (const k of known)
    if (!present.has(k.key_name)) await setKeyState(db, k.key_name, 'retired', now);
  known = known.filter((k) => present.has(k.key_name));
  const [only] = keys;
  if (known.length === 0 && keys.length === 1 && only) {
    await recordKey(db, { name: only.name, credentialId, origin: 'adopted', state: 'active', now });
    known = await liveKeysOf(db, email);
  }
  const ours = new Set(known.map((k) => k.key_name));
  const unknown = keys.filter((k) => !ours.has(k.name)).map((k) => k.name);
  const tooMany = keys.length > MAX_SA_KEYS;
  const flag = `wallet_sa_inventory.${(await sha256Hex(email)).slice(0, 16)}`;
  if (unknown.length === 0 && !tooMany) {
    await writeSystemValue(db, flag, { ok: true }, now);
    return;
  }
  const day = Math.floor(now / DAY);
  const last = (await readSystemValue(db, flag)) as { day?: number } | null;
  if (last?.day === day) return;
  await recordAudit(ctx, {
    actorType: 'system',
    action: 'wallet.key_unknown',
    targetType: 'wallet_credential',
    targetId: credentialId,
    detail: { keys: keys.length, unknown: unknown.length },
  });
  await keyAlert(
    ctx,
    'WALLET_KEY_UNKNOWN',
    'Google service-account keys need a look',
    `The service account ${email} has ${keys.length} keys${unknown.length > 0 ? `, ${unknown.length} that PassBook did not create` : ''}. Remove the ones that are not in use in Google Cloud. PassBook never deletes a key it did not create.`,
  );
  await writeSystemValue(db, flag, { day }, now);
}

/**
 * A key PassBook made and never switched in, with no rotation open for it, is held by nothing: delete it.
 * (A switch that landed marks its key active before the run moves on.)
 */
async function removeOrphans(ctx: ServiceContext): Promise<void> {
  const now = ctx.clock.now();
  for (const orphan of await orphanKeys(ctx.env.DB, now - DAY)) {
    try {
      const { credentials } = await readGoogleSecret(ctx, orphan.credential_id);
      await deleteServiceAccountKey(
        managedDeps().iam(ctx.env),
        await iamToken(ctx, credentials),
        orphan.key_name,
      );
      await setKeyState(ctx.env.DB, orphan.key_name, 'retired', now);
      ctx.log.warn('wallet.google_key_orphan_removed', { code: 'WALLET_KEY_ORPHAN_REMOVED' });
    } catch (error) {
      ctx.log.error('wallet.key_orphan_failed', { code: 'WALLET_KEY_ORPHAN_FAILED', error });
    }
  }
}

/** Daily cron: start due rotations, finish cooled-down ones, then take the inventory. */
export async function dailyGoogleKeys(ctx: ServiceContext): Promise<void> {
  const now = ctx.clock.now();
  for (const due of await dueKeyRotations(ctx.env.DB, now)) {
    try {
      await startKeyRotation(ctx, { credentialId: due.id, createdBy: null });
    } catch (error) {
      ctx.log.error('wallet.key_rotation_start_failed', {
        code: 'WALLET_KEY_ROTATION_START',
        error,
      });
    }
  }
  for (const run of await cooledRotationRuns(ctx.env.DB, now))
    if (await resumeRun(ctx.env.DB, run.id, now))
      await ctx.env.JOBS.send({ kind: 'wallet.google_key_rotate', runId: run.id });
  // A run whose job died keeps `running` behind a lease: once the lease is over, queue it again.
  for (const run of await expiredLeaseRuns(ctx.env.DB, now))
    if (await resumeRun(ctx.env.DB, run.id, now))
      await ctx.env.JOBS.send({
        kind: run.kind === 'rotate' ? 'wallet.google_key_rotate' : 'wallet.google_issuer',
        runId: run.id,
      });
  await removeOrphans(ctx);
  await runKeyInventory(ctx);
}
