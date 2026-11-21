import type { ServiceContext } from '../../platform/service-context.ts';
import { readGoogleSecret, saveSystemCredential } from './credential-system-save.ts';
import { validateGoogleAccount } from './google-credentials.ts';
import { GoogleWalletError } from './google-errors.ts';
import { deleteServiceAccountKey } from './google-iam.ts';
import { getGoogleIssuer } from './google-issuer-rest.ts';
import { managedDeps } from './google-managed-deps.ts';
import { getGoogleAccessToken } from './google-oauth.ts';
import { type CredentialRow, findCredential } from './repo-credentials.ts';
import { markKeyDeleted, signedBy } from './repo-google-managed.ts';
import { iamToken } from './sa-key-access.ts';
import type { Ref } from './sa-key-rotation.ts';

const FANOUT_PAGE = 50;
const VERIFY_TRIES = 3;
const VERIFY_WAIT_MS = 3000;

/** A token exchange with the new key and a read of the platform issuer. Three tries: a new key needs a moment. */
export async function verifyOrRollback(
  ctx: ServiceContext,
  cred: CredentialRow,
  ref: Ref,
): Promise<boolean> {
  const secret = await readGoogleSecret(ctx, cred.id);
  for (let attempt = 0; attempt < VERIFY_TRIES; attempt++) {
    try {
      const { accessToken } = await getGoogleAccessToken(
        await validateGoogleAccount(secret.credentials),
        {
          issuedAt: Math.floor(ctx.clock.now() / 1000),
          fetcher: managedDeps().fetcher(),
        },
      );
      await getGoogleIssuer(
        { accessToken, fetcher: managedDeps().fetcher() },
        secret.credentials.issuerId,
      );
      return true;
    } catch (error) {
      if (!(error instanceof GoogleWalletError)) throw error;
      if (attempt < VERIFY_TRIES - 1) await managedDeps().wait(VERIFY_WAIT_MS);
    }
  }
  await rollback(ctx, cred, ref);
  return false;
}

/** Writes the replaced version back as the newest and deletes the new key. The old key was never deleted. */
async function rollback(ctx: ServiceContext, cred: CredentialRow, ref: Ref): Promise<void> {
  if (!ref.prevVersionId || !ref.newKey) return;
  const previous = await readGoogleSecret(ctx, cred.id, ref.prevVersionId);
  const latest = await findCredential(ctx.env.DB, cred.id, null);
  if (!latest) return;
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
  const iam = managedDeps().iam(ctx.env);
  await deleteServiceAccountKey(iam, await iamToken(ctx, previous.credentials), ref.newKey);
  await markKeyDeleted(ctx.env.DB, ref.newKey, ctx.clock.now());
}

/** A new version for every credential signing with this key, 50 at a time; a rerun skips the done ones. */
export async function fanOut(
  ctx: ServiceContext,
  cred: CredentialRow,
  ref: Ref,
  patch: (p: Partial<Ref>) => Promise<void>,
): Promise<void> {
  const { credentials } = await readGoogleSecret(ctx, cred.id);
  let after = ref.fanoutAfter ?? '';
  for (;;) {
    const page = await signedBy(ctx.env.DB, cred.id, after, FANOUT_PAGE);
    for (const row of page) {
      const own = await readGoogleSecret(ctx, row.id);
      if (own.credentials.privateKeyPem === credentials.privateKeyPem) continue;
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
        'sa_fanout',
      );
    }
    const last = page.at(-1);
    if (!last) return;
    after = last.id;
    await patch({ fanoutAfter: after });
  }
}

/** Deletes the replaced key. Gone already (404) counts as done; the inventory row is closed either way. */
export async function retireOld(ctx: ServiceContext, cred: CredentialRow, ref: Ref): Promise<void> {
  if (!ref.oldKey) return;
  const { credentials } = await readGoogleSecret(ctx, cred.id);
  await deleteServiceAccountKey(
    managedDeps().iam(ctx.env),
    await iamToken(ctx, credentials),
    ref.oldKey,
  );
  await markKeyDeleted(ctx.env.DB, ref.oldKey, ctx.clock.now());
}
