import { describe, expect, it } from 'vitest';
import { omissionKeys, reportHash } from '../../../passkit/wallets/fidelity.ts';
import { googleCompiler } from '../../../passkit/wallets/google/compilers.ts';
import { run } from '../../platform/db.ts';
import { basicPackage, makePng, zipOf } from '../templates/package/fixtures.ts';
import { canonicalJson } from '../templates/package/hash.ts';
import { templateContentHash } from '../templates/release-content.ts';
import { getVersion } from '../templates/repo.ts';
import { listVersionExtras } from '../templates/repo-preview-extras.ts';
import { importZip } from '../templates/testing.ts';
import {
  NativeProjectionSchema,
  normalizeNativeProjection,
  type SamsungProjection,
} from './projection-contract.ts';
import { computeProjectionPins, walletsHash } from './projection-pins.ts';
import { pipelineRevision } from './projection-pipeline.ts';
import {
  approveProjectionCandidate,
  getApprovedProjection,
  listProjectionReleases,
  publishProjectionRelease,
} from './projection-service.ts';
import { assertProjectionSource } from './projection-source.ts';
import {
  candidateOf,
  installV2Env,
  LOGO,
  lookup,
  manifest,
  pinsOf,
  proof,
  released,
  request,
  S,
  setup,
} from './projection-v2-test-fixtures.ts';
import { walletProviderDisabledReason } from './provider-policy.ts';
import { renderGoogleProjection } from './render-projection.ts';

installV2Env();

const loadVersion = async (templateId: string, version: string) => {
  const row = await getVersion(S.env.DB, templateId, version);
  if (!row) throw new Error('Version missing.');
  return row;
};
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

describe('schema 2 candidate pins', () => {
  it('pins the compiler, pipeline, wallets hash, report hash and approved omissions', async () => {
    const kit = await setup();
    const version = await loadVersion(kit.templateId, kit.version);
    const { pins, report } = await computeProjectionPins(kit.ctx, 'google', version);
    const candidate = await candidateOf(kit, request(pins.approvedOmissions));
    expect(candidate.projection).toEqual(pins);
    expect(pins).toEqual({
      schema: 2,
      provider: 'google',
      type: report.type,
      compilerRevision: googleCompiler.revision,
      pipeline: await pipelineRevision('google'),
      wallets: await walletsHash(version.manifest.wallets),
      report: await reportHash(report),
      approvedOmissions: omissionKeys(report),
    });
    expect(NativeProjectionSchema.safeParse(pins).success).toBe(true);
  });

  it('covers the whole report pipeline, not only the compiler revision', async () => {
    const google = await pipelineRevision('google');
    expect(google).toMatch(/^[0-9a-f]{64}$/);
    expect(await pipelineRevision('samsung')).not.toBe(google);
    googleCompiler.revision += 1;
    try {
      expect(await pipelineRevision('google')).not.toBe(google);
    } finally {
      googleCompiler.revision -= 1;
    }
    expect(await pipelineRevision('google')).toBe(google);
  });

  it('refuses a candidate that does not name exactly the omissions the report has', async () => {
    const kit = await setup();
    await expect(candidateOf(kit, request(['sharing@nowhere']))).rejects.toMatchObject({
      code: 'WALLET_PROJECTION_CONFLICT',
    });
    const pins = await pinsOf(kit);
    await expect(candidateOf(kit, { ...pins, report: '0'.repeat(64) })).rejects.toMatchObject({
      code: 'WALLET_PROJECTION_CONFLICT',
    });
  });

  it('refuses a target that is off', async () => {
    const kit = await setup({}, { schema: 1, google: { type: 'off' } });
    await expect(candidateOf(kit, request())).rejects.toMatchObject({
      code: 'WALLET_PROJECTION_BLOCKED',
    });
  });

  it('is bound to the wallets block of the version', async () => {
    const a = await setup({}, { schema: 1, google: { type: 'generic' } });
    const b = await setup({}, { schema: 1, google: { type: 'loyalty' } });
    expect((await pinsOf(a)).wallets).not.toBe((await pinsOf(b)).wallets);
  });
});

