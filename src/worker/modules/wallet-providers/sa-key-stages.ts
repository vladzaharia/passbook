import type { ServiceContext } from '../../platform/service-context.ts';
import { readGoogleSecret, saveSystemCredential } from './credential-system-save.ts';
import { validateGoogleAccount } from './google-credentials.ts';
import { GoogleWalletError } from './google-errors.ts';
import { deleteServiceAccountKey } from './google-iam.ts';
import { getGoogleIssuer } from './google-issuer-rest.ts';
import { managedDeps } from './google-managed-deps.ts';
import { getGoogleAccessToken } from './google-oauth.ts';
import { type CredentialRow, findCredential } from './repo-credentials.ts';
import {
  busyIssuerRuns,
  keyState,
  platformGoogleCredentials,
  setKeyState,
  signedBy,
} from './repo-google-managed.ts';
import { iamToken } from './sa-key-access.ts';
import type { Ref } from './sa-key-rotation.ts';

const FANOUT_PAGE = 50;
const VERIFY_TRIES = 3;
const VERIFY_WAIT_MS = 3000;

const pemOf = async (ctx: ServiceContext, credentialId: string, versionId: string | null = null) =>
  (await readGoogleSecret(ctx, credentialId, versionId)).credentials.privateKeyPem;

/**
 * A token exchange with the version the switch wrote, and a read of the platform issuer. Three tries: a
 * new key needs a moment. `changed`: the credential is no longer on that version, so nothing is verified.
 */
export async function verifyNewKey(
  ctx: ServiceContext,
  cred: CredentialRow,
  ref: Ref,
): Promise<'ok' | 'bad' | 'changed'> {
  if (!ref.newVersionId || cred.current_version_id !== ref.newVersionId) return 'changed';
  const secret = await readGoogleSecret(ctx, cred.id, ref.newVersionId);
  for (let attempt = 0; attempt < VERIFY_TRIES; attempt++) {
    try {
      const { accessToken } = await getGoogleAccessToken(
        await validateGoogleAccount(secret.credentials),
        { issuedAt: Math.floor(ctx.clock.now() / 1000), fetcher: managedDeps().fetcher() },
      );
      await getGoogleIssuer(
        { accessToken, fetcher: managedDeps().fetcher() },
        secret.credentials.issuerId,
      );
      return 'ok';
    } catch (error) {
      if (!(error instanceof GoogleWalletError)) throw error;
      if (attempt < VERIFY_TRIES - 1) await managedDeps().wait(VERIFY_WAIT_MS);
    }
  }
  return 'bad';
}

/**
 * Writes the replaced version back as the newest (unless that already happened), then deletes the new key.
 * The run is marked `rolled_back` before this runs, so a retry finishes it and never verifies or retires.
 * The old key was never deleted, and is active again.
 */
export async function completeRollback(
  ctx: ServiceContext,
  cred: CredentialRow,
  ref: Ref,
): Promise<void> {
  if (!ref.prevVersionId || !ref.newKey) return;
  const db = ctx.env.DB;
  const previous = await readGoogleSecret(ctx, cred.id, ref.prevVersionId);
  const latest = await findCredential(db, cred.id, null);
  if (!latest) return;
  if ((await pemOf(ctx, cred.id)) !== previous.credentials.privateKeyPem)
    await saveSystemCredential(
      ctx,
      {
        orgId: null,
        mode: latest.mode,
        current: latest,
        secret: previous.credentials,
        nextRotationAt: ref.prevRotation || null,
      },
      'sa_key',
    );
  if (ref.oldKey) await setKeyState(db, ref.oldKey, 'active', ctx.clock.now());
  await deleteServiceAccountKey(
    managedDeps().iam(ctx.env),
    await iamToken(ctx, previous.credentials),
    ref.newKey,
  );
  await setKeyState(db, ref.newKey, 'retired', ctx.clock.now());
}

/**
 * A new version for every credential that holds PassBook's old key, 50 at a time; a rerun skips the done
 * ones. A credential with another key (an org's own upload) is left alone. Platform credentials of other
 * modes on the same service account follow.
 */
export async function fanOut(
  ctx: ServiceContext,
  cred: CredentialRow,
  ref: Ref,
  patch: (p: Partial<Ref>) => Promise<void>,
  sweep = false,
): Promise<void> {
  const { credentials } = await readGoogleSecret(ctx, cred.id);
  const oldPem = await pemOf(ctx, cred.id, ref.prevVersionId ?? null);
  const move = async (row: CredentialRow) => {
    const own = await readGoogleSecret(ctx, row.id);
    if (own.credentials.privateKeyPem !== oldPem) return;
    await saveSystemCredential(
      ctx,
      {
        orgId: row.org_id,
        mode: row.mode,
        current: row,
        secret: {
          ...own.credentials,
          serviceAccountEmail: credentials.serviceAccountEmail,
          privateKeyPem: credentials.privateKeyPem,
        },
      },
      row.org_id === null ? 'sa_key' : 'sa_fanout',
    );
  };
  let after = sweep ? '' : (ref.fanoutAfter ?? '');
  for (;;) {
    const page = await signedBy(ctx.env.DB, cred.id, after, FANOUT_PAGE);
    for (const row of page) await move(row);
    const last = page.at(-1);
    if (!last) break;
    after = last.id;
    if (!sweep) await patch({ fanoutAfter: after });
  }
  for (const sibling of await platformGoogleCredentials(ctx.env.DB))
    if (sibling.id !== cred.id) await move(sibling);
}

/** Does any credential still hold this key's PEM? PassBook's platform credentials of every mode on the account, and the credentials signing with it. */
async function heldBy(ctx: ServiceContext, cred: CredentialRow, oldPem: string): Promise<boolean> {
  for (const platform of await platformGoogleCredentials(ctx.env.DB))
    if ((await pemOf(ctx, platform.id)) === oldPem) return true;
  let after = '';
  for (;;) {
    const page = await signedBy(ctx.env.DB, cred.id, after, FANOUT_PAGE);
    for (const row of page) if ((await pemOf(ctx, row.id)) === oldPem) return true;
    const last = page.at(-1);
    if (!last) return false;
    after = last.id;
  }
}

/**
 * Deletes the replaced key, only when it is `retiring`, past the cooldown that outlives every cached token
 * (a token lasts an hour), after a final fan-out sweep, and when no credential or running issuer run
 * can still use it. `held`: try again later. `refused`: the key is not one this rotation retires.
 */
export async function retireOld(
  ctx: ServiceContext,
  cred: CredentialRow,
  ref: Ref,
): Promise<'done' | 'held' | 'refused'> {
  const db = ctx.env.DB;
  if (!ref.oldKey) return 'done';
  if ((await keyState(db, ref.oldKey)) !== 'retiring') return 'refused';
  if (ref.deleteAfter === undefined || ctx.clock.now() < ref.deleteAfter) return 'held';
  await fanOut(ctx, cred, ref, async () => undefined, true);
  const oldPem = await pemOf(ctx, cred.id, ref.prevVersionId ?? null);
  const latest = await findCredential(db, cred.id, null);
  if (latest?.current_version_id !== ref.newVersionId) return 'refused';
  if ((await heldBy(ctx, cred, oldPem)) || (await busyIssuerRuns(db, ctx.clock.now())) > 0)
    return 'held';
  const { credentials } = await readGoogleSecret(ctx, cred.id);
  await deleteServiceAccountKey(
    managedDeps().iam(ctx.env),
    await iamToken(ctx, credentials),
    ref.oldKey,
  );
  await setKeyState(db, ref.oldKey, 'retired', ctx.clock.now());
  return 'done';
}
