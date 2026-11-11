import type { OpenAPIHono } from '@hono/zod-openapi';
import * as asn1 from 'asn1js';
import * as pki from 'pkijs';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  type Fixtures,
  fakeAuth,
  fixtures,
  makeEnv,
  makeOrg,
  makeSession,
  makeUser,
} from '../../../../test/helpers/index.ts';
import type { OrgRole } from '../../../shared/contracts/org-membership.ts';
import {
  type GoogleWalletCredentials,
  WalletProviderReadinessSchema,
} from '../../../shared/contracts/wallet-providers.ts';
import { createApp } from '../../app.ts';
import type { SessionAuth } from '../../platform/auth.ts';
import { ManualClock } from '../../platform/clock.ts';
import type { AppBindings } from '../../platform/context.ts';
import {
  credentialAad,
  decryptSecretText,
  encryptSecret,
  loadKekRing,
} from '../../platform/crypto.ts';
import { all, first, run } from '../../platform/db.ts';
import type { AppEnv } from '../../platform/env.ts';
import { sha256Hex, toBase64 } from '../../platform/ids.ts';
import { createServiceContext } from '../../platform/service-context.ts';
import { createSessionStore } from '../auth/sessions.ts';
import { makeRsaPem } from '../identities/push-key-fixtures.ts';
import { ensureCredentialRefKeyset } from '../passes/credential-keyset.ts';
import { tenantAuthorityOf } from '../passes/http.ts';
import {
  configureWalletProviderAccount,
  getWalletProviderReadiness,
  readConfiguredWalletProviderCredentials,
  readGoogleCallbackVerification,
  readWalletProviderRetirementCredentials,
  revokeWalletProviderAccount,
} from './account-service.ts';
import { GOOGLE_WALLET_SCOPE } from './google-credentials.ts';
import { saveAccountConfiguration, transitionAccount } from './repo-accounts.ts';

const origin = 'https://wallet.test';
const base = `${origin}/api/v1/wallet-providers/accounts`;
const kek = btoa(String.fromCharCode(...new Uint8Array(32).fill(7)));
const clock = new ManualClock(Date.now());
let env: AppEnv;
let f: Fixtures;
let app: OpenAPIHono<AppBindings>;
let googlePem: string;
let rotatedPem: string;
let samsungCredentials: {
  partnerId: string;
  certificateId: string;
  cardId: string;
  partnerPrivateKeyPem: string;
  partnerCertificatePem: string;
  samsungCertificatePem: string;
};

function pem(label: string, der: ArrayBuffer): string {
  return `-----BEGIN ${label}-----\n${toBase64(new Uint8Array(der))
    .match(/.{1,64}/g)
    ?.join('\n')}\n-----END ${label}-----\n`;
}
async function certificate() {
  const keys = (await crypto.subtle.generateKey(
    {
      name: 'RSASSA-PKCS1-v1_5',
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: 'SHA-256',
    },
    true,
    ['sign', 'verify'],
  )) as CryptoKeyPair;
  const engine = new pki.CryptoEngine({
    name: 'WebCrypto',
    crypto,
    subtle: crypto.subtle,
  }) as unknown as pki.ICryptoEngine;
  const cert = new pki.Certificate();
  cert.version = 2;
  cert.serialNumber = new asn1.Integer({ value: 1 });
  const name = new pki.RelativeDistinguishedNames({
    typesAndValues: [
      new pki.AttributeTypeAndValue({
        type: '2.5.4.3',
        value: new asn1.Utf8String({ value: 'Test certificate' }),
      }),
    ],
  });
  cert.issuer = name;
  cert.subject = name;
  cert.notBefore.value = new Date(clock.now() - 60_000);
  cert.notAfter.value = new Date(clock.now() + 86_400_000);
  await cert.subjectPublicKeyInfo.importKey(keys.publicKey, engine);
  await cert.sign(keys.privateKey, 'SHA-256', engine);
  return {
    certificate: pem('CERTIFICATE', cert.toSchema(true).toBER(false)),
    privateKey: pem(
      'PRIVATE KEY',
      (await crypto.subtle.exportKey('pkcs8', keys.privateKey)) as ArrayBuffer,
    ),
  };
}

