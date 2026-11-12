import { CompactSign, importPKCS8 } from 'jose';
import {
  fixtures,
  makeEnv,
  makeOrg,
  makeSession,
  makeUser,
} from '../../../../test/helpers/index.ts';
import { createFixtureIdentity } from '../../../passkit/testing/fixture-identity.ts';
import type {
  GoogleWalletCredentials,
  SamsungWalletCredentials,
  WalletProviderReadiness,
} from '../../../shared/contracts/wallet-providers.ts';
import type { SessionAuth } from '../../platform/auth.ts';
import { ManualClock } from '../../platform/clock.ts';
import {
  decryptSecretText,
  type Envelope,
  encryptSecret,
  loadKekRing,
} from '../../platform/crypto.ts';
import type { AppEnv } from '../../platform/env.ts';
import { toBase64 } from '../../platform/ids.ts';
import { createServiceContext } from '../../platform/service-context.ts';
import { createSessionStore } from '../auth/sessions.ts';
import { ensureCredentialRefKeyset } from '../passes/credential-keyset.ts';
import { configureWalletProviderAccount } from './account-service.ts';
import { GOOGLE_WALLET_SCOPE } from './google-credentials.ts';
import { providerIdentityHash } from './projection-contract.ts';
import {
  insertRuntimeFixtureInvitation,
  insertRuntimeFixtureMembership,
} from './repo-runtime-test-fixtures.ts';
import {
  createGoogleRuntimeOffer,
  type WalletRuntimeProviderResponse,
  type WalletRuntimeScope,
} from './runtime.ts';
import type { SamsungCardProjection } from './samsung.ts';

export const NOW = Date.UTC(2026, 5, 1, 12);
export const BEARER = 'ya29.private-bearer';
export const refId = 'abcdefghijklmnopqrstuvwxABCDEFGH';
export const classProjection = { enableSmartTap: false };
export const objectProjection = {
  cardTitle: { defaultValue: { language: 'en', value: 'Membership' } },
};
export const googleInput = {
  releaseId: 'release-1',
  passId: 'pass-1',
  credentialGeneration: 1,
  origins: ['https://passbook.mobile'],
};
export const cardProjection: SamsungCardProjection = {
  card: {
    type: 'loyalty',
    subType: 'others',
    data: [
      {
        refId,
        createdAt: NOW - 1_000,
        updatedAt: NOW,
        state: 'ACTIVE',
        language: 'en',
        attributes: { title: 'Confidential member value' },
      },
    ],
  },
};

async function rsaKey() {
  const pair = await crypto.subtle.generateKey(
    {
      name: 'RSASSA-PKCS1-v1_5',
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: 'SHA-256',
    },
    true,
    ['sign', 'verify'],
  );
  if (!('privateKey' in pair)) throw new Error('Expected an RSA key pair');
  const exported = await crypto.subtle.exportKey('pkcs8', pair.privateKey);
  if (!(exported instanceof ArrayBuffer)) throw new Error('Expected a PKCS8 key export');
  const bytes = new Uint8Array(exported);
  const encoded = btoa(Array.from(bytes, (value) => String.fromCharCode(value)).join(''));
  return {
    publicKey: pair.publicKey,
    pem: `-----BEGIN PRIVATE KEY-----\n${encoded}\n-----END PRIVATE KEY-----`,
  };
}

interface RuntimeTestMaterial {
  env: AppEnv;
  credentialKeysetCommitment: string;
  google: GoogleWalletCredentials;
  rotatedGoogle: GoogleWalletCredentials;
  googlePublicKey: CryptoKey;
  samsung: SamsungWalletCredentials;
  samsungPrivateKey: CryptoKey;
}

async function material(): Promise<RuntimeTestMaterial> {
  const [first, second, identity] = await Promise.all([
    rsaKey(),
    rsaKey(),
    createFixtureIdentity(undefined, { now: new Date(NOW) }),
  ]);
  const google: GoogleWalletCredentials = {
    issuerId: '33880000000223344',
    serviceAccountEmail: 'wallet@example.iam.gserviceaccount.com',
    privateKeyPem: first.pem,
    scopes: [GOOGLE_WALLET_SCOPE],
  };
  const rotatedGoogle = { ...google, privateKeyPem: second.pem };
  const samsung: SamsungWalletCredentials = {
    partnerId: 'partner-private',
    certificateId: 'YMtt',
    cardId: 'card-private',
    partnerPrivateKeyPem: identity.privateKey,
    partnerCertificatePem: identity.certificate,
    samsungCertificatePem: identity.certificate,
  };
  const samsungPrivateKey = (await importPKCS8(identity.privateKey, 'RS256')) as CryptoKey;
  const env = await makeEnv({ KEK_V1: btoa(String.fromCharCode(...new Uint8Array(32).fill(77))) });
  const credentialKeysetCommitment = await ensureCredentialRefKeyset(env.DB, env);
  return {
    env,
    credentialKeysetCommitment,
    google,
    rotatedGoogle,
    googlePublicKey: first.publicKey,
    samsung,
    samsungPrivateKey,
  };
}

