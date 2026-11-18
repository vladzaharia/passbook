import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import {
  type Fixtures,
  fixtures,
  makeEnv,
  makeOrg,
  makeSession,
  makeUser,
} from '../../../../test/helpers/index.ts';
import { omissionKeys, reportHash } from '../../../passkit/wallets/fidelity.ts';
import { googleCompiler } from '../../../passkit/wallets/google/compilers.ts';
import type { TemplateCandidate } from '../../../shared/contracts/template-releases.ts';
import type { GoogleWalletCredentials } from '../../../shared/contracts/wallet-providers.ts';
import type { SessionAuth } from '../../platform/auth.ts';
import { ManualClock } from '../../platform/clock.ts';
import { run } from '../../platform/db.ts';
import type { AppEnv } from '../../platform/env.ts';
import { createServiceContext, type ServiceContext } from '../../platform/service-context.ts';
import { createSessionStore } from '../auth/sessions.ts';
import { requireCredentialRefKeyset } from '../passes/credential-keyset.ts';
import { basicPackage, makePng, passJson, zipOf } from '../templates/package/fixtures.ts';
import { canonicalJson } from '../templates/package/hash.ts';
import { templateContentHash } from '../templates/release-content.ts';
import { approveCandidate, createCandidate, publishRelease } from '../templates/releases.ts';
import { getVersion } from '../templates/repo.ts';
import { listVersionExtras } from '../templates/repo-preview-extras.ts';
import { fakeAssets, importZip } from '../templates/testing.ts';
import { configureWalletProviderAccount } from './account-service.ts';
import {
  NativeProjectionSchema,
  normalizeNativeProjection,
  type ProjectionV2,
} from './projection-contract.ts';
import { compilerRevision, computeProjectionPins, walletsHash } from './projection-pins.ts';
import {
  approveProjectionCandidate,
  createProjectionCandidate,
  getApprovedProjection,
  listProjectionReleases,
  publishProjectionRelease,
} from './projection-service.ts';
import { assertProjectionSource } from './projection-source.ts';
import { walletProviderDisabledReason } from './provider-policy.ts';
import { renderGoogleProjection } from './render-projection.ts';

const KEK_V1 = btoa(String.fromCharCode(...new Uint8Array(32).fill(7)));
const manifest = {
  schema: 1,
  name: 'Reviewed card',
  inputs: { type: 'object', properties: { name: { type: 'string' } } },
  sample: { name: 'Ada' },
  bindings: [{ to: { field: 'name' }, value: '{{name}}' }],
  display: { title: '{{name}}' },
};
const LOGO = 'wallets/google/logo.png';
const withLogo = { schema: 1, google: { images: { logo: LOGO } } };

let env: AppEnv;
let clock: ManualClock;
let f: Fixtures;
let google: GoogleWalletCredentials;

beforeAll(async () => {
  clock = new ManualClock();
  env = await makeEnv({ KEK_V1, KEK_V2: undefined, KEK_V3: undefined, ASSETS: fakeAssets() });
  f = fixtures(env, clock);
  google = {
    issuerId: '33880000000223344',
    serviceAccountEmail: 'wallet@example.iam.gserviceaccount.com',
    privateKeyPem: env.SIGNER_PLATFORM_PRIVATE_KEY,
    scopes: ['https://www.googleapis.com/auth/wallet_object.issuer'],
  };
});

