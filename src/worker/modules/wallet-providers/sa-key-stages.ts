import type { GoogleWalletCredentials } from '../../../shared/contracts/wallet-providers.ts';
import { UnavailableError } from '../../platform/errors.ts';
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
  activeGoogleCredentials,
  busyIssuerRuns,
  keyState,
  setKeyState,
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
  // Credentials saved while the new key was current (a new managed issuer, say) hold it too: put the old
  // key back on them first, and delete the new key only once nothing holds it.
  const newPem = await pemOf(ctx, cred.id, ref.newVersionId ?? null);
  await replaceKey(ctx, newPem, previous.credentials);
  if (await heldBy(ctx, newPem))
    throw new UnavailableError('A credential still holds the new key.', 'WALLET_KEY_HELD');
  await deleteServiceAccountKey(
    managedDeps().iam(ctx.env),
    await iamToken(ctx, previous.credentials),
    ref.newKey,
  );
  await setKeyState(db, ref.newKey, 'retired', ctx.clock.now());
}

/**
 * Moves every credential that holds `fromPem` onto `to`'s key, in every mode and for every owner (PassBook's
 * own credentials, managed and shared orgs): matched by the key itself, not by a link. A credential with
 * another key (an org's own upload) is left alone. `after` resumes a page walk; ids come in order.
 */
async function replaceKey(
  ctx: ServiceContext,
  fromPem: string,
  to: GoogleWalletCredentials,
  skipId?: string,
  progress?: (after: string) => Promise<void>,
  start = '',
): Promise<void> {
  let after = start;
  for (;;) {
    const page = await activeGoogleCredentials(ctx.env.DB, after, FANOUT_PAGE);
    for (const row of page) {
      if (row.id === skipId) continue;
      const own = await readGoogleSecret(ctx, row.id);
      if (own.credentials.privateKeyPem !== fromPem) continue;
      await saveSystemCredential(
        ctx,
        {
          orgId: row.org_id,
          mode: row.mode,
          current: row,
          secret: {
            ...own.credentials,
            serviceAccountEmail: to.serviceAccountEmail,
            privateKeyPem: to.privateKeyPem,
          },
        },
        row.org_id === null ? 'sa_key' : 'sa_fanout',
      );
    }
    const last = page.at(-1);
    if (!last) return;
    after = last.id;
    await progress?.(after);
  }
}

/** Fan-out after a verified switch: the old key's holders, everywhere, move to the new key. Resumable. */
export async function fanOut(
  ctx: ServiceContext,
  cred: CredentialRow,
  ref: Ref,
  patch: (p: Partial<Ref>) => Promise<void>,
): Promise<void> {
  const { credentials } = await readGoogleSecret(ctx, cred.id);
  const oldPem = await pemOf(ctx, cred.id, ref.prevVersionId ?? null);
  await replaceKey(
    ctx,
    oldPem,
    credentials,
    cred.id,
    (after) => patch({ fanoutAfter: after }),
    ref.fanoutAfter ?? '',
  );
}

/** Does any active credential, of any mode or owner, hold this key? */
async function heldBy(ctx: ServiceContext, pem: string): Promise<boolean> {
  let after = '';
  for (;;) {
    const page = await activeGoogleCredentials(ctx.env.DB, after, FANOUT_PAGE);
    for (const row of page) if ((await pemOf(ctx, row.id)) === pem) return true;
    const last = page.at(-1);
    if (!last) return false;
    after = last.id;
  }
}

/**
 * Deletes the replaced key, only when it is `retiring`, past the cooldown that outlives every cached token
 * (a token lasts an hour), after a final sweep, and when no credential (any mode, any owner) or running
 * issuer run can still use it. `held`: try again later. `refused`: the key is not one this rotation retires.
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
  const { credentials } = await readGoogleSecret(ctx, cred.id);
  const oldPem = await pemOf(ctx, cred.id, ref.prevVersionId ?? null);
  const latest = await findCredential(db, cred.id, null);
  if (latest?.current_version_id !== ref.newVersionId) return 'refused';
  await replaceKey(ctx, oldPem, credentials, cred.id);
  if ((await heldBy(ctx, oldPem)) || (await busyIssuerRuns(db, ctx.clock.now())) > 0) return 'held';
  await deleteServiceAccountKey(
    managedDeps().iam(ctx.env),
    await iamToken(ctx, credentials),
    ref.oldKey,
  );
  await setKeyState(db, ref.oldKey, 'retired', ctx.clock.now());
  return 'done';
}
