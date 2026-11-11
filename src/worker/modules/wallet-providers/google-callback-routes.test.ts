import { Hono } from 'hono';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { installKeysetTestEnv } from '../../../../test/helpers/credential-keyset.ts';
import type { GoogleWalletCredentials } from '../../../shared/contracts/wallet-providers.ts';
import { denyAllStores, type SessionAuth } from '../../platform/auth.ts';
import { type AppBindings, requestContext } from '../../platform/context.ts';
import { credentialAad, decryptSecretText, loadKekRing } from '../../platform/crypto.ts';
import { all, batch, first, run, stmt } from '../../platform/db.ts';
import { handleError } from '../../platform/error-handler.ts';
import { sha256Hex } from '../../platform/ids.ts';
import { createLogger } from '../../platform/log.ts';
import { jobCtxOf } from '../delivery/delivery-test-fixtures.ts';
import { reassignHolder } from '../holders/service.ts';
import {
  credentialRefKeysetCommitment,
  requireCredentialRefKeyset,
} from '../passes/credential-keyset.ts';

import type { Kit } from '../passes/pass-test-fixtures.ts';
import type { Pass } from '../passes/repo.ts';
import {
  configureWalletProviderAccount,
  getWalletProviderReadiness,
  readGoogleCallbackVerification,
} from './account-service.ts';
import { googleCallbackClassProjection, googleCallbackUrl } from './google-callback-binding.ts';
import { handleGoogleCallback } from './google-callback-handler.ts';
import {
  type CallbackSigningKeys,
  callbackKeyset,
  makeCallbackSigningKeys,
  signedGoogleEvent,
} from './google-callback-test-kit.ts';
import { googleObjectIds } from './google-ids.ts';
import { issueWalletOffer, listWalletOffers } from './offers.ts';
import { setupWalletOfferKit } from './offers-test-fixtures.ts';
import { providerIdentityHash } from './projection-contract.ts';
import { setWalletProvidersEnabledForTest } from './provider-policy.ts';
import { googleCallbackRoutes } from './routes-google-callbacks.ts';
import { seedHistoricalProviderInstance } from './runtime-historical-fixtures.ts';
import { historicalGoogleRelease } from './runtime-integration-fixtures.ts';

// These cases cover historical provider instances, which exist only while a provider is enabled.
beforeAll(() => {
  setWalletProvidersEnabledForTest(true);
});

let keys: CallbackSigningKeys;
const testEnv = installKeysetTestEnv();
beforeAll(async () => {
  vi.setConfig({ testTimeout: 60_000 });
  keys = await makeCallbackSigningKeys();
});
afterEach(() => vi.unstubAllGlobals());

interface OfferKit {
  kit: Kit;
  pass: Pass;
  auth: SessionAuth;
  google: GoogleWalletCredentials;
}
interface CallbackFixture {
  f: OfferKit;
  account: { id: string; revision: number };
  instance: { id: string };
  classId: string;
  objectId: string;
  credentialKeysetCommitment: string;
  credentialGeneration: number;
  releaseId: string;
  callbackUrl: string;
}

async function fixture(options: { legacyBinding?: boolean } = {}): Promise<CallbackFixture> {
  // Model a pre-existing, independently reviewed release without current publisher proof.
  const f = await setupWalletOfferKit({
    google: 'configured',
    samsung: 'absent',
    holderEmail: 'old@example.test',
    db: (await testEnv()).DB,
  });
  const credentialKeysetCommitment = await requireCredentialRefKeyset(f.kit.env.DB, f.kit.env);
  const account = await first<{ id: string; revision: number }>(
    f.kit.env.DB,
    "SELECT id, revision FROM wallet_provider_accounts WHERE org_id = ? AND mode = 'live' AND provider = 'google'",
    [f.pass.orgId],
  );
  if (!account) throw new Error('Missing Google fixture account.');
  const verification = await readGoogleCallbackVerification(f.kit.ctx, {
    orgId: f.pass.orgId,
    mode: 'live',
    accountId: account.id,
    accountRevision: account.revision,
    credentialKeysetCommitment,
  });
  if (!verification) throw new Error('Missing Google fixture verification identity.');
  const releaseId = await historicalGoogleRelease(f);
  const instance = { id: f.kit.ctx.ids.id() };
  const credentialGeneration = 1;
  const { classId, objectId } = await googleObjectIds(
    verification.issuerId,
    verification.objectIdHmacKey,
    {
      tenantId: f.pass.orgId,
      mode: 'live',
      releaseId,
      passId: f.pass.id,
      credentialGeneration,
    },
  );
  const now = f.kit.clock.now();
  const operationId = f.kit.ctx.ids.id();
  await seedHistoricalProviderInstance(f.kit.env.DB, {
    id: instance.id,
    passId: f.pass.id,
    orgId: f.pass.orgId,
    mode: 'live',
    provider: 'google',
    credentialGeneration,
    credentialKeysetCommitment,
    accountId: account.id,
    releaseId,
    operationId,
    now,
    upsert: { requestHash: await sha256Hex(operationId), state: 'succeeded' },
  });
  const binding = stmt(
    f.kit.env.DB,
    `INSERT INTO wallet_google_callback_bindings
    (instance_id, account_id, class_id_hash, object_id_hash, created_at, credential_keyset_commitment)
    VALUES (?, ?, ?, ?, ?, ?)`,
    [
      instance.id,
      account.id,
      await sha256Hex(classId),
      await sha256Hex(objectId),
      now,
      options.legacyBinding ? null : credentialKeysetCommitment,
    ],
  );
  if (options.legacyBinding) {
    // Model an already-present pre-migration row without relaxing the current insert guard.
    const trigger = await first<{ sql: string }>(
      f.kit.env.DB,
      "SELECT sql FROM sqlite_master WHERE type = 'trigger' AND name = 'wallet_provider_generation_google_binding'",
    );
    if (!trigger?.sql) throw new Error('Missing Google binding insert guard.');
    await batch(f.kit.env.DB, [
      stmt(f.kit.env.DB, 'DROP TRIGGER wallet_provider_generation_google_binding'),
      binding,
      stmt(f.kit.env.DB, trigger.sql),
    ]);
  } else {
    await binding.run();
  }
  return {
    f,
    account,
    instance,
    releaseId,
    classId,
    objectId,
    credentialGeneration,
    credentialKeysetCommitment,
    callbackUrl: googleCallbackUrl(f.kit.ctx, account.id),
  };
}