let materials: Promise<RuntimeTestMaterial> | undefined;

export async function prepareRuntimeTestMaterials(): Promise<void> {
  if (!materials) materials = material();
  await materials;
}

/** Real tenant membership, session, encrypted account configuration, and adapter keys. */
export async function runtimeTestFixture() {
  if (!materials) materials = material();
  const keys = await materials;
  const { env, google, samsung, samsungPrivateKey } = keys;
  const clock = new ManualClock(NOW);
  const ctx = createServiceContext(env, { clock });
  const f = fixtures(env, clock);
  const org = await makeOrg(f);
  const user = await makeUser(f);
  const invitation = f.ids.id();
  const orgId = org.id;
  await insertRuntimeFixtureInvitation(env.DB, {
    id: invitation,
    orgId,
    email: user.primaryEmail,
    tokenHash: f.ids.token(),
    now: NOW,
  });
  await insertRuntimeFixtureMembership(env.DB, {
    id: f.ids.id(),
    orgId,
    userId: user.id,
    invitationId: invitation,
    now: NOW,
  });
  const session = await makeSession(f, { userId: user.id });
  const resolvedAuth = await createSessionStore(env, clock).resolve(session.cookieValue);
  if (!resolvedAuth) throw new Error('Session fixture did not resolve');
  const auth: SessionAuth = resolvedAuth;

  async function configuredGoogle(mode: 'live' | 'test' = 'live') {
    return configureWalletProviderAccount(
      ctx,
      { ...auth, mode },
      {
        orgId,
        mode,
        provider: 'google',
        expectedRevision: 0,
        credentials: google,
      },
    );
  }
  async function scopeOf(ready: WalletProviderReadiness): Promise<WalletRuntimeScope> {
    if (!ready.accountId) throw new Error('Missing account fixture');
    const identityHash = await providerIdentityHash(
      ready.provider === 'google'
        ? { provider: 'google', credentials: google }
        : { provider: 'samsung', credentials: samsung },
    );
    return {
      orgId: ready.orgId,
      mode: ready.mode,
      accountId: ready.accountId,
      accountRevision: ready.revision,
      credentialKeysetCommitment: keys.credentialKeysetCommitment,
      providerIdentityHash: identityHash,
      providerReleaseId: 'pending-release',
    };
  }
  async function googleOffer(scope: WalletRuntimeScope) {
    return createGoogleRuntimeOffer(ctx, scope, googleInput);
  }
  async function samsungAccount() {
    const ready = await configureWalletProviderAccount(ctx, auth, {
      orgId,
      mode: 'live',
      provider: 'samsung',
      expectedRevision: 0,
      credentials: samsung,
    });
    return scopeOf(ready);
  }
  async function samsungRequest(options: { query?: string; bindQuery?: boolean } = {}) {
    const path = `/wallet/v1/samsung/cards/${samsung.cardId}/${refId}`;
    const query = options.query ?? '';
    const signedPath = `${path}${options.bindQuery ? query : ''}`;
    const token = await new CompactSign(
      new TextEncoder().encode(
        JSON.stringify({
          API: { method: 'GET', path: signedPath },
          refId,
        }),
      ),
    )
      .setProtectedHeader({
        alg: 'RS256',
        cty: 'AUTH',
        ver: '3',
        certificateId: samsung.certificateId,
        partnerId: samsung.partnerId,
        utc: NOW,
      })
      .sign(samsungPrivateKey);
    return new Request(`https://example.test${path}${query}`, {
      headers: { Authorization: `Bearer ${token}`, 'x-request-id': 'request-1' },
    });
  }
  async function encryptedResponseSink() {
    const ring = await loadKekRing(env);
    const envelopes: Envelope[] = [];
    const aad = 'runtime-test-provider-outcome';
    async function onProviderResponse(response: WalletRuntimeProviderResponse) {
      const plaintext = JSON.stringify({ ...response, body: toBase64(response.body) });
      envelopes.push(await encryptSecret(ring, plaintext, aad));
    }
    async function readResponses(): Promise<
      { stage: string; method: string; status: number; body: string }[]
    > {
      return Promise.all(
        envelopes.map(async (envelope) => JSON.parse(await decryptSecretText(ring, envelope, aad))),
      );
    }
    return { onProviderResponse, envelopes, readResponses };
  }
  return {
    ...keys,
    ctx,
    clock,
    auth,
    orgId,
    configuredGoogle,
    scopeOf,
    googleOffer,
    samsungAccount,
    samsungRequest,
    encryptedResponseSink,
  };
}