describe('schema 1 and the Google publish path', () => {
  it('refuses schema 1 for publish, with its own code and in the database', async () => {
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
    await expect(
      run(
        S.env.DB,
        `INSERT INTO template_releases
        (id, template_id, org_id, mode, provider, generation, version, candidate_hash, content_hash,
         adapter_revision, adapter_capabilities, audience_policy_revision, source, action, candidate_id,
         approval_id, previous_release_id, rollback_of_release_id, created_by, created_at, credential_keyset_commitment)
        SELECT ?, c.template_id, c.org_id, c.mode, c.provider, 1, c.version, c.candidate_hash, c.content_hash,
          c.adapter_revision, c.adapter_capabilities, c.audience_policy_revision, 'approved', 'release', c.id, ?,
          NULL, NULL, ?, ?, c.credential_keyset_commitment FROM template_candidates c WHERE c.id = ?`,
        [S.f.ids.id(), approval.id, kit.author.userId, S.clock.now(), candidate.id],
      ),
    ).rejects.toThrow('invalid provider release approval or source');
  });

  it('publishes a schema 2 Google release and keeps issuance closed', async () => {
    const kit = await setup();
    const pins = await pinsOf(kit);
    const candidate = await candidateOf(kit, request(pins.approvedOmissions));
    const release = await released(kit, candidate);
    expect(release).toMatchObject({ provider: 'google', generation: 1, candidateId: candidate.id });
    expect(await getApprovedProjection(kit.ctx, lookup(kit), await proof())).toMatchObject({
      release: { id: release.id, sourceReleaseId: kit.sourceId },
      projection: pins,
    });
    const list = await listProjectionReleases(kit.ctx, kit.author, kit.templateId, kit.scope);
    expect(list.active?.id).toBe(release.id);
    // The gate and the renderer both stay closed: nothing issues from a compiled projection yet.
    expect(walletProviderDisabledReason('google')).toBe('not_released');
    expect(renderGoogleProjection(pins, { formatVersion: 1 })).toBeNull();
    await expect(released(kit, candidate, 1)).rejects.toThrow();
  });

  it('refuses a schema 2 self-approval, in the service and in the database', async () => {
    const kit = await setup();
    const candidate = await candidateOf(kit, request((await pinsOf(kit)).approvedOmissions));
    // The candidate author is also the version author here.
    await expect(
      approveProjectionCandidate(kit.ctx, kit.author, kit.templateId, candidate.id, {
        ...kit.scope,
        candidateHash: candidate.candidateHash,
      }),
    ).rejects.toMatchObject({ code: 'TEMPLATE_SELF_APPROVAL' });
    await expect(
      run(
        S.env.DB,
        `INSERT INTO template_approvals (id, candidate_id, candidate_hash, reviewer_id, created_at,
          credential_keyset_commitment)
        SELECT ?, c.id, c.candidate_hash, c.author_id, ?, c.credential_keyset_commitment
        FROM template_candidates c WHERE c.id = ?`,
        [S.f.ids.id(), S.clock.now(), candidate.id],
      ),
    ).rejects.toThrow('stale provider projection source');
    expect(
      await approveProjectionCandidate(kit.ctx, kit.reviewer, kit.templateId, candidate.id, {
        ...kit.scope,
        candidateHash: candidate.candidateHash,
      }),
    ).toMatchObject({ reviewerId: kit.reviewer.userId });
  });

  it('keeps the final release trigger on the schema and Samsung-evidence rules', async () => {
    // The database is built from every migration, so this is the final trigger. The CASE on the
    // schema and both Samsung-only guards are what 0082 changed from 0038.
    const trigger = await S.env.DB.prepare(
      "SELECT sql FROM sqlite_master WHERE type = 'trigger' AND name = 'template_provider_releases_insert'",
    ).first<{ sql: string }>();
    const sql = (trigger?.sql ?? '').replace(/\s+/g, ' ');
    expect(sql).toContain("CASE c.provider WHEN 'google' THEN 2 ELSE 1 END");
    expect(sql.split("NEW.provider = 'samsung' AND NOT EXISTS (").length - 1).toBe(2);
    expect(sql).toContain("THEN RAISE(ABORT, 'invalid provider release approval or source')");
  });
});