async function member(orgId: string): Promise<SessionAuth> {
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

interface Kit {
  ctx: ServiceContext;
  orgId: string;
  author: SessionAuth;
  reviewer: SessionAuth;
  templateId: string;
  version: string;
  sourceId: string;
  scope: { orgId: string; mode: 'live'; provider: 'google' };
}

/** An uploaded template with a reviewed Apple release and a configured Google account. */
async function setup(
  files: Record<string, Uint8Array | string> = {},
  wallets: unknown = withLogo,
  existing?: Pick<Kit, 'orgId' | 'author' | 'reviewer'>,
): Promise<Kit> {
  const orgId = existing?.orgId ?? (await makeOrg(f)).id;
  const author = existing?.author ?? (await member(orgId));
  const reviewer = existing?.reviewer ?? (await member(orgId));
  const ctx = createServiceContext(env, { clock });
  const imported = await importZip(env, clock, {
    orgId,
    createdBy: author.userId,
    name: 'Wallet card',
    zip: zipOf(
      basicPackage(
        {
          'wallet.template.json': JSON.stringify({ ...manifest, wallets }),
          [LOGO]: makePng(660, 660),
          ...files,
        },
        passJson(),
      ),
    ),
  });
  if (!imported.result) throw new Error('Test template import failed.');
  const { templateId, version } = imported.result;
  const apple = { orgId, mode: 'live' as const, provider: 'apple' as const };
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
  const scope = { orgId, mode: 'live' as const, provider: 'google' as const };
  if (!existing)
    await configureWalletProviderAccount(ctx, author, {
      ...scope,
      expectedRevision: 0,
      credentials: google,
    });
  return { ctx, orgId, author, reviewer, templateId, version, sourceId: source.id, scope };
}

async function pinsOf(kit: Kit): Promise<ProjectionV2> {
  const row = await getVersion(env.DB, kit.templateId, kit.version);
  if (!row) throw new Error('Version missing.');
  return (await computeProjectionPins(kit.ctx, 'google', row)).pins;
}
const candidateOf = (kit: Kit, projection: unknown): Promise<TemplateCandidate> =>
  createProjectionCandidate(kit.ctx, kit.author, kit.templateId, {
    ...kit.scope,
    version: kit.version,
    sourceReleaseId: kit.sourceId,
    projection,
  });
async function released(kit: Kit, candidate: TemplateCandidate, expectedGeneration = 0) {
  const approval = await approveProjectionCandidate(
    kit.ctx,
    kit.reviewer,
    kit.templateId,
    candidate.id,
    { ...kit.scope, candidateHash: candidate.candidateHash },
  );
  return publishProjectionRelease(kit.ctx, kit.author, kit.templateId, {
    ...kit.scope,
    candidateId: candidate.id,
    approvalId: approval.id,
    candidateHash: candidate.candidateHash,
    expectedGeneration,
  });
}
const lookup = (kit: Kit) => ({
  ...kit.scope,
  templateId: kit.templateId,
  templateVersion: kit.version,
  appleReleaseId: kit.sourceId,
});
const proof = async () => ({
  credentialKeysetCommitment: await requireCredentialRefKeyset(env.DB, env),
});

/** Stands in for a compiler update: a new revision that adds an omission (or none). */
function updateCompiler(extra: boolean): () => void {
  const revision = googleCompiler.revision;
  const compile = googleCompiler.compile;
  googleCompiler.revision = revision + 1;
  if (extra)
    googleCompiler.compile = (view, options) => {
      const result = compile(view, options);
      return {
        ...result,
        items: [
          ...result.items,
          {
            capability: 'sharing',
            path: '',
            support: 'omitted',
            message: 'Google cannot prohibit sharing.',
          },
        ],
      };
    };
  return () => {
    googleCompiler.revision = revision;
    googleCompiler.compile = compile;
  };
}
let restore: (() => void) | undefined;
afterEach(() => {
  restore?.();
  restore = undefined;
});

describe('schema 2 candidate pins', () => {
  it('pins the compiler revision, wallets hash, report hash and approved omissions', async () => {
    const kit = await setup();
    const version = await getVersion(env.DB, kit.templateId, kit.version);
    if (!version) throw new Error('Version missing.');
    const { pins, report } = await computeProjectionPins(kit.ctx, 'google', version);
    const candidate = await candidateOf(kit, {
      schema: 2,
      provider: 'google',
      approvedOmissions: pins.approvedOmissions,
    });
    expect(candidate.projection).toEqual(pins);
    expect(pins).toEqual({
      schema: 2,
      provider: 'google',
      type: report.type,
      compilerRevision: googleCompiler.revision,
      wallets: await walletsHash(version.manifest.wallets),
      report: await reportHash(report),
      approvedOmissions: omissionKeys(report),
    });
    expect(NativeProjectionSchema.safeParse(pins).success).toBe(true);
    expect(compilerRevision('google')).toBe(googleCompiler.revision);
  });

  it('refuses a candidate that does not name exactly the omissions the report has', async () => {
    const kit = await setup();
    await expect(
      candidateOf(kit, { schema: 2, provider: 'google', approvedOmissions: ['sharing@nowhere'] }),
    ).rejects.toMatchObject({ code: 'WALLET_PROJECTION_CONFLICT' });
    const pins = await pinsOf(kit);
    await expect(candidateOf(kit, { ...pins, report: '0'.repeat(64) })).rejects.toMatchObject({
      code: 'WALLET_PROJECTION_CONFLICT',
    });
  });

  it('refuses a target that is off', async () => {
    const kit = await setup({}, { schema: 1, google: { type: 'off' } });
    await expect(
      candidateOf(kit, { schema: 2, provider: 'google', approvedOmissions: [] }),
    ).rejects.toMatchObject({ code: 'WALLET_PROJECTION_BLOCKED' });
  });

  it('is bound to the wallets block of the version', async () => {
    const a = await setup({}, { schema: 1, google: { type: 'generic' } });
    const b = await setup({}, { schema: 1, google: { type: 'loyalty' } });
    expect((await pinsOf(a)).wallets).not.toBe((await pinsOf(b)).wallets);
  });
});

describe('schema 1 and the Google publish path', () => {
  const schema1 = {
    schema: 1,
    provider: 'google',
    language: 'en',
    logoUrl: 'https://example.test/logo.png',
    sourceArtworkSlots: ['icon'],
    titleField: 'name',
    fields: ['name'],
    barcode: 'none',
  } as const;

  it('refuses schema 1 for publish, with its own code', async () => {
    const kit = await setup({}, undefined);
    const candidate = await candidateOf(kit, schema1);
    const approval = await approveProjectionCandidate(
      kit.ctx,
      kit.reviewer,
      kit.templateId,
      candidate.id,
      { ...kit.scope, candidateHash: candidate.candidateHash },
    );
    await expect(
      publishProjectionRelease(kit.ctx, kit.author, kit.templateId, {
        ...kit.scope,
        candidateId: candidate.id,
        approvalId: approval.id,
        candidateHash: candidate.candidateHash,
        expectedGeneration: 0,
      }),
    ).rejects.toMatchObject({ code: 'WALLET_PROJECTION_SCHEMA' });
    expect(await getApprovedProjection(kit.ctx, lookup(kit), await proof())).toBeNull();
    // The database refuses it too, not only the service.
    await expect(
      run(
        env.DB,
        `INSERT INTO template_releases
        (id, template_id, org_id, mode, provider, generation, version, candidate_hash, content_hash,
         adapter_revision, adapter_capabilities, audience_policy_revision, source, action, candidate_id,
         approval_id, previous_release_id, rollback_of_release_id, created_by, created_at, credential_keyset_commitment)
        SELECT ?, c.template_id, c.org_id, c.mode, c.provider, 1, c.version, c.candidate_hash, c.content_hash,
          c.adapter_revision, c.adapter_capabilities, c.audience_policy_revision, 'approved', 'release', c.id, ?,
          NULL, NULL, ?, ?, c.credential_keyset_commitment FROM template_candidates c WHERE c.id = ?`,
        [f.ids.id(), approval.id, kit.author.userId, clock.now(), candidate.id],
      ),
    ).rejects.toThrow('invalid provider release approval or source');
  });

  it('publishes a schema 2 Google release and keeps issuance closed', async () => {
    const kit = await setup();
    const pins = await pinsOf(kit);
    const candidate = await candidateOf(kit, {
      schema: 2,
      provider: 'google',
      approvedOmissions: pins.approvedOmissions,
    });
    const release = await released(kit, candidate);
    expect(release).toMatchObject({ provider: 'google', generation: 1, candidateId: candidate.id });
    const approved = await getApprovedProjection(kit.ctx, lookup(kit), await proof());
    expect(approved).toMatchObject({
      release: { id: release.id, sourceReleaseId: kit.sourceId },
      projection: pins,
      offersPaused: false,
    });
    const list = await listProjectionReleases(kit.ctx, kit.author, kit.templateId, kit.scope);
    expect(list.active?.id).toBe(release.id);
    // The gate and the renderer both stay closed: nothing issues from a compiled projection yet.
    expect(walletProviderDisabledReason('google')).toBe('not_released');
    expect(renderGoogleProjection(pins, { formatVersion: 1 })).toBeNull();
    // A second release of the same candidate is refused.
    await expect(released(kit, candidate, 1)).rejects.toThrow();
  });
});

describe('Q21: a compiler update that adds an omission', () => {
  it('pauses new offers until re-approval while state changes keep flowing', async () => {
    const kit = await setup();
    const pins = await pinsOf(kit);
    const first = await released(
      kit,
      await candidateOf(kit, {
        schema: 2,
        provider: 'google',
        approvedOmissions: pins.approvedOmissions,
      }),
    );
    expect((await getApprovedProjection(kit.ctx, lookup(kit), await proof()))?.offersPaused).toBe(
      false,
    );

    restore = updateCompiler(false);
    // Same report under a new revision: the approval carries forward.
    expect(await getApprovedProjection(kit.ctx, lookup(kit), await proof())).toMatchObject({
      release: { id: first.id },
      offersPaused: false,
    });
    restore();

    restore = updateCompiler(true);
    const paused = await getApprovedProjection(kit.ctx, lookup(kit), await proof());
    // The release stays current for passes already on the wallet; only new offers wait.
    expect(paused).toMatchObject({ release: { id: first.id }, offersPaused: true });

    // Review and publication need the pins as they are now.
    const stale = await candidateOf(kit, {
      schema: 2,
      provider: 'google',
      approvedOmissions: (await pinsOf(kit)).approvedOmissions,
    });
    expect(stale.projection).toMatchObject({ compilerRevision: googleCompiler.revision });
    expect((await pinsOf(kit)).approvedOmissions).toContain('sharing');
    const second = await released(kit, stale, 1);
    expect(second.generation).toBe(2);
    expect(await getApprovedProjection(kit.ctx, lookup(kit), await proof())).toMatchObject({
      release: { id: second.id },
      offersPaused: false,
    });
  });

  it('refuses to approve a candidate whose compiler revision moved', async () => {
    const kit = await setup();
    const pins = await pinsOf(kit);
    const candidate = await candidateOf(kit, {
      schema: 2,
      provider: 'google',
      approvedOmissions: pins.approvedOmissions,
    });
    restore = updateCompiler(false);
    await expect(
      approveProjectionCandidate(kit.ctx, kit.reviewer, kit.templateId, candidate.id, {
        ...kit.scope,
        candidateHash: candidate.candidateHash,
      }),
    ).rejects.toMatchObject({ code: 'WALLET_PROJECTION_CONFLICT' });
  });
});

describe('wallets-only versions', () => {
  it('keeps the Apple content hash while the provider pins move', async () => {
    const kit = await setup({}, { schema: 1, google: { type: 'generic', images: { logo: LOGO } } });
    // Importing the same package with another wallets block saves a second version of the template.
    const next = await importZip(env, clock, {
      orgId: kit.orgId,
      createdBy: kit.author.userId,
      name: 'Wallet card',
      zip: zipOf(
        basicPackage({
          'wallet.template.json': JSON.stringify({
            ...manifest,
            wallets: { schema: 1, google: { type: 'loyalty', images: { logo: LOGO } } },
          }),
          [LOGO]: makePng(660, 660),
        }),
      ),
    });
    expect(next.result?.templateId).toBe(kit.templateId);
    const second = next.result?.version;
    expect(second).not.toBe(kit.version);
    const load = async (name: string) => {
      const row = await getVersion(env.DB, kit.templateId, name);
      if (!row) throw new Error('Version missing.');
      return row;
    };
    const [one, two] = [await load(kit.version), await load(second as string)];
    const apple = async (row: typeof one) =>
      templateContentHash(
        kit.ctx,
        row,
        await listVersionExtras(env.DB, kit.templateId, row.version),
      );
    // Apple: the same content, so the same release content hash and no new Apple review.
    expect(await apple(one)).toBe(await apple(two));
    // Providers: another wallets block is another pin set, so Google needs its own approval.
    const [p1, p2] = [
      (await computeProjectionPins(kit.ctx, 'google', one)).pins,
      (await computeProjectionPins(kit.ctx, 'google', two)).pins,
    ];
    expect(p1.wallets).not.toBe(p2.wallets);
    expect(p1.report).not.toBe(p2.report);
  });

  it('is accepted by the schema 1 source check', async () => {
    const kit = await setup();
    const version = await getVersion(env.DB, kit.templateId, kit.version);
    if (!version?.manifest.wallets) throw new Error('Version has no wallets block.');
    expect(version.assets.some((asset) => asset.name === LOGO)).toBe(true);
    const projection = normalizeNativeProjection({
      schema: 1,
      provider: 'google',
      language: 'en',
      logoUrl: 'https://example.test/logo.png',
      sourceArtworkSlots: ['icon'],
      titleField: 'name',
      fields: ['name'],
      barcode: 'none',
    });
    expect(() => assertProjectionSource(projection, version)).not.toThrow();
  });
});

describe('art in the projection', () => {
  it('compiles Google art from derived copies on the public origin', async () => {
    const kit = await setup();
    const version = await getVersion(env.DB, kit.templateId, kit.version);
    if (!version) throw new Error('Version missing.');
    const { view, art } = await computeProjectionPins(kit.ctx, 'google', version);
    const url = art.urls.get(LOGO);
    expect(url).toMatch(
      new RegExp(`^${env.PUBLIC_BASE_URL.replace(/\/+$/, '')}/w/i/[0-9a-f]{64}\\.png$`),
    );
    expect(art.sizes.get(LOGO)).toEqual({ width: 660, height: 660 });
    const sha = (url as string).slice(-68, -4);
    const stored = await env.BUCKET.get(`wallet-art/${sha}`);
    expect(stored?.customMetadata?.kind).toBe('template-art');
    const compiled = googleCompiler.compile(view, { now: new Date(version.createdAt), omit: [] });
    expect(canonicalJson(compiled.objectBody)).toContain(url as string);
    // The Apple icon is far below Google's logo size, so it never gets an address.
    expect(art.urls.has('icon.png')).toBe(false);
  });

  it('gives a file below the minimum no address and reports it', async () => {
    const kit = await setup({}, { schema: 1, google: { type: 'generic' } });
    const version = await getVersion(env.DB, kit.templateId, kit.version);
    if (!version) throw new Error('Version missing.');
    const { art, report } = await computeProjectionPins(kit.ctx, 'google', version);
    expect(art.urls.has('icon.png')).toBe(false);
    expect(report.items.some((item) => item.capability.startsWith('image.'))).toBe(true);
  });
});
