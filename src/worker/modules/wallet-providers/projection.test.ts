import { applyD1Migrations } from 'cloudflare:test';
import { env as bindings } from 'cloudflare:workers';
import { afterAll, beforeAll, describe, expect, it, onTestFinished, vi } from 'vitest';
import {
  countD1,
  type Fixtures,
  fakeAuth,
  fixtures,
  makeEnv,
  makeOrg,
  makeSession,
  makeUser,
  type OrgRow,
} from '../../../../test/helpers/index.ts';
import type {
  TemplateApproval,
  TemplateCandidate,
  TemplateRelease,
} from '../../../shared/contracts/template-releases.ts';
import type {
  GoogleWalletCredentials,
  SamsungWalletCredentials,
} from '../../../shared/contracts/wallet-providers.ts';
import { createApp } from '../../app.ts';
import type { SessionAuth } from '../../platform/auth.ts';
import { ManualClock } from '../../platform/clock.ts';
import { credentialAad, decryptSecretText, loadKekRing } from '../../platform/crypto.ts';
import { first, run } from '../../platform/db.ts';
import type { AppEnv } from '../../platform/env.ts';
import { createServiceContext, type ServiceContext } from '../../platform/service-context.ts';
import { interveneAtD1 } from '../apple/credential-transfer-test-fixtures.ts';
import { createSessionStore } from '../auth/sessions.ts';
import {
  credentialRefKeysetCommitment,
  requireCredentialRefKeyset,
} from '../passes/credential-keyset.ts';
import { authorizeTemplateWrite } from '../templates/access.ts';
import { basicPackage, passJson, zipOf } from '../templates/package/fixtures.ts';
import { candidateHash } from '../templates/release-content.ts';
import { approveCandidate, createCandidate, publishRelease } from '../templates/releases.ts';
import { getVersion } from '../templates/repo.ts';
import { getApproval } from '../templates/repo-releases.ts';
import { generatedSource, syncBakedTemplates } from '../templates/sync.ts';
import { bakedFrom, fakeAssets, importZip, sourceOf } from '../templates/testing.ts';
import { configureWalletProviderAccount, revokeWalletProviderAccount } from './account-service.ts';
import { replaceCallbackKeysetForTest } from './callbacks-test-fixtures.ts';
import type { WalletCredentialKeysetProof } from './instance-types.ts';
import {
  GOOGLE_PROJECTION_POLICY,
  NativeProjectionSchema,
  normalizeNativeProjection,
} from './projection-contract.ts';
import {
  approveProjectionCandidate,
  createProjectionCandidate,
  getApprovedProjection,
  listProjectionCandidates,
  listProjectionReleases,
  publishProjectionRelease,
  rollbackProjectionRelease,
} from './projection-service.ts';
import { assertProjectionSource } from './projection-source.ts';
import { setWalletProvidersEnabledForTest } from './provider-policy.ts';
import { findAccount } from './repo-accounts.ts';
import {
  getProjectionRetirementMetadata,
  projectionReleaseBindingPredicateSql,
  projectionReleaseBindingValid,
} from './repo-projection.ts';
import {
  getProjectionCandidate,
  insertProjectionCandidateStmt,
  insertProjectionReleaseStmt,
  projectionCandidateEnvelope,
} from './repo-projection-store.ts';
import { ensureSamsungProjectionEvidence } from './samsung-verification.ts';

// Publishing a Samsung projection probes Samsung, which only runs while the provider is enabled.
beforeAll(() => {
  setWalletProvidersEnabledForTest(true);
});

const KEK_V1 = btoa(String.fromCharCode(...new Uint8Array(32).fill(7)));
const KEK_V2 = btoa(String.fromCharCode(...new Uint8Array(32).fill(8)));
const GOOGLE_SCOPE = 'https://www.googleapis.com/auth/wallet_object.issuer' as const;
const projection = {
  schema: 1,
  provider: 'samsung',
  language: 'en',
  logoUrl: 'https://example.test/logo.png',
  sourceArtworkSlots: ['icon'],
  titleField: 'name',
  fields: ['name'],
  barcode: 'none',
  cardType: 'loyalty',
  cardSubType: 'others',
  countryCode: 'GB',
  appLinkLogo: 'https://example.test/app.png',
  appLinkName: 'Account',
  appLinkData: 'https://example.test/account',
} as const;
const googleProjection = {
  schema: 1,
  provider: 'google',
  language: 'en',
  logoUrl: 'https://example.test/logo.png',
  sourceArtworkSlots: ['icon'],
  titleField: 'name',
  fields: ['name'],
  barcode: 'none',
} as const;
const manifest = {
  schema: 1,
  name: 'Reviewed card',
  inputs: { type: 'object', properties: { name: { type: 'string' } } },
  sample: { name: 'Ada' },
  bindings: [{ to: { field: 'name' }, value: '{{name}}' }],
  display: { title: '{{name}}' },
};
let env: AppEnv;
let clock: ManualClock;
let f: Fixtures;
let credentials: SamsungWalletCredentials;
let googleCredentials: GoogleWalletCredentials;
let providerState = 'ACTIVE';
let testingModeOff = 'Y';

interface ProjectionFixture {
  org: OrgRow;
  otherOrg: OrgRow;
  author: SessionAuth;
  reviewer: SessionAuth;
  otherReviewer: SessionAuth;
  foreign: SessionAuth;
  ctx: ServiceContext;
  proof: WalletCredentialKeysetProof;
  templateId: string;
  version: string;
  apple: { orgId: string; mode: 'live'; provider: 'apple' };
  source: TemplateRelease;
  scope: { orgId: string; mode: 'live'; provider: 'samsung' };
}

beforeAll(async () => {
  clock = new ManualClock(Date.now());
  env = await makeEnv({
    KEK_V1,
    KEK_V2,
    KEK_V3: undefined,
    ASSETS: fakeAssets(),
    CF_VERSION: { id: 'projection-tests', tag: '', timestamp: '9990-01-01T00:00:00Z' },
  });
  f = fixtures(env, clock);
  credentials = {
    partnerId: 'partner123',
    certificateId: 'AB12',
    cardId: 'card123',
    partnerPrivateKeyPem: env.SIGNER_PLATFORM_PRIVATE_KEY,
    partnerCertificatePem: env.SIGNER_PLATFORM_CERTIFICATE,
    samsungCertificatePem: env.SIGNER_PLATFORM_CERTIFICATE,
  };
  googleCredentials = {
    issuerId: '33880000000223344',
    serviceAccountEmail: 'wallet@example.iam.gserviceaccount.com',
    privateKeyPem: env.SIGNER_PLATFORM_PRIVATE_KEY,
    scopes: [GOOGLE_SCOPE],
  };
  vi.stubGlobal('fetch', async (input: RequestInfo | URL) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (
      url.origin !== 'https://tsapi-card.walletsvc.samsung.com' ||
      url.pathname !== `/partner/v1/card/template/${credentials.cardId}`
    )
      throw new Error('Unexpected test request');
    return Response.json({
      resultCode: '0',
      template: {
        cardId: credentials.cardId,
        cardType: 'loyalty',
        subType: 'others',
        countryCode: 'GB',
        state: providerState,
        testingModeOff,
      },
    });
  });
});
afterAll(() => {
  vi.unstubAllGlobals();
});