function callbackApp(f: OfferKit, logs: string[] = []) {
  const app = new Hono<AppBindings>();
  app.use(
    '*',
    requestContext({
      stores: denyAllStores,
      clock: f.kit.clock,
      logger: (base) => createLogger(base, { sink: (line) => logs.push(line) }),
    }),
  );
  app.onError(handleError);
  app.route('/wallet/v1/google', googleCallbackRoutes);
  return app;
}

function rawEvent(f: CallbackFixture, nonce: string, eventType: 'save' | 'del' = 'save') {
  return {
    classId: f.classId,
    objectId: f.objectId,
    nonce,
    eventType,
    expTimeMillis: String(f.f.kit.clock.now() + 60_000),
    holderName: 'Private Holder',
    opaqueToken: 'secret-token-value',
  };
}

async function eventBody(
  f: CallbackFixture,
  event: Record<string, unknown>,
  options: { recipient?: string; rootSigner?: CryptoKeyPair; messageSigner?: CryptoKeyPair } = {},
) {
  return signedGoogleEvent(keys, f.f.google.issuerId, event, {
    keyExpiration: f.f.kit.clock.now() + 60_000,
    ...options,
  });
}

/** Model an administrative recovery without weakening production immutability triggers. */
async function replaceKeysetForTest(db: D1Database, value: string | null): Promise<void> {
  const name =
    value === null ? 'credential_ref_keyset_no_delete' : 'credential_ref_keyset_no_update';
  const trigger = await first<{ sql: string }>(
    db,
    "SELECT sql FROM sqlite_master WHERE type = 'trigger' AND name = ?",
    [name],
  );
  if (!trigger?.sql) throw new Error('Missing keyset immutability trigger.');
  await batch(db, [
    stmt(db, `DROP TRIGGER ${name}`),
    value === null
      ? stmt(db, 'DELETE FROM credential_ref_keyset WHERE id = 1')
      : stmt(db, 'UPDATE credential_ref_keyset SET commitment = ? WHERE id = 1', [value]),
    stmt(db, trigger.sql),
  ]);
}

