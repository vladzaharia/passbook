import { compactVerify, importX509 } from 'jose';
import { vi } from 'vitest';
import { makeUser, type TestTemplate } from '../../../../test/helpers/index.ts';
import { InMemoryTemplateRegistry } from '../../../passkit/template/in-memory-registry.ts';
import { createFixtureIdentity } from '../../../passkit/testing/fixture-identity.ts';
import type {
  GoogleWalletCredentials,
  SamsungWalletCredentials,
} from '../../../shared/contracts/wallet-providers.ts';
import type { SessionAuth } from '../../platform/auth.ts';
import { createSession, resolveSession } from '../auth/sessions.ts';
import { approveAppleRelease, grantKitMembership } from '../passes/apple-release-test-fixtures.ts';
import { requireCredentialRefKeyset } from '../passes/credential-keyset.ts';
import { ICON_PNG, type Kit, setupKit } from '../passes/pass-test-fixtures.ts';
import type { Pass } from '../passes/repo.ts';
import {
  configureWalletProviderAccount,
  getWalletProviderReadiness,
  readConfiguredWalletProviderCredentials,
} from './account-service.ts';
import { GOOGLE_WALLET_SCOPE } from './google-credentials.ts';
import type { NativeProvider } from './projection-contract.ts';
import {
  approveProjectionCandidate,
  createProjectionCandidate,
  publishProjectionRelease,
} from './projection-service.ts';
import { setWalletProvidersEnabledForTest } from './provider-policy.ts';
import { refreshSamsungProjectionEvidence } from './samsung-verification.ts';

/** A source whose entire Apple representation is covered by both native projections. */
export function makeProviderTestTemplate(id: string): TestTemplate {
  const registry = new InMemoryTemplateRegistry();
  const resolved = registry.add({
    id,
    manifest: {
      schema: 1,
      name: 'Provider test template',
      inputs: {
        type: 'object',
        required: ['memberName'],
        properties: { memberName: { type: 'string', minLength: 1 } },
      },
      sample: { memberName: 'Alex Morgan' },
      bindings: [{ to: { field: 'name' }, value: '{{memberName}}' }],
      display: { title: '{{memberName}}' },
    },
    passJson: {
      formatVersion: 1,
      passTypeIdentifier: 'placeholder',
      teamIdentifier: 'placeholder',
      serialNumber: 'placeholder',
      organizationName: 'placeholder',
      description: 'Test pass',
      generic: { primaryFields: [{ key: 'name', label: 'Member', value: '' }] },
    },
    assets: { 'icon.png': ICON_PNG },
  });
  // The in-memory registry classifies all files as "other"; this is a real icon asset.
  const icon = resolved.assets.find((asset) => asset.name === 'icon.png');
  if (!icon) throw new Error('Provider fixture icon is missing.');
  icon.slot = 'icon';
  return { resolved, registry };
}

export type OfferFixtureState = 'absent' | 'configured' | 'published';

/** An already-issued pass and its exact independently reviewed Apple source. */
export interface OfferFixtureSource {
  kit: Kit;
  apple: {
    id: string;
    authorAuth: SessionAuth;
    reviewerAuth: SessionAuth;
    publisherAuth: SessionAuth;
  };
  pass: Pass;
  barcode: 'none' | 'qr';
}