async function member(orgId: string, env: AppEnv, f: Fixtures): Promise<SessionAuth> {
  const user = await makeUser(f);
  const now = clock.now();
  const invitation = f.ids.id();
  await run(
    env.DB,
    `INSERT INTO org_invitations (id, org_id, email, roles, token_hash, created_at, expires_at, accepted_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      invitation,
      orgId,
      user.primaryEmail,
      '["org_admin"]',
      f.ids.token(),
      now,
      now + 3600_000,
      now,
    ],
  );
  await run(
    env.DB,
    `INSERT INTO org_memberships (id, org_id, user_id, invitation_id, roles, created_at)
    VALUES (?, ?, ?, ?, ?, ?)`,
    [f.ids.id(), orgId, user.id, invitation, '["org_admin"]', now],
  );
  const session = await makeSession(f, { userId: user.id });
  const auth = await createSessionStore(env, clock).resolve(session.cookieValue);
  if (!auth) throw new Error('Test session did not resolve.');
  return auth;
}

async function setup(
  testEnv: AppEnv = env,
  testFixtures: Fixtures = f,
): Promise<ProjectionFixture> {
  const org = await makeOrg(testFixtures);
  const otherOrg = await makeOrg(testFixtures);
  const author = await member(org.id, testEnv, testFixtures);
  const reviewer = await member(org.id, testEnv, testFixtures);
  const otherReviewer = await member(org.id, testEnv, testFixtures);
  const foreign = await member(otherOrg.id, testEnv, testFixtures);
  const ctx = createServiceContext(testEnv, { clock });
  const imported = await importZip(testEnv, clock, {
    orgId: org.id,
    createdBy: author.userId,
    zip: zipOf(basicPackage({ 'wallet.template.json': JSON.stringify(manifest) }, passJson())),
  });
  if (!imported.result) throw new Error('Test template import failed.');
  const { templateId, version } = imported.result;
  const apple = { orgId: org.id, mode: 'live' as const, provider: 'apple' as const };
  const c = await createCandidate(ctx, author, templateId, { ...apple, version });
  const a = await approveCandidate(ctx, reviewer, templateId, c.id, {
    ...apple,
    candidateHash: c.candidateHash,
  });
  const source = await publishRelease(ctx, author, templateId, {
    ...apple,
    candidateId: c.id,
    approvalId: a.id,
    candidateHash: c.candidateHash,
    expectedGeneration: 0,
  });
  const scope = { orgId: org.id, mode: 'live' as const, provider: 'samsung' as const };
  await configureWalletProviderAccount(ctx, author, { ...scope, expectedRevision: 0, credentials });
  const proof = {
    credentialKeysetCommitment: await requireCredentialRefKeyset(testEnv.DB, testEnv),
  };
  return {
    org,
    otherOrg,
    author,
    reviewer,
    otherReviewer,
    foreign,
    ctx,
    proof,
    templateId,
    version,
    apple,
    source,
    scope,
  };
}

async function nativeCandidate(
  test: ProjectionFixture,
  author = test.author,
): Promise<TemplateCandidate> {
  return createProjectionCandidate(test.ctx, author, test.templateId, {
    ...test.scope,
    version: test.version,
    sourceReleaseId: test.source.id,
    projection,
  });
}
async function nativeApproval(
  test: ProjectionFixture,
  candidate: TemplateCandidate,
): Promise<TemplateApproval> {
  return approveProjectionCandidate(test.ctx, test.reviewer, test.templateId, candidate.id, {
    ...test.scope,
    candidateHash: candidate.candidateHash,
  });
}
async function nativePublish(
  test: ProjectionFixture,
  candidate: TemplateCandidate,
  approval: TemplateApproval,
  expectedGeneration = 0,
) {
  return publishProjectionRelease(test.ctx, test.author, test.templateId, {
    ...test.scope,
    candidateId: candidate.id,
    approvalId: approval.id,
    candidateHash: candidate.candidateHash,
    expectedGeneration,
  });
}
/** Exercise the database trigger without the publication statement's own evidence guards. */
async function insertDirectProjectionRelease(
  test: ProjectionFixture,
  candidate: TemplateCandidate,
  approval: TemplateApproval,
  overrides: {
    orgId?: string;
    mode?: 'live' | 'test';
    candidateHash?: string;
    contentHash?: string;
    approvalId?: string;
    createdAt?: number;
  } = {},
) {
  return run(
    env.DB,
    `INSERT INTO template_releases
    (id, template_id, org_id, mode, provider, generation, version, candidate_hash, content_hash,
     adapter_revision, adapter_capabilities, audience_policy_revision, source, action, candidate_id,
     approval_id, previous_release_id, rollback_of_release_id, created_by, created_at, credential_keyset_commitment)
    SELECT ?, c.template_id, ?, ?, c.provider, 1, c.version, ?, ?, c.adapter_revision,
      c.adapter_capabilities, c.audience_policy_revision, 'approved', 'release', c.id, ?,
      NULL, NULL, ?, ?, c.credential_keyset_commitment
    FROM template_candidates c WHERE c.id = ?`,
    [
      test.ctx.ids.id(),
      overrides.orgId ?? candidate.orgId,
      overrides.mode ?? candidate.mode,
      overrides.candidateHash ?? candidate.candidateHash,
      overrides.contentHash ?? candidate.contentHash,
      overrides.approvalId ?? approval.id,
      test.author.userId,
      overrides.createdAt ?? clock.now(),
      candidate.id,
    ],
  );
}
function lookup(test: ProjectionFixture) {
  return {
    ...test.scope,
    templateId: test.templateId,
    templateVersion: test.version,
    appleReleaseId: test.source.id,
  };
}

describe('native projection approval', () => {
  it('does not inherit Apple approval and isolates tenant, mode, provider, version and source', async () => {
    const test = await setup();
    const candidate = await nativeCandidate(test);
    expect(await getApprovedProjection(test.ctx, lookup(test), test.proof)).toBeNull();
    await expect(
      publishProjectionRelease(test.ctx, test.author, test.templateId, {
        ...test.scope,
        candidateId: candidate.id,
        approvalId: 'missing',
        candidateHash: candidate.candidateHash,
        expectedGeneration: 0,
      }),
    ).rejects.toMatchObject({ code: 'WALLET_PROJECTION_CONFLICT' });
    const approval = await nativeApproval(test, candidate);
    const release = await nativePublish(test, candidate, approval);
    expect(await getApprovedProjection(test.ctx, lookup(test), test.proof)).toMatchObject({
      release: { id: release.id, sourceReleaseId: test.source.id, accountRevision: 1 },
      projection,
    });
    expect(
      await getApprovedProjection(
        test.ctx,
        { ...lookup(test), orgId: test.otherOrg.id },
        test.proof,
      ),
    ).toBeNull();
    expect(
      await getApprovedProjection(test.ctx, { ...lookup(test), mode: 'test' }, test.proof),
    ).toBeNull();
    expect(
      await getApprovedProjection(test.ctx, { ...lookup(test), provider: 'google' }, test.proof),
    ).toBeNull();
    expect(
      await getApprovedProjection(
        test.ctx,
        { ...lookup(test), templateVersion: 'other' },
        test.proof,
      ),
    ).toBeNull();
    expect(
      await getApprovedProjection(
        test.ctx,
        { ...lookup(test), appleReleaseId: 'other' },
        test.proof,
      ),
    ).toBeNull();
    expect(
      await getApprovedProjection(test.ctx, { ...lookup(test), adapterRevision: 99 }, test.proof),
    ).toBeNull();
    await expect(
      createProjectionCandidate(test.ctx, test.foreign, test.templateId, {
        ...test.scope,
        version: test.version,
        sourceReleaseId: test.source.id,
        projection,
      }),
    ).rejects.toThrow();
    await expect(
      createProjectionCandidate(test.ctx, { ...test.author, mode: 'test' }, test.templateId, {
        ...test.scope,
        version: test.version,
        sourceReleaseId: test.source.id,
        projection,
      }),
    ).rejects.toMatchObject({ code: 'TEMPLATE_MODE_MISMATCH' });
  });

  it('requires provider evidence even after human review and never treats Google authentication as approval', async () => {
    const test = await setup();
    const candidate = await nativeCandidate(test);
    const approval = await nativeApproval(test, candidate);
    try {
      providerState = 'VERIFYING';
      await expect(nativePublish(test, candidate, approval)).rejects.toMatchObject({
        code: 'WALLET_PROJECTION_CONFLICT',
      });
      providerState = 'ACTIVE';
      testingModeOff = 'N';
      await expect(nativePublish(test, candidate, approval)).rejects.toMatchObject({
        code: 'WALLET_PROJECTION_CONFLICT',
      });
    } finally {
      providerState = 'ACTIVE';
      testingModeOff = 'Y';
    }
    expect(await nativePublish(test, candidate, approval)).toMatchObject({ provider: 'samsung' });

    const google = { ...test.scope, provider: 'google' as const };
    await configureWalletProviderAccount(test.ctx, test.author, {
      ...google,
      expectedRevision: 0,
      credentials: googleCredentials,
    });
    const draft = await createProjectionCandidate(test.ctx, test.author, test.templateId, {
      ...google,
      version: test.version,
      sourceReleaseId: test.source.id,
      projection: googleProjection,
    });
    const reviewed = await approveProjectionCandidate(
      test.ctx,
      test.reviewer,
      test.templateId,
      draft.id,
      { ...google, candidateHash: draft.candidateHash },
    );
    await expect(insertDirectProjectionRelease(test, draft, reviewed)).rejects.toThrow(
      'invalid provider release approval or source',
    );
    await expect(
      publishProjectionRelease(test.ctx, test.author, test.templateId, {
        ...google,
        candidateId: draft.id,
        approvalId: reviewed.id,
        candidateHash: draft.candidateHash,
        expectedGeneration: 0,
      }),
    ).rejects.toMatchObject({ code: 'WALLET_PROJECTION_CONFLICT' });
    expect(
      await getApprovedProjection(test.ctx, { ...lookup(test), provider: 'google' }, test.proof),
    ).toBeNull();
  });

  it('enforces the provider evidence and its history on direct release inserts', async () => {
    const test = await setup();
    const candidate = await nativeCandidate(test);
    const approval = await nativeApproval(test, candidate);
    const reject = 'invalid provider release approval or source';
    await expect(insertDirectProjectionRelease(test, candidate, approval)).rejects.toThrow(reject);
    expect(
      await ensureSamsungProjectionEvidence(
        test.ctx,
        candidate.id,
        candidate.candidateHash,
        test.proof,
      ),
    ).toBe(true);

    const google = { ...test.scope, provider: 'google' as const };
    await configureWalletProviderAccount(test.ctx, test.author, {
      ...google,
      expectedRevision: 0,
      credentials: googleCredentials,
    });
    const otherAccount = await findAccount(env.DB, google);
    const evidence = await first<{
      probe_id: string;
      org_id: string;
      mode: string;
      account_id: string;
      account_revision: number;
      provider_identity_hash: string;
      candidate_hash: string;
      card_type: string;
      card_sub_type: string;
      country_code: string;
      verified_at: number;
      expires_at: number;
    }>(env.DB, 'SELECT * FROM wallet_provider_projection_evidence WHERE candidate_id = ?', [
      candidate.id,
    ]);
    if (!evidence || !otherAccount) throw new Error('Missing evidence or account.');

    const differentHash = (hash: string) => (hash === '0'.repeat(64) ? '1' : '0').repeat(64);
    for (const overrides of [
      { orgId: test.otherOrg.id },
      { mode: 'test' as const },
      { candidateHash: differentHash(candidate.candidateHash) },
      { contentHash: differentHash(candidate.contentHash) },
      { createdAt: evidence.verified_at - 1 },
      { createdAt: evidence.expires_at },
    ]) {
      await expect(
        insertDirectProjectionRelease(test, candidate, approval, overrides),
      ).rejects.toThrow(reject);
    }

    for (const status of ['pending', 'unverified']) {
      await run(
        env.DB,
        `UPDATE wallet_provider_projection_evidence SET status = ?, testing_mode_off = NULL,
          verified_at = NULL, expires_at = NULL WHERE candidate_id = ?`,
        [status, candidate.id],
      );
      await expect(insertDirectProjectionRelease(test, candidate, approval)).rejects.toThrow(
        reject,
      );
      await run(
        env.DB,
        `UPDATE wallet_provider_projection_evidence SET status = 'verified', testing_mode_off = 'Y',
          verified_at = ?, expires_at = ? WHERE candidate_id = ?`,
        [evidence.verified_at, evidence.expires_at, candidate.id],
      );
    }

    const historyColumns = [
      'candidate_id',
      'org_id',
      'mode',
      'account_id',
      'account_revision',
      'provider_identity_hash',
      'candidate_hash',
      'card_type',
      'card_sub_type',
      'country_code',
      'testing_mode_off',
      'verified_at',
      'expires_at',
      'credential_keyset_commitment',
    ];
    async function writeHistory(override?: { column: string; value: string | number }) {
      await run(
        env.DB,
        `INSERT INTO wallet_provider_projection_evidence_history (id, ${historyColumns.join(', ')})
        SELECT ev.probe_id, ${historyColumns
          .map((column) => (column === override?.column ? '?' : `ev.${column}`))
          .join(', ')}
        FROM wallet_provider_projection_evidence ev WHERE ev.candidate_id = ?`,
        [...(override ? [override.value] : []), candidate.id],
      );
    }
    const mismatches = [
      ['org_id', test.otherOrg.id],
      ['mode', 'test'],
      ['account_id', otherAccount.id],
      ['account_revision', evidence.account_revision + 1],
      ['provider_identity_hash', differentHash(evidence.provider_identity_hash)],
      ['candidate_hash', differentHash(evidence.candidate_hash)],
      ['card_type', 'ticket'],
      ['card_sub_type', 'mismatched'],
      ['country_code', 'US'],
    ] as const;

    // Give each mismatched current record its own matching immutable history: rejection must
    // come from the candidate/evidence binding, not merely from missing history.
    for (const [column, value] of mismatches) {
      await run(
        env.DB,
        `UPDATE wallet_provider_projection_evidence SET ${column} = ?, probe_id = ? WHERE candidate_id = ?`,
        [value, test.ctx.ids.id(), candidate.id],
      );
      await writeHistory();
      await expect(insertDirectProjectionRelease(test, candidate, approval)).rejects.toThrow(
        reject,
      );
      await run(
        env.DB,
        `UPDATE wallet_provider_projection_evidence SET ${column} = ?, probe_id = ? WHERE candidate_id = ?`,
        [evidence[column], evidence.probe_id, candidate.id],
      );
    }

    await run(
      env.DB,
      'UPDATE wallet_provider_projection_evidence SET probe_id = ? WHERE candidate_id = ?',
      [test.ctx.ids.id(), candidate.id],
    );
    await expect(insertDirectProjectionRelease(test, candidate, approval)).rejects.toThrow(reject);

    // Now keep current evidence valid and vary only the immutable history snapshot.
    for (const [column, value] of [
      ...mismatches,
      ['verified_at', evidence.verified_at + 1],
      ['expires_at', evidence.expires_at - 1],
    ] as const) {
      await run(
        env.DB,
        'UPDATE wallet_provider_projection_evidence SET probe_id = ? WHERE candidate_id = ?',
        [test.ctx.ids.id(), candidate.id],
      );
      await writeHistory({ column, value });
      await expect(insertDirectProjectionRelease(test, candidate, approval)).rejects.toThrow(
        reject,
      );
    }

    const otherCandidate = await nativeCandidate(test);
    const otherApproval = await nativeApproval(test, otherCandidate);
    expect(
      await ensureSamsungProjectionEvidence(
        test.ctx,
        otherCandidate.id,
        otherCandidate.candidateHash,
        test.proof,
      ),
    ).toBe(true);
    const otherEvidence = await first<{ probe_id: string }>(
      env.DB,
      'SELECT probe_id FROM wallet_provider_projection_evidence WHERE candidate_id = ?',
      [otherCandidate.id],
    );
    if (!otherEvidence) throw new Error('Missing other evidence.');
    await run(
      env.DB,
      'UPDATE wallet_provider_projection_evidence SET probe_id = ? WHERE candidate_id = ?',
      [otherEvidence.probe_id, candidate.id],
    );
    await expect(insertDirectProjectionRelease(test, candidate, approval)).rejects.toThrow(reject);
    await run(
      env.DB,
      'UPDATE wallet_provider_projection_evidence SET probe_id = ? WHERE candidate_id = ?',
      [evidence.probe_id, candidate.id],
    );
    await expect(
      insertDirectProjectionRelease(test, candidate, approval, { approvalId: otherApproval.id }),
    ).rejects.toThrow();
    expect(
      await insertDirectProjectionRelease(test, candidate, approval, {
        createdAt: evidence.expires_at - 1,
      }),
    ).toEqual({ changes: 1 });
  }, 30_000);

  it('rechecks the Apple source and provider account snapshots on direct release inserts', async () => {
    const staleSource = await setup();
    const sourceCandidate = await nativeCandidate(staleSource);
    const sourceApproval = await nativeApproval(staleSource, sourceCandidate);
    expect(
      await ensureSamsungProjectionEvidence(
        staleSource.ctx,
        sourceCandidate.id,
        sourceCandidate.candidateHash,
        staleSource.proof,
      ),
    ).toBe(true);
    const next = await createCandidate(
      staleSource.ctx,
      staleSource.author,
      staleSource.templateId,
      {
        ...staleSource.apple,
        version: staleSource.version,
      },
    );
    const nextApproval = await approveCandidate(
      staleSource.ctx,
      staleSource.reviewer,
      staleSource.templateId,
      next.id,
      { ...staleSource.apple, candidateHash: next.candidateHash },
    );
    await publishRelease(staleSource.ctx, staleSource.author, staleSource.templateId, {
      ...staleSource.apple,
      candidateId: next.id,
      approvalId: nextApproval.id,
      candidateHash: next.candidateHash,
      expectedGeneration: 1,
    });
    await expect(
      insertDirectProjectionRelease(staleSource, sourceCandidate, sourceApproval),
    ).rejects.toThrow('invalid provider release approval or source');

    const staleAccount = await setup();
    const accountCandidate = await nativeCandidate(staleAccount);
    const accountApproval = await nativeApproval(staleAccount, accountCandidate);
    expect(
      await ensureSamsungProjectionEvidence(
        staleAccount.ctx,
        accountCandidate.id,
        accountCandidate.candidateHash,
        staleAccount.proof,
      ),
    ).toBe(true);
    await configureWalletProviderAccount(staleAccount.ctx, staleAccount.author, {
      ...staleAccount.scope,
      expectedRevision: 1,
      credentials,
    });
    await expect(
      insertDirectProjectionRelease(staleAccount, accountCandidate, accountApproval),
    ).rejects.toThrow('invalid provider release approval or source');

    const revokedCandidate = await nativeCandidate(staleAccount);
    const revokedApproval = await nativeApproval(staleAccount, revokedCandidate);
    expect(
      await ensureSamsungProjectionEvidence(
        staleAccount.ctx,
        revokedCandidate.id,
        revokedCandidate.candidateHash,
        staleAccount.proof,
      ),
    ).toBe(true);
    await revokeWalletProviderAccount(staleAccount.ctx, staleAccount.author, {
      ...staleAccount.scope,
      expectedRevision: 2,
    });
    await expect(
      insertDirectProjectionRelease(staleAccount, revokedCandidate, revokedApproval),
    ).rejects.toThrow('invalid provider release approval or source');
  }, 30_000);

  it('allows the independent reviewer to publish with current publish authority', async () => {
    const test = await setup();
    const candidate = await nativeCandidate(test);
    const approval = await nativeApproval(test, candidate);
    const released = await publishProjectionRelease(test.ctx, test.reviewer, test.templateId, {
      ...test.scope,
      candidateId: candidate.id,
      approvalId: approval.id,
      candidateHash: candidate.candidateHash,
      expectedGeneration: 0,
    });
    expect(released).toMatchObject({
      provider: 'samsung',
      createdBy: test.reviewer.userId,
      sourceReleaseId: test.source.id,
      accountRevision: 1,
    });
  });

  it('accepts a content-verified baked Apple source only after a separate native review', async () => {
    const db = (bindings as unknown as Record<string, D1Database | undefined>).KEYSET_TEST_DB_0;
    if (!db) throw new Error('No isolated D1 binding for baked projection test');
    await applyD1Migrations(db, bindings.TEST_MIGRATIONS);
    const testEnv = { ...env, DB: db };
    const test = await setup(testEnv, fixtures(testEnv, clock));
    const fixture = await bakedFrom(
      test.ctx.ids.id(),
      basicPackage({ 'wallet.template.json': JSON.stringify(manifest) }, passJson()),
      { name: 'Baked card' },
    );
    const source = sourceOf([fixture], generatedSource.hash);
    const syncCtx = createServiceContext(
      { ...testEnv, ASSETS: fakeAssets(fixture.files) },
      { clock },
    );
    // Service reads re-sync the generated registry, which archives a baked template it does not list.
    const registry = generatedSource.templates as unknown as unknown[];
    registry.push(fixture.template);
    onTestFinished(() => void registry.splice(registry.indexOf(fixture.template), 1));
    await syncBakedTemplates(syncCtx, source);
    const templateId = fixture.template.id;
    const version = fixture.template.version;
    const release = await first<{ id: string }>(
      db,
      "SELECT id FROM template_releases WHERE template_id = ? AND org_id IS NULL AND mode = 'live' AND provider = 'apple' ORDER BY generation DESC LIMIT 1",
      [templateId],
    );
    if (!release) throw new Error('Baked source release missing.');
    const sourceId = release.id;
    const trustedScope = {
      ...test.scope,
      templateId,
      templateVersion: version,
      appleReleaseId: sourceId,
    };
    expect(await getApprovedProjection(syncCtx, trustedScope, test.proof)).toBeNull();
    const candidate = await createProjectionCandidate(syncCtx, test.author, templateId, {
      ...test.scope,
      version,
      sourceReleaseId: sourceId,
      projection,
    });
    const approval = await approveProjectionCandidate(
      syncCtx,
      test.reviewer,
      templateId,
      candidate.id,
      { ...test.scope, candidateHash: candidate.candidateHash },
    );
    await publishProjectionRelease(syncCtx, test.author, templateId, {
      ...test.scope,
      candidateId: candidate.id,
      approvalId: approval.id,
      candidateHash: candidate.candidateHash,
      expectedGeneration: 0,
    });
    expect(await getApprovedProjection(syncCtx, trustedScope, test.proof)).toMatchObject({
      release: { sourceReleaseId: sourceId, orgId: test.org.id },
      projection,
    });
  }, 30_000);

  it('requires a reviewer distinct from both the candidate author and source version author', async () => {
    const test = await setup();
    const candidate = await nativeCandidate(test, test.reviewer);
    for (const actor of [test.author, test.reviewer]) {
      await expect(
        approveProjectionCandidate(test.ctx, actor, test.templateId, candidate.id, {
          ...test.scope,
          candidateHash: candidate.candidateHash,
        }),
      ).rejects.toMatchObject({ code: 'TEMPLATE_SELF_APPROVAL' });
    }
    await expect(
      approveProjectionCandidate(test.ctx, test.otherReviewer, test.templateId, candidate.id, {
        ...test.scope,
        candidateHash: candidate.candidateHash,
      }),
    ).resolves.toMatchObject({ candidateId: candidate.id });
  });

  it('makes projection content immutable and includes mappings, source and account in the digest', async () => {
    const test = await setup();
    const candidate = await nativeCandidate(test);
    await expect(
      run(env.DB, 'UPDATE template_candidates SET projection_json = ? WHERE id = ?', [
        '{}',
        candidate.id,
      ]),
    ).rejects.toThrow();
    const stored = await getProjectionCandidate(env.DB, candidate.id);
    if (!stored) throw new Error('Candidate missing.');
    expect(await candidateHash(projectionCandidateEnvelope(stored))).toBe(candidate.candidateHash);
    for (const modified of [
      { ...stored, sourceReleaseId: 'another-source' },
      { ...stored, accountRevision: stored.accountRevision + 1 },
      { ...stored, providerIdentityHash: '0'.repeat(64) },
      { ...stored, credentialKeysetCommitment: '0'.repeat(64) },
      {
        ...stored,
        projection: { ...stored.projection, logoUrl: 'https://example.test/changed.png' },
      },
    ])
      expect(await candidateHash(projectionCandidateEnvelope(modified))).not.toBe(
        candidate.candidateHash,
      );
    const forged = {
      ...stored,
      id: test.ctx.ids.id(),
      projection: { ...stored.projection, logoUrl: 'https://example.test/changed.png' },
    };
    const authority = await authorizeTemplateWrite(
      test.ctx,
      test.author,
      test.scope.orgId,
      'templates:author',
    );
    for (const stale of [
      { ...stored, id: test.ctx.ids.id(), adapterRevision: stored.adapterRevision + 1 },
      { ...stored, id: test.ctx.ids.id(), adapterCapabilities: [] },
      {
        ...stored,
        id: test.ctx.ids.id(),
        audiencePolicyRevision: stored.audiencePolicyRevision + 1,
      },
    ]) {
      expect(
        (
          await insertProjectionCandidateStmt(
            env.DB,
            stale,
            authority,
            clock.now(),
            test.proof,
          ).run()
        ).meta.changes,
      ).toBe(0);
    }
    await insertProjectionCandidateStmt(env.DB, forged, authority, clock.now(), test.proof).run();
    await expect(
      approveProjectionCandidate(test.ctx, test.reviewer, test.templateId, forged.id, {
        ...test.scope,
        candidateHash: forged.candidateHash,
      }),
    ).rejects.toMatchObject({ code: 'WALLET_PROJECTION_CONFLICT' });
    await expect(
      approveProjectionCandidate(test.ctx, test.reviewer, test.templateId, candidate.id, {
        ...test.scope,
        candidateHash: '0'.repeat(64),
      }),
    ).rejects.toMatchObject({ code: 'WALLET_PROJECTION_CONFLICT' });
  });

  it('rejects a candidate when its Apple source or approved credential revision changes', async () => {
    const test = await setup();
    const candidate = await nativeCandidate(test);
    const approval = await nativeApproval(test, candidate);
    const waiting = await nativeCandidate(test);
    const waitingApproval = await nativeApproval(test, waiting);
    await nativePublish(test, candidate, approval);
    const next = await createCandidate(test.ctx, test.author, test.templateId, {
      ...test.apple,
      version: test.version,
    });
    const nextApproval = await approveCandidate(test.ctx, test.reviewer, test.templateId, next.id, {
      ...test.apple,
      candidateHash: next.candidateHash,
    });
    await publishRelease(test.ctx, test.author, test.templateId, {
      ...test.apple,
      candidateId: next.id,
      approvalId: nextApproval.id,
      candidateHash: next.candidateHash,
      expectedGeneration: 1,
    });
    await expect(nativePublish(test, waiting, waitingApproval, 1)).rejects.toMatchObject({
      code: 'WALLET_PROJECTION_CONFLICT',
    });
    expect(await getApprovedProjection(test.ctx, lookup(test), test.proof)).toBeNull();

    const second = await setup();
    const current = await nativeCandidate(second);
    const currentApproval = await nativeApproval(second, current);
    await nativePublish(second, current, currentApproval);
    await revokeWalletProviderAccount(second.ctx, second.author, {
      ...second.scope,
      expectedRevision: 1,
    });
    expect(await getApprovedProjection(second.ctx, lookup(second), second.proof)).toBeNull();
  });

  it('enforces tenant, mode and independent-review permissions on the existing HTTP routes', async () => {
    const test = await setup();
    const auth = fakeAuth('https://wallet.test');
    const app = createApp({
      stores: { ...auth.stores, sessions: createSessionStore(env, clock) },
      clock,
    });
    const own = await makeSession(f, { userId: test.author.userId });
    const outsider = await makeSession(f, { userId: test.foreign.userId });
    const body = {
      ...test.scope,
      version: test.version,
      sourceReleaseId: test.source.id,
      projection,
    };
    const path = `https://wallet.test/api/v1/templates/${test.templateId}/candidates`;
    const post = (headers: Record<string, string>, json: unknown) =>
      app.request(
        path,
        {
          method: 'POST',
          headers: {
            ...headers,
            origin: 'https://wallet.test',
            'content-type': 'application/json',
          },
          body: JSON.stringify(json),
        },
        env,
      );
    const denied = await post(outsider.headers, body);
    expect(denied.status).toBeGreaterThanOrEqual(400);
    expect(denied.status).toBeLessThan(500);
    expect((await post({ ...own.headers, 'x-passbook-mode': 'test' }, body)).status).toBe(403);
    const created = await post(own.headers, body);
    expect(created.status).toBe(201);
    const result = (await created.json()) as TemplateCandidate & {
      sourceReleaseId: string;
      projection: unknown;
    };
    expect(result).toMatchObject({ sourceReleaseId: test.source.id, projection });
    const reviewed = await app.request(
      `${path}/${result.id}/approve`,
      {
        method: 'POST',
        headers: {
          ...own.headers,
          origin: 'https://wallet.test',
          'content-type': 'application/json',
        },
        body: JSON.stringify({ ...test.scope, candidateHash: result.candidateHash }),
      },
      env,
    );
    expect(reviewed.status).toBe(403);
  });

  it('uses compare-and-swap when two independently approved candidates race to publish', async () => {
    const test = await setup();
    const first = await nativeCandidate(test);
    const second = await nativeCandidate(test);
    const firstApproval = await nativeApproval(test, first);
    const secondApproval = await nativeApproval(test, second);
    const attempts = await Promise.allSettled([
      nativePublish(test, first, firstApproval),
      nativePublish(test, second, secondApproval),
    ]);
    expect(attempts.filter((item) => item.status === 'fulfilled')).toHaveLength(1);
    expect(attempts.filter((item) => item.status === 'rejected')).toHaveLength(1);
  });

  it('keeps release and approval history reads bounded as generations grow', async () => {
    const test = await setup();
    const first = await nativeCandidate(test);
    const firstApproval = await nativeApproval(test, first);
    const firstRelease = await nativePublish(test, first, firstApproval);
    const counted = countD1(env.DB);
    const countedCtx = { ...test.ctx, env: { ...test.ctx.env, DB: counted.db } };
    await listProjectionReleases(countedCtx, test.author, test.templateId, test.scope);
    counted.reset();
    const initial = await listProjectionReleases(
      countedCtx,
      test.author,
      test.templateId,
      test.scope,
    );
    const firstCount = counted.count();
    expect(initial.items.map((release) => release.id)).toEqual([firstRelease.id]);

    const second = await nativeCandidate(test);
    const secondApproval = await nativeApproval(test, second);
    const secondRelease = await nativePublish(test, second, secondApproval, 1);
    counted.reset();
    const history = await listProjectionReleases(
      countedCtx,
      test.author,
      test.templateId,
      test.scope,
    );
    expect(history.items.map((release) => release.id)).toEqual([secondRelease.id, firstRelease.id]);
    expect(history.items[0]).toMatchObject({
      candidateId: second.id,
      approvalId: secondApproval.id,
      sourceReleaseId: test.source.id,
      accountRevision: 1,
    });
    expect(history.items[1]).toMatchObject({
      candidateId: first.id,
      approvalId: firstApproval.id,
      sourceReleaseId: test.source.id,
      accountRevision: 1,
    });
    expect(counted.count()).toBe(firstCount);

    counted.reset();
    const candidates = await listProjectionCandidates(
      countedCtx,
      test.author,
      test.templateId,
      test.scope,
    );
    expect(candidates.items.find((candidate) => candidate.id === first.id)?.approvals).toHaveLength(
      1,
    );
    expect(
      candidates.items.find((candidate) => candidate.id === second.id)?.approvals,
    ).toHaveLength(1);
    expect(
      counted
        .sql()
        .filter((sql) => sql.includes('FROM template_approvals a JOIN template_candidates c')),
    ).toHaveLength(1);
  });

  it('rechecks the Apple source in the actual publication statement', async () => {
    const test = await setup();
    const candidate = await nativeCandidate(test);
    const approval = await nativeApproval(test, candidate);
    const stored = await getProjectionCandidate(env.DB, candidate.id);
    const storedApproval = await getApproval(env.DB, approval.id);
    if (!stored || !storedApproval) throw new Error('Candidate or approval missing.');
    const authority = await authorizeTemplateWrite(
      test.ctx,
      test.author,
      test.scope.orgId,
      'templates:publish',
    );
    expect(
      await ensureSamsungProjectionEvidence(
        test.ctx,
        candidate.id,
        candidate.candidateHash,
        test.proof,
      ),
    ).toBe(true);
    const statement = insertProjectionReleaseStmt(env.DB, {
      id: test.ctx.ids.id(),
      candidate: stored,
      approval: storedApproval,
      authority,
      expectedGeneration: 0,
      expectedReleaseId: null,
      action: 'release',
      targetReleaseId: null,
      now: clock.now(),
      ...test.proof,
    });
    const next = await createCandidate(test.ctx, test.author, test.templateId, {
      ...test.apple,
      version: test.version,
    });
    const nextApproval = await approveCandidate(test.ctx, test.reviewer, test.templateId, next.id, {
      ...test.apple,
      candidateHash: next.candidateHash,
    });
    await publishRelease(test.ctx, test.author, test.templateId, {
      ...test.apple,
      candidateId: next.id,
      approvalId: nextApproval.id,
      candidateHash: next.candidateHash,
      expectedGeneration: 1,
    });
    expect((await statement.run()).meta.changes).toBe(0);
  });

  it('rejects provider evidence that expires before the publication statement', async () => {
    const test = await setup();
    const candidate = await nativeCandidate(test);
    const approval = await nativeApproval(test, candidate);
    const stored = await getProjectionCandidate(env.DB, candidate.id);
    const storedApproval = await getApproval(env.DB, approval.id);
    if (!stored || !storedApproval) throw new Error('Candidate or approval missing.');
    const authority = await authorizeTemplateWrite(
      test.ctx,
      test.author,
      test.scope.orgId,
      'templates:publish',
    );
    expect(
      await ensureSamsungProjectionEvidence(
        test.ctx,
        candidate.id,
        candidate.candidateHash,
        test.proof,
      ),
    ).toBe(true);
    const statement = insertProjectionReleaseStmt(env.DB, {
      id: test.ctx.ids.id(),
      candidate: stored,
      approval: storedApproval,
      authority,
      expectedGeneration: 0,
      expectedReleaseId: null,
      action: 'release',
      targetReleaseId: null,
      now: clock.now() + 300_000,
      ...test.proof,
    });
    expect((await statement.run()).meta.changes).toBe(0);
  });
  it('requires an explicitly bound trusted clock for the atomic issuance predicate', () => {
    expect(() =>
      projectionReleaseBindingPredicateSql({
        releaseIdSql: 'p.release_id',
        orgIdSql: 'p.org_id',
        modeSql: 'p.mode',
        providerSql: 'p.provider',
        templateIdSql: 'p.template_id',
        versionSql: 'p.template_version',
        sourceReleaseIdSql: 'p.source_id',
        credentialKeysetCommitmentSql: 'p.credential_keyset_commitment',
      }),
    ).toThrow();
  });

  it('retains the original keyset in candidates, reviews, releases and evidence across a rekey', async () => {
    const test = await setup();
    const published = await nativeCandidate(test);
    const publishedApproval = await nativeApproval(test, published);
    const release = await nativePublish(test, published, publishedApproval);
    const unreviewed = await nativeCandidate(test);
    const waiting = await nativeCandidate(test);
    const waitingApproval = await nativeApproval(test, waiting);
    expect(
      await ensureSamsungProjectionEvidence(
        test.ctx,
        waiting.id,
        waiting.candidateHash,
        test.proof,
      ),
    ).toBe(true);
    for (const [table, column, id] of [
      ['template_candidates', 'id', published.id],
      ['template_approvals', 'id', publishedApproval.id],
      ['template_releases', 'id', release.id],
      ['wallet_provider_projection_evidence', 'candidate_id', published.id],
      ['wallet_provider_projection_evidence_history', 'candidate_id', published.id],
    ]) {
      expect(
        await first(
          env.DB,
          `SELECT credential_keyset_commitment AS commitment FROM ${table} WHERE ${column} = ?`,
          [id],
        ),
      ).toEqual({ commitment: test.proof.credentialKeysetCommitment });
    }
    expect(
      await getApprovedProjection(test.ctx, lookup(test), {} as WalletCredentialKeysetProof),
    ).toBeNull();

    const newKey = btoa('z'.repeat(32));
    const newCommitment = await credentialRefKeysetCommitment({ ...env, KEK_V1: newKey });
    const newProof = { credentialKeysetCommitment: newCommitment };
    expect(newCommitment).not.toBe(test.proof.credentialKeysetCommitment);
    const oldKey = env.KEK_V1;
    try {
      // The account is encrypted under V2, so the changed oldest KEK does not make decryption fail.
      env.KEK_V1 = newKey;
      expect(await getApprovedProjection(test.ctx, lookup(test), test.proof)).toBeNull();
      await replaceCallbackKeysetForTest(env.DB, newCommitment);
      const account = await findAccount(env.DB, test.scope);
      if (
        !account?.credential_id ||
        account.kek_version === null ||
        account.iv === null ||
        account.wrapped_dek === null ||
        account.ciphertext === null
      )
        throw new Error('Missing configured account envelope');
      const bytes = (value: number[] | Uint8Array | ArrayBuffer) =>
        value instanceof ArrayBuffer ? new Uint8Array(value) : new Uint8Array(value);
      const cleartext = await decryptSecretText(
        await loadKekRing(env),
        {
          kekVersion: account.kek_version,
          iv: bytes(account.iv),
          wrappedDek: bytes(account.wrapped_dek),
          ciphertext: bytes(account.ciphertext),
        },
        credentialAad(
          account.credential_id,
          account.org_id,
          `wallet-provider:${account.id}:${account.mode}:${account.provider}`,
        ),
      );
      expect(JSON.parse(cleartext)).toMatchObject({ provider: 'samsung' });
      for (let retry = 0; retry < 2; retry++) {
        await expect(nativeApproval(test, unreviewed)).rejects.toMatchObject({
          code: 'WALLET_PROJECTION_CONFLICT',
        });
        await expect(nativePublish(test, waiting, waitingApproval, 1)).rejects.toMatchObject({
          code: 'WALLET_PROJECTION_CONFLICT',
        });
        expect(
          await ensureSamsungProjectionEvidence(
            test.ctx,
            waiting.id,
            waiting.candidateHash,
            newProof,
          ),
        ).toBe(false);
        expect(await getApprovedProjection(test.ctx, lookup(test), newProof)).toBeNull();
        expect(await getProjectionRetirementMetadata(env.DB, release.id, newProof)).toBeNull();
      }
      expect(
        (await listProjectionCandidates(test.ctx, test.author, test.templateId, test.scope)).items,
      ).toEqual([]);
      expect(
        (await listProjectionReleases(test.ctx, test.author, test.templateId, test.scope)).items,
      ).toEqual([]);
      expect(
        await first(env.DB, 'SELECT count(*) AS n FROM template_approvals WHERE candidate_id = ?', [
          unreviewed.id,
        ]),
      ).toEqual({ n: 0 });
      expect(
        await first(env.DB, 'SELECT count(*) AS n FROM template_releases WHERE candidate_id = ?', [
          waiting.id,
        ]),
      ).toEqual({ n: 0 });
    } finally {
      env.KEK_V1 = oldKey;
      await replaceCallbackKeysetForTest(env.DB, test.proof.credentialKeysetCommitment);
    }
    expect(await getApprovedProjection(test.ctx, lookup(test), test.proof)).toMatchObject({
      release: { id: release.id },
    });
  });

  it('never adopts a legacy candidate, approval or release with missing keyset provenance', async () => {
    const test = await setup();
    const candidate = await nativeCandidate(test);
    const approval = await nativeApproval(test, candidate);
    const release = await nativePublish(test, candidate, approval);
    for (const [table, id] of [
      ['template_candidates', candidate.id],
      ['template_approvals', approval.id],
      ['template_releases', release.id],
    ]) {
      const triggerName = `${table}_immutable`;
      const trigger = await first<{ sql: string }>(
        env.DB,
        "SELECT sql FROM sqlite_master WHERE type = 'trigger' AND name = ?",
        [triggerName],
      );
      if (!trigger?.sql) throw new Error('Missing immutable projection trigger');
      // Model a row that predates the nullable proof column, without weakening the deployed schema.
      await run(env.DB, `DROP TRIGGER ${triggerName}`);
      try {
        await run(env.DB, `UPDATE ${table} SET credential_keyset_commitment = NULL WHERE id = ?`, [
          id,
        ]);
        for (let retry = 0; retry < 2; retry++) {
          expect(await getApprovedProjection(test.ctx, lookup(test), test.proof)).toBeNull();
          expect(await getProjectionRetirementMetadata(env.DB, release.id, test.proof)).toBeNull();
          expect(
            (await listProjectionReleases(test.ctx, test.author, test.templateId, test.scope))
              .items,
          ).toEqual([]);
        }
        expect(
          await first(
            env.DB,
            `SELECT credential_keyset_commitment AS commitment FROM ${table} WHERE id = ?`,
            [id],
          ),
        ).toEqual({ commitment: null });
      } finally {
        await run(env.DB, `UPDATE ${table} SET credential_keyset_commitment = ? WHERE id = ?`, [
          test.proof.credentialKeysetCommitment,
          id,
        ]);
        await run(env.DB, trigger.sql);
      }
    }
  });

  it('does not recreate a missing singleton when reading or mutating a projection', async () => {
    const test = await setup();
    const candidate = await nativeCandidate(test);
    const approval = await nativeApproval(test, candidate);
    const release = await nativePublish(test, candidate, approval);
    try {
      await replaceCallbackKeysetForTest(env.DB, null);
      expect(await getApprovedProjection(test.ctx, lookup(test), test.proof)).toBeNull();
      expect(await getProjectionRetirementMetadata(env.DB, release.id, test.proof)).toBeNull();
      await expect(nativeCandidate(test)).rejects.toMatchObject({
        code: 'CREDENTIAL_REF_KEYSET_UNAVAILABLE',
      });
      expect(
        await first(env.DB, 'SELECT commitment FROM credential_ref_keyset WHERE id = 1'),
      ).toBeNull();
    } finally {
      await replaceCallbackKeysetForTest(env.DB, test.proof.credentialKeysetCommitment);
    }
  });

  it('fences candidate, review and publication at their actual final SQL statements', async () => {
    const test = await setup();
    const unreviewed = await nativeCandidate(test);
    const waiting = await nativeCandidate(test);
    const approval = await nativeApproval(test, waiting);
    expect(
      await ensureSamsungProjectionEvidence(
        test.ctx,
        waiting.id,
        waiting.candidateHash,
        test.proof,
      ),
    ).toBe(true);
    const replacement = await credentialRefKeysetCommitment({
      ...env,
      KEK_V1: btoa('y'.repeat(32)),
    });
    const before = await first(
      env.DB,
      'SELECT count(*) AS n FROM template_candidates WHERE template_id = ?',
      [test.templateId],
    );
    for (const stage of ['candidate', 'approval', 'release'] as const) {
      const table =
        stage === 'candidate'
          ? 'template_candidates'
          : stage === 'approval'
            ? 'template_approvals'
            : 'template_releases';
      const seam = interveneAtD1(
        env.DB,
        { method: 'batch', sql: new RegExp(`INSERT INTO ${table}\\b`), when: 'before' },
        () => replaceCallbackKeysetForTest(env.DB, replacement),
      );
      const raced = { ...test, ctx: { ...test.ctx, env: { ...test.ctx.env, DB: seam.db } } };
      try {
        const operation =
          stage === 'candidate'
            ? nativeCandidate(raced)
            : stage === 'approval'
              ? nativeApproval(raced, unreviewed)
              : nativePublish(raced, waiting, approval);
        await expect(operation).rejects.toMatchObject({ code: 'WALLET_PROJECTION_CONFLICT' });
        expect(seam.hits()).toBe(1);
      } finally {
        await replaceCallbackKeysetForTest(env.DB, test.proof.credentialKeysetCommitment);
      }
    }
    expect(
      await first(env.DB, 'SELECT count(*) AS n FROM template_candidates WHERE template_id = ?', [
        test.templateId,
      ]),
    ).toEqual(before);
    expect(
      await first(env.DB, 'SELECT count(*) AS n FROM template_approvals WHERE candidate_id = ?', [
        unreviewed.id,
      ]),
    ).toEqual({ n: 0 });
    expect(
      await first(env.DB, 'SELECT count(*) AS n FROM template_releases WHERE candidate_id = ?', [
        waiting.id,
      ]),
    ).toEqual({ n: 0 });
  });

  it('fences rollback publication with the original keyset at commit', async () => {
    const test = await setup();
    const firstCandidate = await nativeCandidate(test);
    const firstApproval = await nativeApproval(test, firstCandidate);
    const firstRelease = await nativePublish(test, firstCandidate, firstApproval);
    const secondCandidate = await nativeCandidate(test);
    const secondApproval = await nativeApproval(test, secondCandidate);
    await nativePublish(test, secondCandidate, secondApproval, 1);
    const replacement = await credentialRefKeysetCommitment({
      ...env,
      KEK_V1: btoa('v'.repeat(32)),
    });
    const seam = interveneAtD1(
      env.DB,
      {
        method: 'batch',
        sql: /INSERT INTO template_releases\b/,
        when: 'before',
      },
      () => replaceCallbackKeysetForTest(env.DB, replacement),
    );
    try {
      const ctx = { ...test.ctx, env: { ...test.ctx.env, DB: seam.db } };
      await expect(
        rollbackProjectionRelease(ctx, test.author, test.templateId, {
          ...test.scope,
          releaseId: firstRelease.id,
          candidateHash: firstCandidate.candidateHash,
          expectedGeneration: 2,
          reason: 'Restore reviewed projection',
        }),
      ).rejects.toMatchObject({ code: 'WALLET_PROJECTION_CONFLICT' });
      expect(seam.hits()).toBe(1);
      expect(
        await first(
          env.DB,
          'SELECT count(*) AS n FROM template_releases WHERE template_id = ? AND provider = ?',
          [test.templateId, 'samsung'],
        ),
      ).toEqual({ n: 2 });
    } finally {
      await replaceCallbackKeysetForTest(env.DB, test.proof.credentialKeysetCommitment);
    }
  });

  it('pins the pre-await KEK ring and rejects a keyset change across credential decryption', async () => {
    const test = await setup();
    const decrypt = crypto.subtle.decrypt.bind(crypto.subtle);
    const replacement = await credentialRefKeysetCommitment({
      ...env,
      KEK_V1: btoa('x'.repeat(32)),
    });
    const mutable = { ...test.ctx, env: { ...test.ctx.env } };
    let count = 0;
    let changeSingleton = false;
    const spy = vi
      .spyOn(crypto.subtle, 'decrypt')
      .mockImplementation(async (algorithm, key, data) => {
        const result = await decrypt(algorithm, key, data);
        if (++count === 2) {
          if (changeSingleton) await replaceCallbackKeysetForTest(env.DB, replacement);
          else mutable.env.KEK_V1 = btoa('x'.repeat(32));
        }
        return result;
      });
    try {
      const firstCandidate = await nativeCandidate({ ...test, ctx: mutable });
      expect(
        (await getProjectionCandidate(env.DB, firstCandidate.id))?.credentialKeysetCommitment,
      ).toBe(test.proof.credentialKeysetCommitment);
      expect(count).toBe(2);
      mutable.env.KEK_V1 = KEK_V1;
      count = 0;
      changeSingleton = true;
      const before = await first(
        env.DB,
        'SELECT count(*) AS n FROM template_candidates WHERE template_id = ?',
        [test.templateId],
      );
      await expect(nativeCandidate({ ...test, ctx: mutable })).rejects.toMatchObject({
        code: 'CREDENTIAL_REF_KEYSET_UNAVAILABLE',
      });
      expect(count).toBe(2);
      expect(
        await first(env.DB, 'SELECT count(*) AS n FROM template_candidates WHERE template_id = ?', [
          test.templateId,
        ]),
      ).toEqual(before);
    } finally {
      spy.mockRestore();
      await replaceCallbackKeysetForTest(env.DB, test.proof.credentialKeysetCommitment);
    }
  });

  it('does not disclose a verified projection when the keyset changes at the final read', async () => {
    const test = await setup();
    const candidate = await nativeCandidate(test);
    const approval = await nativeApproval(test, candidate);
    const release = await nativePublish(test, candidate, approval);
    const binding = {
      ...test.scope,
      releaseId: release.id,
      templateId: test.templateId,
      version: test.version,
      sourceReleaseId: test.source.id,
      now: clock.now(),
      ...test.proof,
    };
    expect(await projectionReleaseBindingValid(env.DB, binding)).toBe(true);
    const replacement = await credentialRefKeysetCommitment({
      ...env,
      KEK_V1: btoa('w'.repeat(32)),
    });
    const seam = interveneAtD1(
      env.DB,
      {
        method: 'first',
        sql: /SELECT 1 AS ok FROM\s+\(SELECT \? AS release_id/,
        when: 'before',
      },
      () => replaceCallbackKeysetForTest(env.DB, replacement),
    );
    try {
      const ctx = { ...test.ctx, env: { ...test.ctx.env, DB: seam.db } };
      expect(await getApprovedProjection(ctx, lookup(test), test.proof)).toBeNull();
      expect(seam.hits()).toBe(1);
      expect(await projectionReleaseBindingValid(env.DB, binding)).toBe(false);
    } finally {
      await replaceCallbackKeysetForTest(env.DB, test.proof.credentialKeysetCommitment);
    }
  });

  it('does not serve a release after a referenced source asset is modified', async () => {
    const test = await setup();
    const candidate = await nativeCandidate(test);
    const approval = await nativeApproval(test, candidate);
    await nativePublish(test, candidate, approval);
    const version = await getVersion(env.DB, test.templateId, test.version);
    const asset = version?.assets.find((entry) => entry.source.kind === 'r2');
    if (asset?.source.kind !== 'r2') throw new Error('R2 test asset missing.');
    const original = await env.BUCKET.get(asset.source.key);
    if (!original) throw new Error('R2 test bytes missing.');
    const bytes = await original.arrayBuffer();
    try {
      await env.BUCKET.put(asset.source.key, new Uint8Array([1, 2, 3]));
      expect(await getApprovedProjection(test.ctx, lookup(test), test.proof)).toBeNull();
    } finally {
      await env.BUCKET.put(asset.source.key, bytes);
    }
  });

  it('rejects unknown native objects and unrepresented Apple semantics', async () => {
    const test = await setup();
    const version = await getVersion(env.DB, test.templateId, test.version);
    if (!version) throw new Error('Version missing.');
    const parsed = normalizeNativeProjection(projection);
    expect(() => assertProjectionSource(parsed, version)).not.toThrow();
    const google = normalizeNativeProjection(googleProjection);
    expect(() => assertProjectionSource(google, version)).not.toThrow();
    expect(NativeProjectionSchema.safeParse({ ...projection, cardType: 'ticket' }).success).toBe(
      false,
    );
    expect(
      NativeProjectionSchema.safeParse({ ...projection, nativeObject: { extra: true } }).success,
    ).toBe(false);
    for (const extra of [
      { nfc: { message: 'secret' } },
      { featuredActions: [] },
      { expirationDate: '2030-01-01' },
      {
        generic: {
          primaryFields: [{ key: 'name', label: 'Name', value: 'Ada', changeMessage: '%@' }],
        },
      },
    ]) {
      expect(() =>
        assertProjectionSource(parsed, { ...version, passJson: { ...version.passJson, ...extra } }),
      ).toThrow();
    }
    expect(() =>
      assertProjectionSource(parsed, {
        ...version,
        manifest: { ...version.manifest, nfc: { enabled: true } },
      }),
    ).toThrow();
    expect(() =>
      assertProjectionSource(parsed, {
        ...version,
        assets: [...version.assets, { ...version.assets[0]!, name: 'strip.png', slot: 'strip' }],
      }),
    ).toThrow();
    expect(GOOGLE_PROJECTION_POLICY.adapterRevision).toBe(1);
  });
});