function interceptReceiptBatch(
  db: D1Database,
  before: (db: D1Database) => Promise<void>,
): D1Database {
  let injected = false;
  return new Proxy(db, {
    get(target, property) {
      if (property === 'batch')
        return async (statements: D1PreparedStatement[]) => {
          if (!injected) {
            injected = true;
            await before(target);
          }
          return target.batch(statements);
        };
      const value = Reflect.get(target, property, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}

function interceptReceiptOutput(
  db: D1Database,
  before: (db: D1Database) => Promise<void>,
): D1Database {
  let injected = false;
  return new Proxy(db, {
    get(target, property) {
      if (property === 'prepare')
        return (sql: string) => {
          const prepared = target.prepare(sql);
          if (!sql.includes('JOIN wallet_google_callback_receipts receipt')) return prepared;
          return new Proxy(prepared, {
            get(statement, method) {
              if (method === 'bind')
                return (...values: unknown[]) => {
                  const bound = statement.bind(...values);
                  return new Proxy(bound, {
                    get(query, action) {
                      if (action === 'first')
                        return async () => {
                          if (!injected) {
                            injected = true;
                            await before(target);
                          }
                          return query.first();
                        };
                      const value = Reflect.get(query, action, query);
                      return typeof value === 'function' ? value.bind(query) : value;
                    },
                  });
                };
              const value = Reflect.get(statement, method, statement);
              return typeof value === 'function' ? value.bind(statement) : value;
            },
          });
        };
      const value = Reflect.get(target, property, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}

async function expectNoCallbackWrites(f: CallbackFixture): Promise<void> {
  expect(
    await all(
      f.f.kit.env.DB,
      'SELECT id FROM wallet_google_callback_receipts WHERE account_id = ?',
      [f.account.id],
    ),
  ).toEqual([]);
  expect(
    await all(
      f.f.kit.env.DB,
      'SELECT claim_id FROM wallet_google_callback_replays WHERE account_id = ?',
      [f.account.id],
    ),
  ).toEqual([]);
}

describe('Google Wallet callbacks', () => {
  it('encrypts signed historical receipts, rejects duplicate delivery, and leaves installation unknown', async () => {
    const f = await fixture();
    const logs: string[] = [];
    const app = callbackApp(f.f, logs);
    vi.stubGlobal('fetch', async () =>
      Response.json(await callbackKeyset(keys.root, f.f.kit.clock.now() + 60_000)),
    );
    expect(f.callbackUrl).toBe(`https://passbook.mobile/wallet/v1/google/${f.account.id}`);
    expect(
      await getWalletProviderReadiness(f.f.kit.ctx, {
        orgId: f.f.pass.orgId,
        mode: 'live',
        provider: 'google',
      }),
    ).toMatchObject({ state: 'configured', externalApprovalVerified: false });
    const body = await eventBody(f, rawEvent(f, 'nonce-private-1'));
    const send = (value: string) =>
      app.request(
        f.callbackUrl,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'user-agent': 'Google-Valuables' },
          body: value,
        },
        f.f.kit.env,
      );
    const responses = await Promise.all([send(body), send(body)]);
    expect(responses.map((response) => response.status).sort()).toEqual([204, 401].sort());
    expect(
      responses.find((response) => response.status === 204)?.headers.get('cache-control'),
    ).toContain('no-store');
    const receipt = await first<{
      id: string;
      instance_id: string;
      org_id: string;
      mode: string;
      event_type: string;
      nonce_hash: string;
      kek_version: number;
      iv: number[];
      wrapped_dek: number[];
      ciphertext: number[];
    }>(f.f.kit.env.DB, 'SELECT * FROM wallet_google_callback_receipts WHERE instance_id = ?', [
      f.instance.id,
    ]);
    expect(receipt).toMatchObject({
      instance_id: f.instance.id,
      org_id: f.f.pass.orgId,
      mode: 'live',
      event_type: 'save',
    });
    expect(receipt!.nonce_hash).toMatch(/^[a-f0-9]{64}$/);
    expect(JSON.stringify(receipt)).not.toContain('Private Holder');
    expect(JSON.stringify(receipt)).not.toContain('nonce-private-1');
    expect(JSON.stringify(receipt)).not.toContain('secret-token-value');
    const plaintext = await decryptSecretText(
      await loadKekRing(f.f.kit.env),
      {
        kekVersion: receipt!.kek_version,
        iv: new Uint8Array(receipt!.iv),
        wrappedDek: new Uint8Array(receipt!.wrapped_dek),
        ciphertext: new Uint8Array(receipt!.ciphertext),
      },
      credentialAad(
        receipt!.id,
        receipt!.org_id,
        `google-callback|${receipt!.mode}|${receipt!.instance_id}`,
      ),
    );
    expect(plaintext).toBe(body);
    // Replay reservation is independent of the raw receipt, which can be removed on retirement.
    await run(f.f.kit.env.DB, 'DELETE FROM wallet_google_callback_receipts WHERE id = ?', [
      receipt!.id,
    ]);
    expect((await send(body)).status).toBe(401);
    const reusedNonce = await eventBody(f, rawEvent(f, 'nonce-private-1', 'del'));
    expect((await send(reusedNonce)).status).toBe(401);
    const deleted = await eventBody(f, rawEvent(f, 'nonce-private-2', 'del'));
    expect((await send(deleted)).status).toBe(204);
    expect(
      await all(
        f.f.kit.env.DB,
        'SELECT event_type FROM wallet_google_callback_receipts WHERE instance_id = ?',
        [f.instance.id],
      ),
    ).toEqual([{ event_type: 'del' }]);
    expect(await listWalletOffers(f.f.kit.ctx, f.f.pass.id)).toEqual([]);
    const state = await first<{
      installation_state: string;
      installation_observed_at: number | null;
    }>(
      f.f.kit.env.DB,
      'SELECT installation_state, installation_observed_at FROM wallet_provider_instances WHERE id = ?',
      [f.instance.id],
    );
    expect(state).toEqual({ installation_state: 'unknown', installation_observed_at: null });
    expect(logs.join('\n')).not.toContain('Private Holder');
    expect(logs.join('\n')).not.toContain('secret-token-value');
    expect(logs.join('\n')).not.toContain('nonce-private-1');
  });

  it('uses the captured KEK ring for receipt encryption if a newer version appears mid-callback', async () => {
    const f = await fixture();
    const initialRing = await loadKekRing(f.f.kit.env);
    const env = { ...f.f.kit.env };
    const body = await eventBody(f, rawEvent(f, 'new-kek-during-callback'));
    const ctx = {
      ...f.f.kit.ctx,
      env,
      ids: {
        ...f.f.kit.ctx.ids,
        id: () => {
          Object.assign(env, { [`KEK_V${initialRing.current + 1}`]: btoa('n'.repeat(32)) });
          return f.f.kit.ctx.ids.id();
        },
      },
    };
    vi.stubGlobal('fetch', async () =>
      Response.json(await callbackKeyset(keys.root, f.f.kit.clock.now() + 60_000)),
    );
    await expect(
      handleGoogleCallback(ctx, new Request(f.callbackUrl, { method: 'POST', body }), f.account.id),
    ).resolves.toBeUndefined();
    expect((await loadKekRing(env)).current).toBe(initialRing.current + 1);
    expect(
      await first(
        f.f.kit.env.DB,
        'SELECT kek_version FROM wallet_google_callback_receipts WHERE instance_id = ?',
        [f.instance.id],
      ),
    ).toEqual({ kek_version: initialRing.current });
  });

  it('re-derives the original class and object even if a lookup row is tampered with', async () => {
    const f = await fixture();
    const row = await first<{ class_id_hash: string; object_id_hash: string }>(
      f.f.kit.env.DB,
      'SELECT class_id_hash, object_id_hash FROM wallet_google_callback_bindings WHERE instance_id = ?',
      [f.instance.id],
    );
    expect(row?.class_id_hash).toBe(await sha256Hex(f.classId));
    expect(row?.object_id_hash).toBe(await sha256Hex(f.objectId));
    const verification = await readGoogleCallbackVerification(f.f.kit.ctx, {
      orgId: f.f.pass.orgId,
      mode: 'live',
      accountId: f.account.id,
      accountRevision: f.account.revision,
      credentialKeysetCommitment: f.credentialKeysetCommitment,
    });
    if (!verification) throw new Error('Missing Google fixture verification identity.');
    const replacement = await googleObjectIds(verification.issuerId, verification.objectIdHmacKey, {
      tenantId: f.f.pass.orgId,
      mode: 'live',
      releaseId: f.releaseId,
      passId: f.f.pass.id,
      credentialGeneration: f.credentialGeneration + 1,
    });
    expect(replacement.classId).toBe(f.classId);
    expect(replacement.objectId).not.toBe(f.objectId);
    const wrongClass = `${f.f.google.issuerId}.c_${'z'.repeat(43)}`;
    await run(
      f.f.kit.env.DB,
      'UPDATE wallet_google_callback_bindings SET class_id_hash = ? WHERE instance_id = ?',
      [await sha256Hex(wrongClass), f.instance.id],
    );
    vi.stubGlobal('fetch', async () =>
      Response.json(await callbackKeyset(keys.root, f.f.kit.clock.now() + 60_000)),
    );
    const body = await eventBody(f, { ...rawEvent(f, 'nonce-tampered'), classId: wrongClass });
    const response = await callbackApp(f.f).request(
      f.callbackUrl,
      { method: 'POST', body },
      f.f.kit.env,
    );
    expect(response.status).toBe(401);
    expect(
      await all(
        f.f.kit.env.DB,
        'SELECT id FROM wallet_google_callback_receipts WHERE instance_id = ?',
        [f.instance.id],
      ),
    ).toEqual([]);
  });

  it('rejects a signed callback for a different generation even if the lookup hash is corrupted', async () => {
    const f = await fixture();
    const verification = await readGoogleCallbackVerification(f.f.kit.ctx, {
      orgId: f.f.pass.orgId,
      mode: 'live',
      accountId: f.account.id,
      accountRevision: f.account.revision,
      credentialKeysetCommitment: f.credentialKeysetCommitment,
    });
    if (!verification) throw new Error('Missing Google fixture verification identity.');
    const next = await googleObjectIds(verification.issuerId, verification.objectIdHmacKey, {
      tenantId: f.f.pass.orgId,
      mode: 'live',
      releaseId: f.releaseId,
      passId: f.f.pass.id,
      credentialGeneration: f.credentialGeneration + 1,
    });
    await run(
      f.f.kit.env.DB,
      'UPDATE wallet_google_callback_bindings SET object_id_hash = ? WHERE instance_id = ?',
      [await sha256Hex(next.objectId), f.instance.id],
    );
    vi.stubGlobal('fetch', async () =>
      Response.json(await callbackKeyset(keys.root, f.f.kit.clock.now() + 60_000)),
    );
    const body = await eventBody(f, {
      ...rawEvent(f, 'nonce-other-generation'),
      objectId: next.objectId,
    });
    expect(
      (await callbackApp(f.f).request(f.callbackUrl, { method: 'POST', body }, f.f.kit.env)).status,
    ).toBe(401);
    expect(
      await all(
        f.f.kit.env.DB,
        'SELECT id FROM wallet_google_callback_receipts WHERE instance_id = ?',
        [f.instance.id],
      ),
    ).toEqual([]);
    expect(
      await all(
        f.f.kit.env.DB,
        'SELECT claim_id FROM wallet_google_callback_replays WHERE account_id = ?',
        [f.account.id],
      ),
    ).toEqual([]);
  });

  it('keeps a signed old callback on the old incarnation during a pending holder transfer', async () => {
    const f = await fixture();
    const result = await reassignHolder(
      jobCtxOf(f.f.kit),
      { type: 'system', id: null },
      { passId: f.f.pass.id, email: 'new@example.test' },
      null,
    );
    expect(result.transfer).toMatchObject({ state: 'pending' });
    const replacement = await first<{ id: string; lifecycle: string; account_id: string | null }>(
      f.f.kit.env.DB,
      `SELECT id, lifecycle, account_id FROM wallet_provider_instances
       WHERE pass_id = ? AND provider = 'google' AND credential_generation = ?`,
      [f.f.pass.id, f.credentialGeneration + 1],
    );
    expect(replacement).toMatchObject({ lifecycle: 'blocked', account_id: null });
    expect(replacement?.id).not.toBe(f.instance.id);
    vi.stubGlobal('fetch', async () =>
      Response.json(await callbackKeyset(keys.root, f.f.kit.clock.now() + 60_000)),
    );
    const app = callbackApp(f.f);
    const body = await eventBody(f, rawEvent(f, 'nonce-old-holder'));
    expect((await app.request(f.callbackUrl, { method: 'POST', body }, f.f.kit.env)).status).toBe(
      204,
    );
    expect(
      await all(
        f.f.kit.env.DB,
        'SELECT instance_id FROM wallet_google_callback_receipts WHERE account_id = ?',
        [f.account.id],
      ),
    ).toEqual([{ instance_id: f.instance.id }]);
    // The stored provider identity itself cannot be rebound to the blocked successor.
    await expect(
      run(
        f.f.kit.env.DB,
        'UPDATE wallet_google_callback_bindings SET instance_id = ? WHERE instance_id = ?',
        [replacement!.id, f.instance.id],
      ),
    ).rejects.toThrow('provider artifact identity is immutable');
    const replay = await eventBody(f, rawEvent(f, 'nonce-attempted-rebind'));
    expect(
      (await app.request(f.callbackUrl, { method: 'POST', body: replay }, f.f.kit.env)).status,
    ).toBe(204);
    expect(
      await all(
        f.f.kit.env.DB,
        'SELECT id FROM wallet_google_callback_receipts WHERE instance_id = ?',
        [replacement!.id],
      ),
    ).toEqual([]);
    expect(await listWalletOffers(f.f.kit.ctx, f.f.pass.id)).toEqual([]);
  }, 120_000);

  it('rejects correctly signed wrong class, object and cross-tenant or issuer binding', async () => {
    const f = await fixture();
    const foreign = await fixture(); // Same issuer, different tenant/account and opaque identities.
    const app = callbackApp(f.f);
    vi.stubGlobal('fetch', async () =>
      Response.json(await callbackKeyset(keys.root, f.f.kit.clock.now() + 60_000)),
    );
    const base = rawEvent(f, 'nonce-mismatch');
    const cases = [
      await eventBody(f, { ...base, classId: `${f.f.google.issuerId}.c_${'z'.repeat(43)}` }),
      await eventBody(f, { ...base, objectId: `${f.f.google.issuerId}.o_${'z'.repeat(43)}` }),
      await eventBody(f, base, { recipient: '12345' }),
      await eventBody(f, base, { messageSigner: keys.other }),
    ];
    for (const body of cases) {
      const response = await app.request(f.callbackUrl, { method: 'POST', body }, f.f.kit.env);
      expect(response.status).toBe(401);
    }
    const crossTenant = await eventBody(f, base);
    expect(
      (
        await app.request(
          foreign.callbackUrl,
          { method: 'POST', body: crossTenant },
          foreign.f.kit.env,
        )
      ).status,
    ).toBe(401);
    expect(
      await all(
        f.f.kit.env.DB,
        'SELECT id FROM wallet_google_callback_receipts WHERE instance_id = ?',
        [f.instance.id],
      ),
    ).toEqual([]);
    expect(
      await all(
        f.f.kit.env.DB,
        'SELECT id FROM wallet_google_callback_receipts WHERE instance_id = ?',
        [foreign.instance.id],
      ),
    ).toEqual([]);
  });

  it('fences account revision again after key retrieval and stores nothing if credentials rotate', async () => {
    const f = await fixture();
    const app = callbackApp(f.f);
    const body = await eventBody(f, rawEvent(f, 'nonce-race'));
    vi.stubGlobal('fetch', async () => {
      await configureWalletProviderAccount(f.f.kit.ctx, f.f.auth, {
        orgId: f.f.pass.orgId,
        mode: 'live',
        provider: 'google',
        expectedRevision: f.account.revision,
        credentials: f.f.google,
      });
      return Response.json(await callbackKeyset(keys.root, f.f.kit.clock.now() + 60_000));
    });
    expect((await app.request(f.callbackUrl, { method: 'POST', body }, f.f.kit.env)).status).toBe(
      401,
    );
    expect(
      await all(
        f.f.kit.env.DB,
        'SELECT id FROM wallet_google_callback_receipts WHERE account_id = ?',
        [f.account.id],
      ),
    ).toEqual([]);
    expect(
      await all(
        f.f.kit.env.DB,
        'SELECT claim_id FROM wallet_google_callback_replays WHERE account_id = ?',
        [f.account.id],
      ),
    ).toEqual([]);
    // A fresh delivery uses the newly current account; the opaque-ID key survives rotation.
    vi.stubGlobal('fetch', async () =>
      Response.json(await callbackKeyset(keys.root, f.f.kit.clock.now() + 60_000)),
    );
    expect((await app.request(f.callbackUrl, { method: 'POST', body }, f.f.kit.env)).status).toBe(
      204,
    );
  });

  it('reports a missing keyset as unavailable without initializing or recording a callback', async () => {
    const f = await fixture();
    const body = await eventBody(f, rawEvent(f, 'missing-keyset'));
    await replaceKeysetForTest(f.f.kit.env.DB, null);
    const fetcher = vi.fn();
    vi.stubGlobal('fetch', fetcher);
    const response = await callbackApp(f.f).request(
      f.callbackUrl,
      { method: 'POST', body },
      f.f.kit.env,
    );
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ code: 'GOOGLE_CALLBACK_UNAVAILABLE' });
    expect(fetcher).not.toHaveBeenCalled();
    expect(await first(f.f.kit.env.DB, 'SELECT id FROM credential_ref_keyset')).toBeNull();
    await expectNoCallbackWrites(f);
  });

  it('does not adopt a changed oldest KEK or a subsequently replaced keyset for an existing binding', async () => {
    const f = await fixture();
    const app = callbackApp(f.f);
    const body = await eventBody(f, rawEvent(f, 'changed-oldest-key'));
    const changedEnv = { ...f.f.kit.env, KEK_V0: btoa('x'.repeat(32)) };
    const changedCommitment = await credentialRefKeysetCommitment(changedEnv);
    expect(changedCommitment).not.toBe(f.credentialKeysetCommitment);
    vi.stubGlobal('fetch', async () =>
      Response.json(await callbackKeyset(keys.root, f.f.kit.clock.now() + 60_000)),
    );
    expect((await app.request(f.callbackUrl, { method: 'POST', body }, changedEnv)).status).toBe(
      503,
    );
    await expectNoCallbackWrites(f);

    // Even an audited replacement of the singleton cannot adopt a new proof for this old identity.
    await replaceKeysetForTest(f.f.kit.env.DB, changedCommitment);
    const response = await app.request(f.callbackUrl, { method: 'POST', body }, changedEnv);
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ code: 'GOOGLE_CALLBACK_UNAVAILABLE' });
    await expectNoCallbackWrites(f);
    expect(
      await all(
        f.f.kit.env.DB,
        `SELECT instance_id, class_id_hash, object_id_hash, credential_keyset_commitment
       FROM wallet_google_callback_bindings WHERE account_id = ?`,
        [f.account.id],
      ),
    ).toEqual([
      {
        instance_id: f.instance.id,
        class_id_hash: await sha256Hex(f.classId),
        object_id_hash: await sha256Hex(f.objectId),
        credential_keyset_commitment: f.credentialKeysetCommitment,
      },
    ]);

    await replaceKeysetForTest(f.f.kit.env.DB, f.credentialKeysetCommitment);
    expect((await app.request(f.callbackUrl, { method: 'POST', body }, f.f.kit.env)).status).toBe(
      204,
    );
  });

  it('does not authorize a historical binding with no original keyset proof', async () => {
    const f = await fixture({ legacyBinding: true });
    const body = await eventBody(f, rawEvent(f, 'legacy-no-proof'));
    vi.stubGlobal('fetch', async () =>
      Response.json(await callbackKeyset(keys.root, f.f.kit.clock.now() + 60_000)),
    );
    const response = await callbackApp(f.f).request(
      f.callbackUrl,
      { method: 'POST', body },
      f.f.kit.env,
    );
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ code: 'GOOGLE_CALLBACK_UNAVAILABLE' });
    await expectNoCallbackWrites(f);
  });

  it('does not authorize a binding when its historical instance has no original proof', async () => {
    const f = await fixture();
    const db = f.f.kit.env.DB;
    const trigger = await first<{ sql: string }>(
      db,
      "SELECT sql FROM sqlite_master WHERE type = 'trigger' AND name = 'wallet_provider_instance_keyset_immutable'",
    );
    if (!trigger?.sql) throw new Error('Missing instance keyset immutability trigger.');
    await batch(db, [
      stmt(db, 'DROP TRIGGER wallet_provider_instance_keyset_immutable'),
      stmt(
        db,
        'UPDATE wallet_provider_instances SET credential_keyset_commitment = NULL WHERE id = ?',
        [f.instance.id],
      ),
      stmt(db, trigger.sql),
    ]);
    const body = await eventBody(f, rawEvent(f, 'legacy-instance-no-proof'));
    vi.stubGlobal('fetch', async () =>
      Response.json(await callbackKeyset(keys.root, f.f.kit.clock.now() + 60_000)),
    );
    const response = await callbackApp(f.f).request(
      f.callbackUrl,
      { method: 'POST', body },
      f.f.kit.env,
    );
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ code: 'GOOGLE_CALLBACK_UNAVAILABLE' });
    await expectNoCallbackWrites(f);
  });

  it('rejects a keyset replaced after opening the account even when the replacement also matches the environment', async () => {
    const f = await fixture();
    const body = await eventBody(f, rawEvent(f, 'keyset-after-account'));
    const env = { ...f.f.kit.env, KEK_V0: '' };
    vi.stubGlobal('fetch', async () => {
      env.KEK_V0 = btoa('r'.repeat(32));
      await replaceKeysetForTest(f.f.kit.env.DB, await credentialRefKeysetCommitment(env));
      return Response.json(await callbackKeyset(keys.root, f.f.kit.clock.now() + 60_000));
    });
    const app = callbackApp(f.f);
    const response = await app.request(f.callbackUrl, { method: 'POST', body }, env);
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ code: 'GOOGLE_CALLBACK_UNAVAILABLE' });
    await expectNoCallbackWrites(f);
    await replaceKeysetForTest(f.f.kit.env.DB, f.credentialKeysetCommitment);
    vi.stubGlobal('fetch', async () =>
      Response.json(await callbackKeyset(keys.root, f.f.kit.clock.now() + 60_000)),
    );
    expect((await app.request(f.callbackUrl, { method: 'POST', body }, f.f.kit.env)).status).toBe(
      204,
    );
  });

  it('pins the original keyset at the replay and receipt transaction boundary', async () => {
    const f = await fixture();
    const body = await eventBody(f, rawEvent(f, 'keyset-before-receipt'));
    const env = { ...f.f.kit.env, KEK_V0: '' };
    env.DB = interceptReceiptBatch(env.DB, async (db) => {
      env.KEK_V0 = btoa('q'.repeat(32));
      await replaceKeysetForTest(db, await credentialRefKeysetCommitment(env));
    });
    vi.stubGlobal('fetch', async () =>
      Response.json(await callbackKeyset(keys.root, f.f.kit.clock.now() + 60_000)),
    );
    const app = callbackApp(f.f);
    const response = await app.request(f.callbackUrl, { method: 'POST', body }, env);
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ code: 'GOOGLE_CALLBACK_UNAVAILABLE' });
    await expectNoCallbackWrites(f);
    await replaceKeysetForTest(f.f.kit.env.DB, f.credentialKeysetCommitment);
    expect((await app.request(f.callbackUrl, { method: 'POST', body }, f.f.kit.env)).status).toBe(
      204,
    );
  });

  it('rechecks the exact binding in the replay and receipt transaction', async () => {
    const f = await fixture();
    const body = await eventBody(f, rawEvent(f, 'binding-before-receipt'));
    const originalHash = await sha256Hex(f.classId);
    const changedHash = (originalHash === 'f'.repeat(64) ? 'e' : 'f').repeat(64);
    const env = {
      ...f.f.kit.env,
      DB: interceptReceiptBatch(f.f.kit.env.DB, async (db) => {
        await run(
          db,
          'UPDATE wallet_google_callback_bindings SET class_id_hash = ? WHERE instance_id = ?',
          [changedHash, f.instance.id],
        );
      }),
    };
    vi.stubGlobal('fetch', async () =>
      Response.json(await callbackKeyset(keys.root, f.f.kit.clock.now() + 60_000)),
    );
    const app = callbackApp(f.f);
    expect((await app.request(f.callbackUrl, { method: 'POST', body }, env)).status).toBe(401);
    await expectNoCallbackWrites(f);
    await run(
      f.f.kit.env.DB,
      'UPDATE wallet_google_callback_bindings SET class_id_hash = ? WHERE instance_id = ?',
      [originalHash, f.instance.id],
    );
    expect((await app.request(f.callbackUrl, { method: 'POST', body }, f.f.kit.env)).status).toBe(
      204,
    );
  });

  it('fences the success acknowledgement against a keyset replacement after the receipt commits', async () => {
    const f = await fixture();
    const body = await eventBody(f, rawEvent(f, 'keyset-before-acknowledgement'));
    const env = { ...f.f.kit.env, KEK_V0: '' };
    env.DB = interceptReceiptOutput(env.DB, async (db) => {
      env.KEK_V0 = btoa('s'.repeat(32));
      await replaceKeysetForTest(db, await credentialRefKeysetCommitment(env));
    });
    vi.stubGlobal('fetch', async () =>
      Response.json(await callbackKeyset(keys.root, f.f.kit.clock.now() + 60_000)),
    );
    const response = await callbackApp(f.f).request(f.callbackUrl, { method: 'POST', body }, env);
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ code: 'GOOGLE_CALLBACK_UNAVAILABLE' });
    // The receipt and replay committed while the original proof was still current.
    const receipt = await first<{ id: string }>(
      f.f.kit.env.DB,
      'SELECT id FROM wallet_google_callback_receipts WHERE account_id = ?',
      [f.account.id],
    );
    expect(receipt).not.toBeNull();
    expect(
      await first(
        f.f.kit.env.DB,
        'SELECT claim_id FROM wallet_google_callback_replays WHERE account_id = ?',
        [f.account.id],
      ),
    ).toEqual({ claim_id: receipt!.id });
  });

  it('fences the success acknowledgement against a binding change after the receipt commits', async () => {
    const f = await fixture();
    const body = await eventBody(f, rawEvent(f, 'binding-before-acknowledgement'));
    const originalHash = await sha256Hex(f.classId);
    const changedHash = (originalHash === 'f'.repeat(64) ? 'e' : 'f').repeat(64);
    const env = {
      ...f.f.kit.env,
      DB: interceptReceiptOutput(f.f.kit.env.DB, async (db) => {
        await run(
          db,
          'UPDATE wallet_google_callback_bindings SET class_id_hash = ? WHERE instance_id = ?',
          [changedHash, f.instance.id],
        );
      }),
    };
    vi.stubGlobal('fetch', async () =>
      Response.json(await callbackKeyset(keys.root, f.f.kit.clock.now() + 60_000)),
    );
    const response = await callbackApp(f.f).request(f.callbackUrl, { method: 'POST', body }, env);
    expect(response.status).toBe(401);
    const receipt = await first<{ id: string }>(
      f.f.kit.env.DB,
      'SELECT id FROM wallet_google_callback_receipts WHERE account_id = ?',
      [f.account.id],
    );
    expect(receipt).not.toBeNull();
    expect(
      await first(
        f.f.kit.env.DB,
        'SELECT claim_id FROM wallet_google_callback_replays WHERE account_id = ?',
        [f.account.id],
      ),
    ).toEqual({ claim_id: receipt!.id });
  });

  it('fails closed when the canonical origin is not HTTPS or publishing has no provider proof', async () => {
    const f = await fixture();
    const scope = {
      orgId: f.f.pass.orgId,
      mode: 'live' as const,
      accountId: f.account.id,
      accountRevision: f.account.revision,
      providerReleaseId: f.releaseId,
      providerIdentityHash: await providerIdentityHash({
        provider: 'google',
        credentials: f.f.google,
      }),
      credentialKeysetCommitment: f.credentialKeysetCommitment,
    };
    const binding = {
      instanceId: f.instance.id,
      passId: f.f.pass.id,
      releaseId: f.releaseId,
      operationVersion: 1,
      credentialGeneration: f.credentialGeneration,
    };
    await expect(googleCallbackClassProjection(f.f.kit.ctx, scope, binding)).rejects.toMatchObject({
      code: 'account_unavailable',
    });
    const otherCommitment = (f.credentialKeysetCommitment === 'f'.repeat(64) ? 'e' : 'f').repeat(
      64,
    );
    await expect(
      googleCallbackClassProjection(
        f.f.kit.ctx,
        { ...scope, credentialKeysetCommitment: otherCommitment },
        binding,
      ),
    ).rejects.toMatchObject({ code: 'account_unavailable' });
    f.f.kit.env.PUBLIC_BASE_URL = 'http://insecure.example';
    await expect(googleCallbackClassProjection(f.f.kit.ctx, scope, binding)).rejects.toMatchObject({
      code: 'account_unavailable',
    });
    await expect(
      issueWalletOffer(f.f.kit.ctx, f.f.pass.downloadToken, 'google'),
    ).rejects.toMatchObject({ status: 404 });
  });

  it('rate-limits Google callbacks by IP before fetching the provider keyset', async () => {
    const f = await fixture();
    const limit = vi.fn(async () => ({ success: false }));
    f.f.kit.env.RL_APPLE_IP = { limit } as unknown as RateLimit;
    const fetcher = vi.fn();
    vi.stubGlobal('fetch', fetcher);
    const response = await callbackApp(f.f).request(
      f.callbackUrl,
      {
        method: 'POST',
        headers: { 'cf-connecting-ip': '198.51.100.9' },
        body: '{}',
      },
      f.f.kit.env,
    );
    expect(response.status).toBe(429);
    expect(limit).toHaveBeenCalledWith({ key: 'RL_APPLE_IP:google:198.51.100.9' });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('does not log or return provider failures containing private data', async () => {
    const f = await fixture();
    const logs: string[] = [];
    const app = callbackApp(f.f, logs);
    const body = await eventBody(f, rawEvent(f, 'private-nonce'));
    vi.stubGlobal('fetch', async () => {
      throw new Error('provider-secret-token Private Holder');
    });
    const response = await app.request(f.callbackUrl, { method: 'POST', body }, f.f.kit.env);
    expect(response.status).toBe(503);
    expect(await response.text()).not.toContain('provider-secret-token');
    expect(logs.join('\n')).not.toContain('provider-secret-token');
    expect(logs.join('\n')).not.toContain('Private Holder');
    expect(logs.join('\n')).not.toContain('private-nonce');
  });
});