/** Reviewed source and real provider evidence obtained through a mocked Samsung HTTPS response. */
export async function setupWalletOfferKit(
  options: {
    google?: 'absent' | 'configured';
    samsung?: OfferFixtureState;
    holderEmail?: string;
    source?: OfferFixtureSource;
    db?: D1Database;
  } = {},
) {
  const kit =
    options.source?.kit ?? (await setupKit({ db: options.db, template: makeProviderTestTemplate }));
  if (!options.source) kit.env.KEK_V1 = btoa(String.fromCharCode(...new Uint8Array(32).fill(7)));
  const apple = options.source?.apple ?? (await approveAppleRelease(kit));
  const pass = options.source?.pass ?? (await kit.pass({ holderEmail: options.holderEmail }));
  const credentialKeysetCommitment = await requireCredentialRefKeyset(kit.env.DB, kit.env);
  const user = await makeUser(kit.fx);
  await grantKitMembership(kit, kit.org.id, user.id, ['org_admin']);
  const session = await createSession(kit.ctx, {
    userId: user.id,
    roles: ['user'],
    amr: 'oidc',
    ipPrefix: null,
    userAgent: null,
  });
  const resolved = await resolveSession(kit.env, kit.clock, session.cookieValue);
  if (!resolved) throw new Error('Offer fixture session did not resolve.');
  const auth: SessionAuth = { ...resolved, mode: 'live' };
  const identity = await createFixtureIdentity(undefined, { now: new Date(kit.clock.now()) });
  const google: GoogleWalletCredentials = {
    issuerId: '33880000000223344',
    serviceAccountEmail: 'wallet@example.iam.gserviceaccount.com',
    privateKeyPem: identity.privateKey,
    scopes: [GOOGLE_WALLET_SCOPE],
  };
  const samsung: SamsungWalletCredentials = {
    partnerId: 'partner',
    certificateId: 'ABCD',
    cardId: 'membership',
    partnerPrivateKeyPem: identity.privateKey,
    partnerCertificatePem: identity.certificate,
    samsungCertificatePem: identity.certificate,
  };
  const scope = (provider: NativeProvider) => ({
    orgId: kit.org.id,
    mode: 'live' as const,
    provider,
  });
  const projection = (provider: NativeProvider) => ({
    schema: 1 as const,
    provider,
    language: 'en',
    logoUrl: 'https://example.test/logo.png',
    sourceArtworkSlots: ['icon' as const],
    titleField: 'name',
    fields: ['name'],
    barcode: options.source?.barcode ?? 'none',
    ...(provider === 'samsung'
      ? {
          cardType: 'loyalty',
          cardSubType: 'others',
          countryCode: 'GB',
          appLinkLogo: 'https://example.test/app.png',
          appLinkName: 'Account',
          appLinkData: 'https://example.test/account',
        }
      : {}),
  });
  async function configure(provider: NativeProvider) {
    return provider === 'google'
      ? configureWalletProviderAccount(kit.ctx, auth, {
          ...scope(provider),
          provider,
          expectedRevision: 0,
          credentials: google,
        })
      : configureWalletProviderAccount(kit.ctx, auth, {
          ...scope(provider),
          provider,
          expectedRevision: 0,
          credentials: samsung,
        });
  }
  async function refreshSamsungEvidence(candidateId: string, candidateHash: string) {
    // The provider verifies with the certificate on the account's current revision, which rotation replaces.
    const readiness = await getWalletProviderReadiness(kit.ctx, scope('samsung'));
    const current = await readConfiguredWalletProviderCredentials(kit.ctx, scope('samsung'), {
      accountId: readiness.accountId ?? '',
      accountRevision: readiness.revision,
      credentialKeysetCommitment,
    });
    if (current?.provider !== 'samsung')
      throw new Error('Samsung account missing in wallet offer fixture.');
    const partnerCertificatePem = current.credentials.partnerCertificatePem;
    const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = input instanceof Request ? input.url : String(input);
      const method = (
        init?.method ?? (input instanceof Request ? input.method : 'GET')
      ).toUpperCase();
      const path = `/partner/v1/card/template/${samsung.cardId}`;
      if (url !== `https://tsapi-card.walletsvc.samsung.com${path}` || method !== 'GET')
        throw new Error('Unexpected provider request in wallet offer fixture.');
      const headers = new Headers(
        init?.headers ?? (input instanceof Request ? input.headers : undefined),
      );
      const authorization = headers.get('Authorization');
      if (
        !authorization?.startsWith('Bearer ') ||
        headers.get('x-smcs-partner-id') !== samsung.partnerId
      )
        throw new Error('Missing Samsung verifier authorization in wallet offer fixture.');
      const verified = await compactVerify(
        authorization.slice(7),
        await importX509(partnerCertificatePem, 'RS256'),
        { algorithms: ['RS256'] },
      );
      const payload: unknown = JSON.parse(new TextDecoder().decode(verified.payload));
      if (
        verified.protectedHeader.cty !== 'AUTH' ||
        verified.protectedHeader.partnerId !== samsung.partnerId ||
        verified.protectedHeader.certificateId !== samsung.certificateId ||
        JSON.stringify(payload) !== JSON.stringify({ API: { method: 'GET', path } })
      )
        throw new Error('Invalid Samsung verifier authorization in wallet offer fixture.');
      return Response.json({
        resultCode: '0',
        template: {
          cardId: samsung.cardId,
          state: 'ACTIVE',
          testingModeOff: 'Y',
          cardType: 'loyalty',
          subType: 'others',
          countryCode: 'GB',
        },
      });
    });
    const restoreGate = setWalletProvidersEnabledForTest(true);
    try {
      const result = await refreshSamsungProjectionEvidence(kit.ctx, auth, {
        orgId: kit.org.id,
        mode: 'live',
        candidateId,
        candidateHash,
      });
      if (!result.verified)
        throw new Error('Samsung card verification failed in wallet offer fixture.');
    } finally {
      fetch.mockRestore();
      restoreGate();
    }
  }
  async function publish(provider: 'samsung', expectedGeneration = 0) {
    // Evidence probing is a provider call, so publishing runs with the gate opened for the fixture only.
    const restoreGate = setWalletProvidersEnabledForTest(true);
    try {
      return await publishEnabled(provider, expectedGeneration);
    } finally {
      restoreGate();
    }
  }
  async function publishEnabled(provider: 'samsung', expectedGeneration: number) {
    const common = scope(provider);
    const candidate = await createProjectionCandidate(kit.ctx, apple.authorAuth, kit.template.id, {
      ...common,
      version: kit.template.version,
      sourceReleaseId: apple.id,
      projection: projection(provider),
    });
    const approval = await approveProjectionCandidate(
      kit.ctx,
      apple.reviewerAuth,
      kit.template.id,
      candidate.id,
      {
        ...common,
        candidateHash: candidate.candidateHash,
      },
    );
    await refreshSamsungEvidence(candidate.id, candidate.candidateHash);
    return publishProjectionRelease(kit.ctx, apple.publisherAuth, kit.template.id, {
      ...common,
      candidateId: candidate.id,
      approvalId: approval.id,
      candidateHash: candidate.candidateHash,
      expectedGeneration,
    });
  }
  if ((options.google ?? 'configured') !== 'absent') await configure('google');
  const samsungState = options.samsung ?? 'published';
  if (samsungState !== 'absent') await configure('samsung');
  const samsungRelease = samsungState === 'published' ? await publish('samsung') : null;
  return {
    kit,
    apple,
    pass,
    auth,
    google,
    samsung,
    samsungRelease,
    googleCertificate: identity.certificate,
    credentialKeysetCommitment,
    projection,
    configure,
    publish,
    refreshSamsungEvidence,
  };
}
