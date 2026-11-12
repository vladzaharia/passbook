import { beforeAll, describe, expect, it } from 'vitest';
import {
  type Fixtures,
  fixtures,
  makeEnv,
  makeOrg,
  makeSession,
  makeUser,
} from '../../../../test/helpers/index.ts';
import type { TemplateRelease } from '../../../shared/contracts/template-releases.ts';
import { ManualClock } from '../../platform/clock.ts';
import { all, first, run, type SqlValue } from '../../platform/db.ts';
import type { AppEnv } from '../../platform/env.ts';
import { createServiceContext, type ServiceContext } from '../../platform/service-context.ts';
import { createSessionStore } from '../auth/sessions.ts';
import { basicPackage, zipOf } from './package/fixtures.ts';
import { type CommitArgs, commitVersion, type VersionBody } from './persist.ts';
import { activeRelease, approveCandidate, createCandidate, publishRelease } from './releases.ts';
import { getTemplate, insertVersionStmts, type NewVersion } from './repo.ts';
import { generatedSource, syncBakedTemplates } from './sync.ts';
import {
  bakedFrom,
  fakeAssets,
  importZip,
  sourceOf,
  type TemplateAuthorFixture,
  templateAuthor,
} from './testing.ts';

interface StoredVersion {
  template_id: string;
  version: string;
  build_key: string | null;
  manifest: string;
  pass_json: string;
  assets: string;
  report: string;
  created_by: string | null;
  created_at: number;
}

interface Snapshot {
  template: unknown;
  versions: unknown[];
  candidates: unknown[];
  approvals: unknown[];
  releases: unknown[];
  active: TemplateRelease | null;
}

type ChangedField = 'manifest' | 'pass_json' | 'assets' | 'report' | 'build_key';
const changedFields: ChangedField[] = ['manifest', 'pass_json', 'assets', 'report', 'build_key'];

let env: AppEnv;
let clock: ManualClock;
let f: Fixtures;
let ctx: ServiceContext;
let orgId: string;
let author: TemplateAuthorFixture;
let retryAuthor: TemplateAuthorFixture;
let original: StoredVersion;
let commit: CommitArgs;
let release: TemplateRelease;
let packageZip: Uint8Array;
let baseline: Snapshot;

async function session(userId: string) {
  const fixture = await makeSession(f, { userId });
  const auth = await createSessionStore(env, clock).resolve(fixture.cookieValue);
  if (!auth) throw new Error('Expected a real persisted session');
  return auth;
}

async function reviewerAndPublisher() {
  const user = await makeUser(f);
  const invitationId = f.ids.id();
  const now = clock.now();
  const roles = JSON.stringify(['template_reviewer', 'template_publisher']);
  await run(
    env.DB,
    `INSERT INTO org_invitations
    (id, org_id, email, roles, token_hash, created_at, expires_at, accepted_at)
    SELECT ?, ?, primary_email, ?, ?, ?, ?, ? FROM users WHERE id = ?`,
    [invitationId, orgId, roles, f.ids.token(), now, now + 3600_000, now, user.id],
  );
  await run(
    env.DB,
    `INSERT INTO org_memberships
    (id, org_id, user_id, invitation_id, roles, created_at) VALUES (?, ?, ?, ?, ?, ?)`,
    [f.ids.id(), orgId, user.id, invitationId, roles, now],
  );
  return session(user.id);
}

/**
 * `meta.changes` also counts trigger-owned writes (version identities, epochs), so count the
 * statement's own rows through RETURNING instead.
 */
async function ownRows(db: D1Database, sql: string, params: SqlValue[] = []) {
  return { changes: (await all(db, `${sql} RETURNING 1`, params)).length };
}

async function snapshot(): Promise<Snapshot> {
  const id = original.template_id;
  return {
    template: await first(env.DB, 'SELECT * FROM templates WHERE id = ?', [id]),
    versions: await all(
      env.DB,
      'SELECT * FROM template_versions WHERE template_id = ? ORDER BY version',
      [id],
    ),
    candidates: await all(
      env.DB,
      'SELECT * FROM template_candidates WHERE template_id = ? ORDER BY id',
      [id],
    ),
    approvals: await all(
      env.DB,
      `SELECT a.* FROM template_approvals a
      JOIN template_candidates c ON c.id = a.candidate_id WHERE c.template_id = ? ORDER BY a.id`,
      [id],
    ),
    releases: await all(
      env.DB,
      'SELECT * FROM template_releases WHERE template_id = ? ORDER BY mode, generation',
      [id],
    ),
    active: await activeRelease(ctx, id, orgId, 'live', 'apple'),
  };
}