beforeAll(async () => {
  env = await makeEnv({ KEK_V1: kek, PUBLIC_BASE_URL: origin });
  f = fixtures(env, clock);
  const fake = fakeAuth(origin);
  app = createApp({ stores: { ...fake.stores, sessions: createSessionStore(env, clock) }, clock });
  const [key1, key2, partner, samsung] = await Promise.all([
    makeRsaPem(),
    makeRsaPem(),
    certificate(),
    certificate(),
  ]);
  googlePem = key1;
  rotatedPem = key2;
  samsungCredentials = {
    partnerId: 'partner123',
    certificateId: 'AB12',
    cardId: 'card123',
    partnerPrivateKeyPem: partner.privateKey,
    partnerCertificatePem: partner.certificate,
    samsungCertificatePem: samsung.certificate,
  };
}, 30_000);

async function member(orgId: string, roles: OrgRole[] = ['org_admin']) {
  const user = await makeUser(f);
  const invitationId = f.ids.id();
  const membershipId = f.ids.id();
  const now = clock.now();
  await run(
    env.DB,
    `INSERT INTO org_invitations
    (id, org_id, email, roles, token_hash, created_at, expires_at, accepted_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      invitationId,
      orgId,
      user.primaryEmail,
      JSON.stringify(roles),
      f.ids.token(),
      now,
      now + 3600000,
      now,
    ],
  );
  await run(
    env.DB,
    `INSERT INTO org_memberships (id, org_id, user_id, invitation_id, roles, created_at)
    VALUES (?, ?, ?, ?, ?, ?)`,
    [membershipId, orgId, user.id, invitationId, JSON.stringify(roles), now],
  );
  const session = await makeSession(f, { userId: user.id, roles: ['user'] });
  const auth: SessionAuth = {
    kind: 'session',
    userId: user.id,
    sessionId: await sha256Hex(session.cookieValue),
    roles: ['user'],
    csrfSecret: session.csrf,
    amr: 'oidc',
    mode: 'live',
  };
  return { user, membershipId, session, auth };
}
function google(privateKeyPem = googlePem): GoogleWalletCredentials {
  return {
    issuerId: '123456789',
    serviceAccountEmail: 'wallet@example-project.iam.gserviceaccount.com',
    privateKeyPem,
    scopes: [GOOGLE_WALLET_SCOPE],
  };
}
function call(
  method: string,
  path: string,
  headers: Record<string, string>,
  body?: unknown,
  e = env,
) {
  return app.request(
    `${base}${path}`,
    {
      method,
      headers: {
        ...headers,
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    },
    e,
  );
}
function query(orgId: string, mode: 'live' | 'test', provider: 'google' | 'samsung') {
  return `?${new URLSearchParams({ orgId, mode, provider })}`;
}

async function dto(response: Response) {
  expect(response.status).toBe(200);
  return WalletProviderReadinessSchema.parse(await response.json());
}

describe('wallet provider accounts', () => {
  it('encrypts scoped credentials and preserves a stable Google key without self-approving', async () => {
    const org = await makeOrg(f);
    const { session } = await member(org.id);
    const scope = { orgId: org.id, mode: 'live' as const, provider: 'google' as const };
    const ctx = createServiceContext(env, { clock });
    expect(
      (await dto(await call('GET', query(org.id, 'live', 'google'), session.headers))).state,
    ).toBe('absent');
    const response = await call('PUT', '', session.headers, {
      ...scope,
      expectedRevision: 0,
      credentials: google(),
    });
    const text = await response.clone().text();
    const configured = await dto(response);
    expect(configured).toMatchObject({
      state: 'configured',
      revision: 1,
      externalApprovalVerified: false,
      issuance: { state: 'disabled', reason: 'not_released' },
    });
    expect(text).not.toContain(googlePem);
    expect(text).not.toContain(google().serviceAccountEmail);
    if (!configured.accountId) throw new Error('Missing account');
    const row = await first<{
      id: string;
      kek_version: number;
      iv: number[];
      wrapped_dek: number[];
      ciphertext: number[];
    }>(env.DB, 'SELECT * FROM wallet_provider_credentials WHERE account_id = ?', [
      configured.accountId,
    ]);
    if (!row) throw new Error('Missing encrypted credential');
    expect(JSON.stringify(row)).not.toContain(googlePem);
    expect(JSON.stringify(row)).not.toContain(google().serviceAccountEmail);
    const envelope = {
      kekVersion: row.kek_version,
      iv: new Uint8Array(row.iv),
      wrappedDek: new Uint8Array(row.wrapped_dek),
      ciphertext: new Uint8Array(row.ciphertext),
    };
    const ring = await loadKekRing(env);
    const aad = credentialAad(
      row.id,
      org.id,
      `wallet-provider:${configured.accountId}:live:google`,
    );
    const plaintext = JSON.parse(await decryptSecretText(ring, envelope, aad)) as {
      credentials: { privateKeyPem: string };
    };
    expect(plaintext.credentials.privateKeyPem).toBe(googlePem);
    await expect(
      decryptSecretText(
        ring,
        envelope,
        credentialAad(row.id, 'another-org', `wallet-provider:${configured.accountId}:live:google`),
      ),
    ).rejects.toThrow();
    await expect(
      decryptSecretText(
        ring,
        envelope,
        credentialAad(row.id, org.id, `wallet-provider:${configured.accountId}:test:google`),
      ),
    ).rejects.toThrow();
    await expect(
      decryptSecretText(
        ring,
        envelope,
        credentialAad(
          'another-credential',
          org.id,
          `wallet-provider:${configured.accountId}:live:google`,
        ),
      ),
    ).rejects.toThrow();
    const expected = {
      accountId: configured.accountId,
      accountRevision: 1,
      credentialKeysetCommitment: await ensureCredentialRefKeyset(env.DB, env),
    };
    const firstSnapshot = await readConfiguredWalletProviderCredentials(ctx, scope, expected);
    if (firstSnapshot?.provider !== 'google') throw new Error('Missing Google snapshot');
    expect(firstSnapshot.objectIdHmacKey).toHaveLength(32);
    expect(firstSnapshot.credentialKeysetCommitment).toBe(expected.credentialKeysetCommitment);
    await expect(
      readConfiguredWalletProviderCredentials(ctx, scope, {
        ...expected,
        credentialKeysetCommitment: '0'.repeat(64),
      }),
    ).rejects.toMatchObject({ code: 'WALLET_CREDENTIALS_UNAVAILABLE' });
    const callback = await readGoogleCallbackVerification(ctx, {
      ...scope,
      ...expected,
    });
    expect(callback?.objectIdHmacKey).toEqual(firstSnapshot.objectIdHmacKey);
    expect(JSON.stringify(callback)).not.toContain(googlePem);
    expect(
      (
        await call('POST', '/approve', session.headers, {
          ...scope,
          expectedRevision: 1,
          confirmExternalApproval: true,
        })
      ).status,
    ).toBe(404);
    const rotated = await dto(
      await call('PUT', '', session.headers, {
        ...scope,
        expectedRevision: 1,
        credentials: google(rotatedPem),
      }),
    );
    expect(rotated).toMatchObject({
      state: 'configured',
      revision: 2,
      accountId: configured.accountId,
    });
    expect(await readConfiguredWalletProviderCredentials(ctx, scope, expected)).toBeNull();
    const next = await readConfiguredWalletProviderCredentials(ctx, scope, {
      ...expected,
      accountRevision: 2,
    });
    if (next?.provider !== 'google') throw new Error('Missing rotated snapshot');
    expect(next.objectIdHmacKey).toEqual(firstSnapshot.objectIdHmacKey);
    expect(next.credentials.privateKeyPem).toBe(rotatedPem);
    expect(
      (
        await call('PUT', '', session.headers, {
          ...scope,
          expectedRevision: 2,
          credentials: { ...google(), issuerId: '987654321' },
        })
      ).status,
    ).toBe(409);
    expect(
      (await dto(await call('POST', '/revoke', session.headers, { ...scope, expectedRevision: 2 })))
        .state,
    ).toBe('revoked');
    expect(
      await readGoogleCallbackVerification(ctx, {
        ...scope,
        accountId: configured.accountId,
        accountRevision: 3,
        credentialKeysetCommitment: await ensureCredentialRefKeyset(env.DB, env),
      }),
    ).toBeNull();
    await dto(
      await call('PUT', '', session.headers, {
        ...scope,
        expectedRevision: 3,
        credentials: google(),
      }),
    );
    const restored = await readConfiguredWalletProviderCredentials(ctx, scope, {
      ...expected,
      accountRevision: 4,
    });
    if (restored?.provider !== 'google') throw new Error('Missing restored snapshot');
    expect(restored.objectIdHmacKey).toEqual(firstSnapshot.objectIdHmacKey);
    const events = await all<{ id: string; kind: string }>(
      env.DB,
      'SELECT id, kind FROM wallet_provider_account_events WHERE account_id = ? ORDER BY revision',
      [configured.accountId],
    );
    expect(events.map((event) => event.kind)).toEqual([
      'configure',
      'configure',
      'revoke',
      'configure',
    ]);
    await expect(
      run(env.DB, 'UPDATE wallet_provider_account_events SET kind = ? WHERE id = ?', [
        'revoke',
        events[0]?.id,
      ]),
    ).rejects.toThrow();
    await expect(
      run(env.DB, 'DELETE FROM wallet_provider_credentials WHERE id = ?', [row.id]),
    ).rejects.toThrow();
    await expect(
      run(env.DB, 'UPDATE wallet_provider_accounts SET revision = revision + 1 WHERE id = ?', [
        configured.accountId,
      ]),
    ).rejects.toThrow();
    const audits = await all<{ action: string; detail: string }>(
      env.DB,
      "SELECT action, detail FROM audit_log WHERE target_id = ? AND action LIKE 'wallet_provider.account_%' ORDER BY id",
      [configured.accountId],
    );
    expect(audits).toHaveLength(4);
    expect(JSON.stringify(audits)).not.toContain(googlePem);
    expect(JSON.stringify(audits)).not.toContain(google().serviceAccountEmail);
  });

  it('isolates tenants and modes, checks real keys, and restricts mutations to integration managers', async () => {
    const org = await makeOrg(f);
    const other = await makeOrg(f);
    const admin = await member(org.id);
    const integration = await member(org.id, ['integration_admin']);
    const reader = await member(org.id, ['read_only']);
    const ctx = createServiceContext(env, { clock });
    const scope = { orgId: org.id, mode: 'live' as const, provider: 'google' as const };
    const missingCsrf = { ...admin.session.headers };
    delete missingCsrf['x-csrf-token'];
    expect(
      (await call('PUT', '', missingCsrf, { ...scope, expectedRevision: 0, credentials: google() }))
        .status,
    ).toBe(403);
    expect(
      (
        await call('PUT', '', reader.session.headers, {
          ...scope,
          expectedRevision: 0,
          credentials: google(),
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await call('PUT', '', admin.session.headers, {
          ...scope,
          expectedRevision: 0,
          credentials: google('not-a-key'),
        })
      ).status,
    ).toBe(422);
    expect(
      (
        await call('PUT', '', admin.session.headers, {
          ...scope,
          expectedRevision: 0,
          credentials: { ...google(), extra: 'not accepted' },
        })
      ).status,
    ).toBe(422);
    expect((await getWalletProviderReadiness(ctx, scope)).state).toBe('absent');
    const live = await dto(
      await call('PUT', '', integration.session.headers, {
        ...scope,
        expectedRevision: 0,
        credentials: google(),
      }),
    );
    expect(
      (await call('GET', query(other.id, 'live', 'google'), admin.session.headers)).status,
    ).toBe(403);
    expect((await call('GET', query(org.id, 'test', 'google'), admin.session.headers)).status).toBe(
      403,
    );
    const testHeaders = { ...admin.session.headers, 'x-passbook-mode': 'test' };
    expect((await dto(await call('GET', query(org.id, 'test', 'google'), testHeaders))).state).toBe(
      'absent',
    );
    const testScope = { ...scope, mode: 'test' as const };
    const test = await dto(
      await call('PUT', '', testHeaders, {
        ...testScope,
        expectedRevision: 0,
        credentials: google(),
      }),
    );
    if (!live.accountId || !test.accountId) throw new Error('Missing account IDs');
    const credentialKeysetCommitment = await ensureCredentialRefKeyset(env.DB, env);
    const liveSecret = await readConfiguredWalletProviderCredentials(ctx, scope, {
      accountId: live.accountId,
      accountRevision: 1,
      credentialKeysetCommitment,
    });
    const testSecret = await readConfiguredWalletProviderCredentials(ctx, testScope, {
      accountId: test.accountId,
      accountRevision: 1,
      credentialKeysetCommitment,
    });
    if (liveSecret?.provider !== 'google' || testSecret?.provider !== 'google')
      throw new Error('Missing snapshots');
    expect(liveSecret.objectIdHmacKey).not.toEqual(testSecret.objectIdHmacKey);
    expect(
      await readConfiguredWalletProviderCredentials(
        ctx,
        { ...scope, orgId: other.id },
        { accountId: live.accountId, accountRevision: 1, credentialKeysetCommitment },
      ),
    ).toBeNull();
    expect(
      (
        await dto(
          await call('POST', '/revoke', integration.session.headers, {
            ...scope,
            expectedRevision: 1,
          }),
        )
      ).state,
    ).toBe('revoked');
    const samsungScope = { ...scope, provider: 'samsung' as const };
    expect(
      (
        await call('PUT', '', admin.session.headers, {
          ...samsungScope,
          expectedRevision: 0,
          credentials: { ...samsungCredentials, partnerPrivateKeyPem: googlePem },
        })
      ).status,
    ).toBe(422);
    const samsung = await dto(
      await call('PUT', '', admin.session.headers, {
        ...samsungScope,
        expectedRevision: 0,
        credentials: samsungCredentials,
      }),
    );
    expect(samsung).toMatchObject({
      state: 'configured',
      externalApprovalVerified: false,
      issuance: { state: 'disabled', reason: 'not_released' },
    });
    expect(
      (
        await call('PUT', '', admin.session.headers, {
          ...samsungScope,
          expectedRevision: 1,
          credentials: { ...samsungCredentials, cardId: 'otherCard' },
        })
      ).status,
    ).toBe(409);
  });

  it('does not release Google cleanup credentials without an existing claimed provider operation', async () => {
    const org = await makeOrg(f);
    const { session } = await member(org.id);
    const scope = { orgId: org.id, mode: 'live' as const, provider: 'google' as const };
    const account = await dto(
      await call('PUT', '', session.headers, {
        ...scope,
        expectedRevision: 0,
        credentials: google(),
      }),
    );
    if (!account.accountId) throw new Error('Missing account');
    const proof = {
      ...scope,
      accountId: account.accountId,
      accountRevision: 1,
      instanceId: f.ids.id(),
      operationId: f.ids.id(),
      version: 1,
      claimHash: await sha256Hex(f.ids.token()),
      projectionReleaseId: f.ids.id(),
      passId: f.ids.id(),
      identityProjectionReleaseId: f.ids.id(),
      credentialGeneration: 1,
      credentialKeysetCommitment: await ensureCredentialRefKeyset(env.DB, env),
    };
    const ctx = createServiceContext(env, { clock });
    expect(await readWalletProviderRetirementCredentials(ctx, proof)).toBeNull();
    expect(
      await readWalletProviderRetirementCredentials(ctx, { ...proof, passId: f.ids.id() }),
    ).toBeNull();
    expect(
      await readWalletProviderRetirementCredentials(ctx, {
        ...proof,
        identityProjectionReleaseId: f.ids.id(),
      }),
    ).toBeNull();
    await expect(
      readWalletProviderRetirementCredentials(ctx, {
        ...proof,
        credentialKeysetCommitment: '0'.repeat(64),
      }),
    ).rejects.toMatchObject({ code: 'WALLET_CREDENTIALS_UNAVAILABLE' });
    await expect(
      readWalletProviderRetirementCredentials(ctx, { ...proof, credentialGeneration: 0 }),
    ).rejects.toMatchObject({ code: 'VALIDATION' });
  });

  it('uses the guarded account row, not trigger-inflated change counts, as the commit proof', async () => {
    const org = await makeOrg(f);
    const { auth } = await member(org.id);
    const scope = { orgId: org.id, mode: 'live' as const, provider: 'google' as const };
    let reportedChanges = 2;
    const db = new Proxy(env.DB, {
      get(target, prop) {
        if (prop === 'batch')
          return async (statements: D1PreparedStatement[]) => {
            const results = await target.batch(statements);
            return results.map((result) => ({
              ...result,
              meta: { ...result.meta, changes: reportedChanges },
            }));
          };
        const value = Reflect.get(target, prop, target);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    const ctx = createServiceContext({ ...env, DB: db }, { clock });
    const configured = await configureWalletProviderAccount(ctx, auth, {
      ...scope,
      expectedRevision: 0,
      credentials: google(),
    });
    expect(configured).toMatchObject({ state: 'configured', revision: 1 });
    if (!configured.accountId) throw new Error('Missing configured account');
    const account = await first<{ credential_id: string }>(
      env.DB,
      'SELECT credential_id FROM wallet_provider_accounts WHERE id = ?',
      [configured.accountId],
    );
    if (!account) throw new Error('Missing configured credential');
    const authority = await tenantAuthorityOf(ctx, auth, org.id, 'integrations:manage');
    if (authority.kind !== 'session') throw new Error('Missing session authority');
    const commitment = await ensureCredentialRefKeyset(env.DB, env);
    const credentialId = f.ids.id();
    const envelope = await encryptSecret(
      await loadKekRing(env),
      'guarded',
      credentialAad(credentialId, org.id, `wallet-provider:${configured.accountId}:live:google`),
    );

    // Even a misleading count of one must not turn a stale CAS into a successful write.
    reportedChanges = 1;
    expect(
      await saveAccountConfiguration(ctx, authority, scope, {
        accountId: configured.accountId,
        isNew: false,
        expectedRevision: 99,
        credentialId,
        eventId: f.ids.id(),
        envelope,
        credentialKeysetCommitment: commitment,
      }),
    ).toBe(false);
    expect(
      await transitionAccount(ctx, authority, scope, {
        accountId: configured.accountId,
        credentialId: account.credential_id,
        expectedRevision: 99,
        eventId: f.ids.id(),
        kind: 'revoke',
        credentialKeysetCommitment: commitment,
      }),
    ).toBe(false);
    expect(
      await first(
        env.DB,
        'SELECT revision, credential_id, revoked_at FROM wallet_provider_accounts WHERE id = ?',
        [configured.accountId],
      ),
    ).toEqual({ revision: 1, credential_id: account.credential_id, revoked_at: null });

    reportedChanges = 2;
    expect(
      await configureWalletProviderAccount(ctx, auth, {
        ...scope,
        expectedRevision: 1,
        credentials: google(rotatedPem),
      }),
    ).toMatchObject({ state: 'configured', revision: 2 });
    expect(
      await revokeWalletProviderAccount(ctx, auth, { ...scope, expectedRevision: 2 }),
    ).toMatchObject({ state: 'revoked', revision: 3 });
    const events = await all<{ kind: string }>(
      env.DB,
      'SELECT kind FROM wallet_provider_account_events WHERE account_id = ? ORDER BY revision',
      [configured.accountId],
    );
    expect(events.map((event) => event.kind)).toEqual(['configure', 'configure', 'revoke']);
    expect(
      await first(
        env.DB,
        'SELECT COUNT(*) AS n FROM wallet_provider_credentials WHERE account_id = ?',
        [configured.accountId],
      ),
    ).toEqual({ n: 2 });
    const audits = await all<{ action: string }>(
      env.DB,
      "SELECT action FROM audit_log WHERE target_id = ? AND action LIKE 'wallet_provider.account_%' ORDER BY id",
      [configured.accountId],
    );
    expect(audits.map((audit) => audit.action)).toEqual([
      'wallet_provider.account_configure',
      'wallet_provider.account_configure',
      'wallet_provider.account_revoke',
    ]);
  });

  it('rechecks the exact session and membership in the atomic write', async () => {
    const org = await makeOrg(f);
    const actor = await member(org.id);
    let injected = false;
    const db = new Proxy(env.DB, {
      get(target, prop) {
        if (prop === 'batch')
          return async (statements: D1PreparedStatement[]) => {
            if (!injected) {
              injected = true;
              await run(target, 'UPDATE org_memberships SET revoked_at = ? WHERE id = ?', [
                clock.now(),
                actor.membershipId,
              ]);
            }
            return target.batch(statements);
          };
        const value = Reflect.get(target, prop, target);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    const ctx = createServiceContext({ ...env, DB: db }, { clock });
    const scope = { orgId: org.id, mode: 'live' as const, provider: 'google' as const };
    await expect(
      configureWalletProviderAccount(ctx, actor.auth, {
        ...scope,
        expectedRevision: 0,
        credentials: google(),
      }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(injected).toBe(true);
    expect(
      await first(env.DB, 'SELECT id FROM wallet_provider_accounts WHERE org_id = ?', [org.id]),
    ).toBeNull();
    expect(
      await all(
        env.DB,
        "SELECT id FROM audit_log WHERE org_id = ? AND action LIKE 'wallet_provider.account_%'",
        [org.id],
      ),
    ).toEqual([]);
  });
});
