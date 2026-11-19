// An org with a Google enrolment, one historical instance and its callback binding, on a shared database.
import { Hono } from 'hono';
import { denyAllStores } from '../../platform/auth.ts';
import { type AppBindings, requestContext } from '../../platform/context.ts';
import { first, run } from '../../platform/db.ts';
import { handleError } from '../../platform/error-handler.ts';
import { sha256Hex } from '../../platform/ids.ts';
import { createLogger } from '../../platform/log.ts';
import { requireCredentialRefKeyset } from '../passes/credential-keyset.ts';
import { readGoogleCallbackVerification } from './account-service.ts';
import { googleCallbackUrl } from './google-callback-binding.ts';
import { type CallbackSigningKeys, signedGoogleEvent } from './google-callback-test-kit.ts';
import { googleObjectIds } from './google-ids.ts';
import { setupWalletOfferKit } from './offers-test-fixtures.ts';
import { googleCallbackRoutes } from './routes-google-callbacks.ts';
import { seedHistoricalProviderInstance } from './runtime-historical-fixtures.ts';
import { historicalGoogleRelease } from './runtime-integration-fixtures.ts';

/** Each org configures the same default issuer, with its own HMAC key. */
export async function googleOrg(db: D1Database) {
  const f = await setupWalletOfferKit({
    google: 'configured',
    samsung: 'absent',
    holderEmail: 'holder@example.test',
    db,
  });
  const { kit, pass } = f;
  const credentialKeysetCommitment = await requireCredentialRefKeyset(kit.env.DB, kit.env);
  const account = await first<{ id: string; revision: number }>(
    kit.env.DB,
    "SELECT id, revision FROM wallet_provider_accounts WHERE org_id = ? AND mode = 'live' AND provider = 'google'",
    [pass.orgId],
  );
  if (!account) throw new Error('Missing Google fixture account.');
  const verification = await readGoogleCallbackVerification(kit.ctx, {
    orgId: pass.orgId,
    mode: 'live',
    accountId: account.id,
    accountRevision: account.revision,
    credentialKeysetCommitment,
  });
  if (!verification) throw new Error('Missing Google fixture verification.');
  const releaseId = await historicalGoogleRelease(f);
  const instanceId = kit.ctx.ids.id();
  const operationId = kit.ctx.ids.id();
  const now = kit.clock.now();
  const { classId, objectId } = await googleObjectIds(
    verification.issuerId,
    verification.objectIdHmacKey,
    { tenantId: pass.orgId, mode: 'live', releaseId, passId: pass.id, credentialGeneration: 1 },
  );
  await seedHistoricalProviderInstance(kit.env.DB, {
    id: instanceId,
    passId: pass.id,
    orgId: pass.orgId,
    mode: 'live',
    provider: 'google',
    credentialGeneration: 1,
    credentialKeysetCommitment,
    accountId: account.id,
    releaseId,
    operationId,
    now,
    upsert: { requestHash: await sha256Hex(operationId), state: 'succeeded' },
  });
  await run(
    kit.env.DB,
    `INSERT INTO wallet_google_callback_bindings
    (instance_id, account_id, class_id_hash, object_id_hash, created_at, credential_keyset_commitment)
    VALUES (?, ?, ?, ?, ?, ?)`,
    [
      instanceId,
      account.id,
      await sha256Hex(classId),
      await sha256Hex(objectId),
      now,
      credentialKeysetCommitment,
    ],
  );
  const app = new Hono<AppBindings>();
  app.use(
    '*',
    requestContext({
      stores: denyAllStores,
      clock: kit.clock,
      logger: (base) => createLogger(base, { sink: () => undefined }),
    }),
  );
  app.onError(handleError);
  app.route('/wallet/v1/google', googleCallbackRoutes);
  const callbackUrl = googleCallbackUrl(kit.ctx, account.id);
  let nonces = 0;
  return {
    f,
    kit,
    orgId: pass.orgId,
    account,
    instanceId,
    issuerId: verification.issuerId,
    classId,
    objectId,
    callbackUrl,
    /** An event for this org's ids, signed for its issuer. */
    async event(keys: CallbackSigningKeys): Promise<string> {
      return signedGoogleEvent(
        keys,
        verification.issuerId,
        {
          classId,
          objectId,
          nonce: `nonce-${account.id}-${++nonces}`,
          eventType: 'save',
          expTimeMillis: String(kit.clock.now() + 60_000),
        },
        { keyExpiration: kit.clock.now() + 60_000 },
      );
    },
    /** Posts a body to `url` as Google would, in this org's environment. */
    async post(url: string, body: string): Promise<number> {
      const response = await app.request(
        url,
        { method: 'POST', headers: { 'content-type': 'application/json' }, body },
        kit.env,
      );
      return response.status;
    },
  };
}

export type GoogleOrg = Awaited<ReturnType<typeof googleOrg>>;