describe('schema 1 and the wallets block', () => {
  const samsung = normalizeNativeProjection({
    ...schema1,
    provider: 'samsung',
    cardType: 'loyalty',
    cardSubType: 'others',
    countryCode: 'GB',
    appLinkLogo: 'https://example.test/app.png',
    appLinkName: 'Account',
    appLinkData: 'https://example.test/account',
  }) as SamsungProjection;
  const google = normalizeNativeProjection(schema1);

  it('accepts a manifest with wallets and ignores its art', async () => {
    const kit = await setup();
    const version = await loadVersion(kit.templateId, kit.version);
    expect(version.assets.some((asset) => asset.name === LOGO)).toBe(true);
    expect(() => assertProjectionSource(google, version)).not.toThrow();
  });

  it('fails closed when the target is off or a capability is required', async () => {
    const kit = await setup();
    const version = await loadVersion(kit.templateId, kit.version);
    const withWallets = (wallets: unknown) => ({
      ...version,
      manifest: { ...version.manifest, wallets } as typeof version.manifest,
    });
    for (const [projection, wallets] of [
      [samsung, { schema: 1, samsung: { type: 'off' } }],
      [google, { schema: 1, google: { type: 'off' } }],
      [samsung, { schema: 1, required: ['barcode.format'] }],
      [google, { schema: 1, required: ['role.memberId'] }],
      [google, 'not an object'],
      [google, { schema: 2 }],
      [google, {}],
    ] as const)
      expect(() => assertProjectionSource(projection, withWallets(wallets))).toThrow(
        /not supported/,
      );
    // Another target being off, or an empty required list, is not the author refusing this one.
    expect(() =>
      assertProjectionSource(samsung, withWallets({ schema: 1, google: { type: 'off' } })),
    ).not.toThrow();
    expect(() =>
      assertProjectionSource(google, withWallets({ schema: 1, required: [] })),
    ).not.toThrow();
  });
});

describe('wallets-only versions', () => {
  it('keeps the Apple content hash while the provider pins move', async () => {
    const kit = await setup({}, { schema: 1, google: { type: 'generic', images: { logo: LOGO } } });
    // Importing the same package with another wallets block saves a second version of the template.
    const next = await importZip(S.env, S.clock, {
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
    const [one, two] = [
      await loadVersion(kit.templateId, kit.version),
      await loadVersion(kit.templateId, second as string),
    ];
    const apple = async (row: typeof one) =>
      templateContentHash(
        kit.ctx,
        row,
        await listVersionExtras(S.env.DB, kit.templateId, row.version),
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
});

describe('art in the projection', () => {
  const prefix = { prefix: 'wallet-art/' };

  it('sizes without writing on a read, and writes the public copy on a store', async () => {
    const kit = await setup();
    const version = await loadVersion(kit.templateId, kit.version);
    const before = (await S.env.BUCKET.list(prefix)).objects.length;
    const dry = await computeProjectionPins(kit.ctx, 'google', version);
    expect((await S.env.BUCKET.list(prefix)).objects.length).toBe(before);
    expect(dry.art.hashes.size).toBe(0);
    expect(dry.art.sizes.get(LOGO)).toEqual({ width: 660, height: 660 });

    const stored = await computeProjectionPins(kit.ctx, 'google', version, 'store');
    const url = stored.art.urls.get(LOGO);
    const origin = S.env.PUBLIC_BASE_URL.replace(/\/+$/, '');
    expect(url).toMatch(new RegExp(`^${origin}/w/i/[0-9a-f]{64}\\.png$`));
    const sha = (url as string).slice(-68, -4);
    expect([...stored.art.hashes]).toEqual([sha]);
    expect((await S.env.BUCKET.get(`wallet-art/${sha}`))?.customMetadata?.kind).toBe(
      'template-art',
    );
    // Same pins either way: the review a reader sees is the one publication stores.
    expect(stored.pins).toEqual(dry.pins);
    const compiled = googleCompiler.compile(stored.view, {
      now: new Date(version.createdAt),
      omit: [],
    });
    expect(canonicalJson(compiled.objectBody)).toContain(url as string);
    // The Apple icon is far below Google's logo size, so it never gets an address.
    expect(stored.art.urls.has('icon.png')).toBe(false);
  });

  it('gives a file below the minimum no address and reports it', async () => {
    const kit = await setup({}, { schema: 1, google: { type: 'generic' } });
    const version = await loadVersion(kit.templateId, kit.version);
    const { art, report } = await computeProjectionPins(kit.ctx, 'google', version);
    expect(art.urls.has('icon.png')).toBe(false);
    expect(report.items.some((item) => item.capability.startsWith('image.'))).toBe(true);
  });
});