function changed(field: ChangedField): { body: VersionBody; buildKey: string } {
  const body = commit.body;
  const buildKey = commit.buildKey;
  if (!buildKey) throw new Error('Expected a non-NULL build key');
  switch (field) {
    case 'manifest':
      return {
        body: { ...body, manifest: { ...body.manifest, name: 'Different manifest' } },
        buildKey,
      };
    case 'pass_json':
      return {
        body: { ...body, passJson: { ...body.passJson, description: 'Different pass' } },
        buildKey,
      };
    case 'assets': {
      const asset = body.assets[0];
      if (!asset) throw new Error('Expected an imported asset');
      return {
        body: {
          ...body,
          assets: [
            { ...asset, source: { kind: 'r2', key: 'different-asset' } },
            ...body.assets.slice(1),
          ],
        },
        buildKey,
      };
    }
    case 'report':
      return {
        body: {
          ...body,
          report: {
            ...body.report,
            issues: [
              ...body.report.issues,
              { severity: 'warning', code: 'CHANGED', message: 'Different report' },
            ],
          },
        },
        buildKey,
      };
    case 'build_key':
      return { body, buildKey: `${buildKey[0] === '0' ? '1' : '0'}${buildKey.slice(1)}` };
  }
}

function newVersion(body = commit.body, buildKey = commit.buildKey): NewVersion {
  if (!buildKey) throw new Error('Expected a non-NULL build key');
  return {
    templateId: original.template_id,
    version: body.version,
    buildKey,
    manifest: body.manifest,
    passJson: body.passJson,
    assets: body.assets,
    report: body.report,
    createdBy: retryAuthor.userId,
    createdAt: clock.now(),
  };
}

beforeAll(async () => {
  clock = new ManualClock(Date.now());
  env = await makeEnv({ ASSETS: fakeAssets() });
  f = fixtures(env, clock);
  ctx = createServiceContext(env, { clock });
  orgId = (await makeOrg(f)).id;
  author = await templateAuthor(env, clock, orgId);
  retryAuthor = await templateAuthor(env, clock, orgId);
  packageZip = zipOf(basicPackage());
  const imported = await importZip(env, clock, {
    orgId,
    name: 'Immutable Version',
    zip: packageZip,
    createdBy: author.userId,
    authority: author.authority,
  });
  if (!imported.result) throw new Error(`Import failed at ${imported.stages.join(', ')}`);
  const { templateId, version } = imported.result;

  // Publish through real tenant sessions and the reviewed-release workflow, not an active-version fixture.
  const authorSession = await session(author.userId);
  const reviewerSession = await reviewerAndPublisher();
  const scope = { orgId, mode: 'live' as const, provider: 'apple' as const };
  const candidate = await createCandidate(ctx, authorSession, templateId, { ...scope, version });
  const approval = await approveCandidate(ctx, reviewerSession, templateId, candidate.id, {
    ...scope,
    candidateHash: candidate.candidateHash,
  });
  release = await publishRelease(ctx, reviewerSession, templateId, {
    ...scope,
    candidateId: candidate.id,
    approvalId: approval.id,
    candidateHash: candidate.candidateHash,
    expectedGeneration: 0,
  });

  const row = await first<StoredVersion>(
    env.DB,
    `SELECT template_id, version, build_key, manifest,
    pass_json, assets, report, created_by, created_at FROM template_versions
    WHERE template_id = ? AND version = ?`,
    [templateId, version],
  );
  const template = await getTemplate(env.DB, templateId);
  if (!row || !template || !row.build_key)
    throw new Error('Expected a released version and build key');
  original = row;
  commit = {
    plan: { templateId, isNew: false, existing: template },
    orgId,
    slug: template.slug,
    name: template.name,
    description: template.description,
    createdBy: author.userId,
    guardActive: true,
    buildKey: row.build_key,
    authorities: [author.authority],
    body: {
      version,
      manifest: JSON.parse(row.manifest) as VersionBody['manifest'],
      passJson: JSON.parse(row.pass_json) as VersionBody['passJson'],
      assets: JSON.parse(row.assets) as VersionBody['assets'],
      report: JSON.parse(row.report) as VersionBody['report'],
      styles: template.styles,
    },
  };
  clock.advance(2000);
  baseline = await snapshot();
  // The API response names the publisher; the stored release does not.
  const { createdByName: _name, ...stored } = release;
  expect(baseline.active).toEqual(stored);
  expect(release).toMatchObject({ version, source: 'approved', generation: 1 });
}, 30_000);

describe('template version insert immutability', () => {
  it.each(['INSERT', 'INSERT OR IGNORE', 'INSERT OR REPLACE'] as const)(
    'rejects %s of an identical existing row before SQLite conflict handling',
    async (verb) => {
      await expect(
        run(
          env.DB,
          `${verb} INTO template_versions
        (template_id, version, build_key, manifest, pass_json, assets, report, created_by, created_at)
        SELECT template_id, version, build_key, manifest, pass_json, assets, report, created_by, created_at
        FROM template_versions WHERE template_id = ? AND version = ?`,
          [original.template_id, original.version],
        ),
      ).rejects.toThrow('template versions are immutable');
      expect(await snapshot()).toEqual(baseline);
    },
  );

  it('retires a deleted draft identity without blocking a different version', async () => {
    const draft = `unreferenced-sql-${f.ids.id()}`;
    expect(
      await ownRows(
        env.DB,
        `INSERT INTO template_versions
      (template_id, version, build_key, manifest, pass_json, assets, report, created_by, created_at)
      SELECT template_id, ?, build_key, manifest, pass_json, assets, report, created_by, created_at
      FROM template_versions WHERE template_id = ? AND version = ?`,
        [draft, original.template_id, original.version],
      ),
    ).toEqual({ changes: 1 });
    expect(
      await first(
        env.DB,
        'SELECT version FROM template_versions WHERE template_id = ? AND version = ?',
        [original.template_id, draft],
      ),
    ).toEqual({ version: draft });
    expect(
      await ownRows(env.DB, 'DELETE FROM template_versions WHERE template_id = ? AND version = ?', [
        original.template_id,
        draft,
      ]),
    ).toEqual({ changes: 1 });
    expect(
      await first(
        env.DB,
        `SELECT template_id, version FROM template_version_tombstones
      WHERE template_id = ? AND version = ?`,
        [original.template_id, draft],
      ),
    ).toEqual({ template_id: original.template_id, version: draft });
    await expect(
      run(
        env.DB,
        `UPDATE template_version_tombstones SET version = ?
      WHERE template_id = ? AND version = ?`,
        ['moved', original.template_id, draft],
      ),
    ).rejects.toThrow('template version tombstones are immutable');
    await expect(
      run(
        env.DB,
        `DELETE FROM template_version_tombstones
      WHERE template_id = ? AND version = ?`,
        [original.template_id, draft],
      ),
    ).rejects.toThrow('template version tombstones are immutable');
    const manifests = [
      original.manifest,
      JSON.stringify({ ...commit.body.manifest, name: 'Different retired content' }),
    ];
    for (const verb of ['INSERT', 'INSERT OR IGNORE', 'INSERT OR REPLACE'] as const) {
      for (const manifest of manifests) {
        await expect(
          run(
            env.DB,
            `${verb} INTO template_versions
          (template_id, version, build_key, manifest, pass_json, assets, report, created_by, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [
              original.template_id,
              draft,
              original.build_key,
              manifest,
              original.pass_json,
              original.assets,
              original.report,
              original.created_by,
              original.created_at,
            ],
          ),
        ).rejects.toThrow('template versions are immutable');
      }
    }
    expect(
      await first(
        env.DB,
        'SELECT version FROM template_versions WHERE template_id = ? AND version = ?',
        [original.template_id, draft],
      ),
    ).toBeNull();
    const next = `${draft}-next`;
    expect(
      await ownRows(
        env.DB,
        `INSERT INTO template_versions
      (template_id, version, build_key, manifest, pass_json, assets, report, created_by, created_at)
      SELECT template_id, ?, build_key, manifest, pass_json, assets, report, created_by, created_at
      FROM template_versions WHERE template_id = ? AND version = ?`,
        [next, original.template_id, original.version],
      ),
    ).toEqual({ changes: 1 });
    expect(
      await ownRows(env.DB, 'DELETE FROM template_versions WHERE template_id = ? AND version = ?', [
        original.template_id,
        next,
      ]),
    ).toEqual({ changes: 1 });
    expect(await snapshot()).toEqual(baseline);
  });

  it('retains retired identities after their template is deleted and recreated', async () => {
    const id = f.ids.id();
    const slug = `retired-${id}`;
    const draft = 'retired-with-template';
    const createTemplate = env.DB.prepare(`INSERT INTO templates
      (id, org_id, slug, name, description, origin, active_version, status, styles, created_by, created_at, updated_at)
      SELECT ?, org_id, ?, name, description, origin, NULL, status, styles, created_by, created_at, updated_at
      FROM templates WHERE id = ?`).bind(id, slug, original.template_id);
    expect((await createTemplate.run()).meta.changes).toBe(1);
    expect(
      await ownRows(
        env.DB,
        `INSERT INTO template_versions
      (template_id, version, build_key, manifest, pass_json, assets, report, created_by, created_at)
      SELECT ?, ?, build_key, manifest, pass_json, assets, report, created_by, created_at
      FROM template_versions WHERE template_id = ? AND version = ?`,
        [id, draft, original.template_id, original.version],
      ),
    ).toEqual({ changes: 1 });
    expect(await ownRows(env.DB, 'DELETE FROM templates WHERE id = ?', [id])).toEqual({
      changes: 1,
    });
    expect(
      await first(
        env.DB,
        `SELECT template_id, version FROM template_version_tombstones
      WHERE template_id = ? AND version = ?`,
        [id, draft],
      ),
    ).toEqual({ template_id: id, version: draft });
    expect((await createTemplate.run()).meta.changes).toBe(1);
    await expect(
      run(
        env.DB,
        `INSERT INTO template_versions
      (template_id, version, build_key, manifest, pass_json, assets, report, created_by, created_at)
      SELECT ?, ?, build_key, manifest, pass_json, assets, report, created_by, created_at
      FROM template_versions WHERE template_id = ? AND version = ?`,
        [id, draft, original.template_id, original.version],
      ),
    ).rejects.toThrow('template versions are immutable');
    // The same version string belongs to a different composite identity on another template.
    expect(
      await ownRows(
        env.DB,
        `INSERT INTO template_versions
      (template_id, version, build_key, manifest, pass_json, assets, report, created_by, created_at)
      SELECT template_id, ?, build_key, manifest, pass_json, assets, report, created_by, created_at
      FROM template_versions WHERE template_id = ? AND version = ?`,
        [draft, original.template_id, original.version],
      ),
    ).toEqual({ changes: 1 });
    expect(
      await ownRows(env.DB, 'DELETE FROM template_versions WHERE template_id = ? AND version = ?', [
        original.template_id,
        draft,
      ]),
    ).toEqual({ changes: 1 });
    expect(await ownRows(env.DB, 'DELETE FROM templates WHERE id = ?', [id])).toEqual({
      changes: 1,
    });
    expect(await snapshot()).toEqual(baseline);
  });
});

describe('commitVersion', () => {
  it('accepts an identical retry without replacing first-writer provenance or activating anything', async () => {
    expect(clock.now()).toBeGreaterThan(original.created_at);
    expect(retryAuthor.userId).not.toBe(original.created_by);
    await expect(
      commitVersion(ctx, {
        ...commit,
        createdBy: retryAuthor.userId,
        authorities: [retryAuthor.authority],
      }),
    ).resolves.toEqual({
      templateId: original.template_id,
      versionCreated: false,
    });
    expect(await snapshot()).toEqual(baseline);
  });

  it('accepts an identical legacy NULL build key without backfilling it', async () => {
    const body = { ...commit.body, version: `legacy-null-${f.ids.id()}` };
    expect(
      await ownRows(
        env.DB,
        `INSERT INTO template_versions
      (template_id, version, build_key, manifest, pass_json, assets, report, created_by, created_at)
      SELECT template_id, ?, NULL, manifest, pass_json, assets, report, created_by, created_at
      FROM template_versions WHERE template_id = ? AND version = ?`,
        [body.version, original.template_id, original.version],
      ),
    ).toEqual({ changes: 1 });
    const before = await first<StoredVersion>(
      env.DB,
      'SELECT * FROM template_versions WHERE template_id = ? AND version = ?',
      [original.template_id, body.version],
    );
    expect(before?.build_key).toBeNull();
    await expect(commitVersion(ctx, { ...commit, body })).resolves.toEqual({
      templateId: original.template_id,
      versionCreated: false,
    });
    const [retry] = await env.DB.batch(insertVersionStmts(env.DB, newVersion(body)));
    expect(retry?.meta.changes).toBe(0);
    await expect(
      commitVersion(ctx, {
        ...commit,
        body: { ...body, report: changed('report').body.report },
      }),
    ).rejects.toMatchObject({ status: 409, code: 'TEMPLATE_VERSION_CONFLICT' });
    expect(
      await first(env.DB, 'SELECT * FROM template_versions WHERE template_id = ? AND version = ?', [
        original.template_id,
        body.version,
      ]),
    ).toEqual(before);
    expect(
      await ownRows(env.DB, 'DELETE FROM template_versions WHERE template_id = ? AND version = ?', [
        original.template_id,
        body.version,
      ]),
    ).toEqual({ changes: 1 });
    expect(await snapshot()).toEqual(baseline);
  });

  it.each(changedFields)('rejects a same-key retry with a different %s', async (field) => {
    const altered = changed(field);
    await expect(commitVersion(ctx, { ...commit, ...altered })).rejects.toMatchObject({
      status: 409,
      code: 'TEMPLATE_VERSION_CONFLICT',
    });
    expect(await snapshot()).toEqual(baseline);
  });

  it('creates a different draft and leaves the approved release alone on retry and deletion', async () => {
    const body = { ...commit.body, version: `unreferenced-commit-${f.ids.id()}` };
    const draft = { ...commit, body };
    await expect(commitVersion(ctx, draft)).resolves.toEqual({
      templateId: original.template_id,
      versionCreated: true,
    });
    await expect(commitVersion(ctx, draft)).resolves.toEqual({
      templateId: original.template_id,
      versionCreated: false,
    });
    expect(await activeRelease(ctx, original.template_id, orgId, 'live', 'apple')).toEqual({
      ...release,
      createdByName: undefined,
    });
    expect(
      await ownRows(env.DB, 'DELETE FROM template_versions WHERE template_id = ? AND version = ?', [
        original.template_id,
        body.version,
      ]),
    ).toEqual({ changes: 1 });
    await expect(commitVersion(ctx, draft)).rejects.toMatchObject({
      status: 409,
      code: 'TEMPLATE_VERSION_CONFLICT',
    });
    expect(await snapshot()).toEqual(baseline);
  });

  it('does not recreate a deleted template when a new plan uses its retired version', async () => {
    const templateId = f.ids.id();
    const version = `retired-new-plan-${f.ids.id()}`;
    const fresh: CommitArgs = {
      ...commit,
      plan: { templateId, isNew: true, existing: null },
      slug: `retired-${templateId}`,
      body: { ...commit.body, version },
    };
    await expect(commitVersion(ctx, fresh)).resolves.toEqual({
      templateId,
      versionCreated: true,
    });
    expect(
      await first(
        env.DB,
        'SELECT version FROM template_versions WHERE template_id = ? AND version = ?',
        [templateId, version],
      ),
    ).toEqual({ version });
    expect(await ownRows(env.DB, 'DELETE FROM templates WHERE id = ?', [templateId])).toEqual({
      changes: 1,
    });
    expect(
      await first(
        env.DB,
        `SELECT template_id, version FROM template_version_tombstones
      WHERE template_id = ? AND version = ?`,
        [templateId, version],
      ),
    ).toEqual({ template_id: templateId, version });

    await expect(commitVersion(ctx, fresh)).rejects.toMatchObject({
      status: 409,
      code: 'TEMPLATE_VERSION_CONFLICT',
    });
    expect(await first(env.DB, 'SELECT id FROM templates WHERE id = ?', [templateId])).toBeNull();
    expect(
      await all(env.DB, 'SELECT * FROM template_versions WHERE template_id = ?', [templateId]),
    ).toEqual([]);

    // A tombstone fences the composite identity, not every version of this template ID.
    const next = { ...fresh, body: { ...fresh.body, version: `new-plan-next-${f.ids.id()}` } };
    await expect(commitVersion(ctx, next)).resolves.toEqual({
      templateId,
      versionCreated: true,
    });
    expect(await ownRows(env.DB, 'DELETE FROM templates WHERE id = ?', [templateId])).toEqual({
      changes: 1,
    });
    expect(await snapshot()).toEqual(baseline);
  });

  it('rechecks session authority before accepting or comparing a duplicate', async () => {
    const revoked = await templateAuthor(env, clock, orgId);
    await run(env.DB, 'UPDATE sessions SET revoked_at = ? WHERE id_hash = ?', [
      clock.now(),
      revoked.sessionId,
    ]);
    for (const input of [commit, { ...commit, ...changed('report') }]) {
      await expect(
        commitVersion(ctx, {
          ...input,
          createdBy: revoked.userId,
          authorities: [revoked.authority],
        }),
      ).rejects.toMatchObject({ status: 403, code: 'ACTOR_CHANGED' });
    }
    expect(await snapshot()).toEqual(baseline);
  });

  it('allows an identical import retry with its own persisted upload authority', async () => {
    const retry = await importZip(env, clock, {
      orgId,
      name: 'Immutable Version',
      zip: packageZip,
      createdBy: author.userId,
      authority: author.authority,
    });
    expect(retry.result).toEqual({ templateId: original.template_id, version: original.version });
    expect(await snapshot()).toEqual(baseline);
  });
});

describe('version repository batch helper', () => {
  it('inserts a new draft and accepts an identical row without replacing provenance', async () => {
    const existing = newVersion();
    const [retry] = await env.DB.batch(insertVersionStmts(env.DB, existing));
    expect(retry?.meta.changes).toBe(0);
    const draft = { ...existing, version: `unreferenced-helper-${f.ids.id()}` };
    const [created] = await env.DB.batch(insertVersionStmts(env.DB, draft));
    expect(created?.meta.changes).toBe(1);
    const [again] = await env.DB.batch(insertVersionStmts(env.DB, draft));
    expect(again?.meta.changes).toBe(0);
    expect(
      await ownRows(env.DB, 'DELETE FROM template_versions WHERE template_id = ? AND version = ?', [
        original.template_id,
        draft.version,
      ]),
    ).toEqual({ changes: 1 });
    await expect(env.DB.batch(insertVersionStmts(env.DB, draft))).rejects.toThrow();
    expect(await snapshot()).toEqual(baseline);
  });

  it.each(changedFields)(
    'aborts the whole batch for a different %s under an existing key',
    async (field) => {
      const altered = changed(field);
      const pending = { ...newVersion(), version: `rolled-back-${field}` };
      await expect(
        env.DB.batch([
          ...insertVersionStmts(env.DB, pending),
          ...insertVersionStmts(env.DB, newVersion(altered.body, altered.buildKey)),
        ]),
      ).rejects.toThrow();
      expect(
        await first(
          env.DB,
          'SELECT version FROM template_versions WHERE template_id = ? AND version = ?',
          [original.template_id, pending.version],
        ),
      ).toBeNull();
      expect(await snapshot()).toEqual(baseline);
    },
  );
});

describe('baked version synchronization', () => {
  it('detects changed report content with the same source hash and version after the cache is warm', async () => {
    const fixture = await bakedFrom('immutable-cache', basicPackage(), { name: 'Immutable Cache' });
    const assets = fakeAssets(fixture.files);
    const bakedCtx = createServiceContext({ ...env, ASSETS: assets }, { clock });
    // loadTemplate above has already adopted the generated hash for this database.
    const source = sourceOf([fixture], generatedSource.hash);
    await syncBakedTemplates(bakedCtx, source);
    await syncBakedTemplates(bakedCtx, source);
    const id = fixture.template.id;
    const before = {
      template: await first(env.DB, 'SELECT * FROM templates WHERE id = ?', [id]),
      versions: await all(
        env.DB,
        'SELECT * FROM template_versions WHERE template_id = ? ORDER BY version',
        [id],
      ),
      releases: await all(
        env.DB,
        'SELECT * FROM template_releases WHERE template_id = ? ORDER BY mode, generation',
        [id],
      ),
    };
    expect(before.versions).toHaveLength(1);
    expect(before.releases).toHaveLength(2);
    const altered = {
      ...fixture,
      template: {
        ...fixture.template,
        report: {
          ...fixture.template.report,
          issues: [
            ...fixture.template.report.issues,
            { severity: 'warning' as const, code: 'CHANGED', message: 'Different report' },
          ],
        },
      },
    };
    await expect(
      syncBakedTemplates(bakedCtx, sourceOf([altered], source.hash)),
    ).rejects.toMatchObject({
      status: 409,
      code: 'TEMPLATE_VERSION_CONTENT_CONFLICT',
    });
    expect({
      template: await first(env.DB, 'SELECT * FROM templates WHERE id = ?', [id]),
      versions: await all(
        env.DB,
        'SELECT * FROM template_versions WHERE template_id = ? ORDER BY version',
        [id],
      ),
      releases: await all(
        env.DB,
        'SELECT * FROM template_releases WHERE template_id = ? ORDER BY mode, generation',
        [id],
      ),
    }).toEqual(before);
    expect(await snapshot()).toEqual(baseline);
  });
});
