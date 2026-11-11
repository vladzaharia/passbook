import { beforeAll, describe, expect, it } from 'vitest';
import {
  makeTemplate,
  materializeTemplateAssets,
  persistTemplate,
} from '../../../../test/helpers/index.ts';
import type { ResolvedTemplate } from '../../../passkit/template/registry.ts';
import { all, first, run } from '../../platform/db.ts';
import { ConflictError, PreconditionFailedError } from '../../platform/errors.ts';
import { jobCtxOf } from '../delivery/delivery-test-fixtures.ts';
import { makePng } from '../templates/package/fixtures.ts';
import { buildKey } from '../templates/package/hash.ts';
import { requireApprovedRelease, type TemplateRelease } from '../templates/releases.ts';
import { getVersion } from '../templates/repo.ts';
import { approveAppleRelease } from './apple-release-test-fixtures.ts';
import { deletePassAsset, putPassAsset } from './asset-service.ts';
import { startBulkReissue } from './bulk.ts';
import { type ReissueParams, reissuePage } from './bulk-reissue-page.ts';
import { applyConnectionRecord } from './connection-passes.ts';
import { createPassFromConnection } from './connection-passes-create.ts';
import { createPassIdempotent, createPassRow } from './create.ts';
import { ensureCredentialRefKeyset } from './credential-keyset.ts';
import { overrideDeps } from './deps.ts';
import { assetNamesOf } from './detail.ts';
import { expectValidZip, ICON_PNG, type Kit, setupKit, TINY_PNG } from './pass-test-fixtures.ts';
import { publishPass } from './publish.ts';
import { getPass } from './repo-read-pass.ts';
import { updatePass } from './service.ts';

let kit: Kit;
let liveRelease: TemplateRelease;
let credentialKeysetCommitment: string;
beforeAll(async () => {
  kit = await setupKit();
  credentialKeysetCommitment = await ensureCredentialRefKeyset(kit.env.DB, kit.env);
  liveRelease = await requireApprovedRelease(kit.ctx, kit.template.id, kit.org.id, 'live', 'apple');
}, 60_000);

const actor = { type: 'system', id: null } as const;
const count = async (sql: string, params: (string | number)[] = []) =>
  (await first<{ n: number }>(kit.env.DB, sql, params))?.n ?? 0;
/** Pending pushes coalesce, so settle the existing ones first to see new rows. */
const settled = (passId: string) =>
  run(kit.env.DB, "UPDATE outbox SET state = 'sent' WHERE pass_id = ? AND kind = 'push'", [passId]);
const pushes = (passId: string) =>
  count("SELECT count(*) AS n FROM outbox WHERE pass_id = ? AND kind = 'push'", [passId]);
const bytesOf = async (key: string) => {
  const object = await kit.env.BUCKET.get(key);
  if (!object) throw new Error(`missing ${key}`);
  return new Uint8Array(await object.arrayBuffer());
};

/** Persist distinct immutable versions with the same build-key semantics as imported templates. */
async function persistBuiltTemplate(template: ResolvedTemplate) {
  const assets = await materializeTemplateAssets(kit.fx, template, kit.registry);
  const key = await buildKey({ manifest: template.manifest, passJson: template.passJson, assets });
  const now = kit.clock.now();
  await run(
    kit.env.DB,
    `INSERT OR IGNORE INTO templates (id, org_id, slug, name, origin, active_version, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      template.id,
      template.orgId,
      template.id,
      template.manifest.name,
      template.origin,
      template.version,
      now,
      now,
    ],
  );
  await run(
    kit.env.DB,
    `INSERT INTO template_versions (template_id, version, manifest, pass_json, assets, build_key, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [
      template.id,
      template.version,
      JSON.stringify(template.manifest),
      JSON.stringify(template.passJson),
      JSON.stringify(assets),
      key,
      now,
    ],
  );
}

async function connection() {
  const id = kit.fx.ids.id();
  await run(
    kit.env.DB,
    `INSERT INTO connections (id, org_id, connector_type, name, generation, created_at, updated_at)
     VALUES (?, ?, 'demo', 'c', 1, 1, 1)`,
    [id, kit.org.id],
  );
  return id;
}

describe('image overrides', () => {
  it('keeps a shared object while another slot still uses it', async () => {
    const pass = await kit.pass();
    const logo = makePng(40, 40);
    await putPassAsset(jobCtxOf(kit), actor, pass.id, 'logo.png', logo, null);
    await putPassAsset(jobCtxOf(kit), actor, pass.id, 'logo@2x.png', logo, null);
    const keys = await all<{ name: string; r2_key: string }>(
      kit.env.DB,
      'SELECT name, r2_key FROM pass_assets WHERE pass_id = ? ORDER BY name',
      [pass.id],
    );
    expect(new Set(keys.map((k) => k.r2_key)).size).toBe(2);
    // Rows written before keys carried the slot name share one object.
    await run(
      kit.env.DB,
      "UPDATE pass_assets SET r2_key = (SELECT r2_key FROM pass_assets WHERE pass_id = ?1 AND name = 'logo.png') WHERE pass_id = ?1 AND name = 'logo@2x.png'",
      [pass.id],
    );
    await deletePassAsset(jobCtxOf(kit), actor, pass.id, 'logo@2x.png', null);
    const left = await first<{ r2_key: string }>(
      kit.env.DB,
      "SELECT r2_key FROM pass_assets WHERE pass_id = ? AND name = 'logo.png'",
      [pass.id],
    );
    expect(await kit.env.BUCKET.head(left?.r2_key ?? '')).not.toBeNull();
    await expect(
      updatePass(
        jobCtxOf(kit),
        actor,
        pass.id,
        { input: { memberName: 'Rebuilt' } },
        { scope: null },
      ),
    ).resolves.toBeDefined();
  });

  it('replaces every template scale of an overridden slot', async () => {
    const id = `tpl-scales-${kit.fx.ids.token(4)}`;
    const logo = makePng(40, 40);
    const t = kit.registry.add({
      id,
      version: 'v1',
      manifest: kit.template.manifest,
      passJson: kit.template.passJson,
      assets: { 'icon.png': TINY_PNG, 'logo.png': logo, 'logo@2x.png': logo, 'logo@3x.png': logo },
    });
    await persistTemplate(kit.fx, t, { registry: kit.registry });
    const release = await approveAppleRelease(kit, { templateId: id, version: t.version });
    const pass = await createPassRow(jobCtxOf(kit), {
      orgId: kit.org.id,
      templateId: id,
      templateVersion: release.version,
      releaseId: release.id,
      releaseGeneration: release.generation,
      input: { memberName: 'Scales' },
      source: 'manual',
      mode: 'live',
      execution: { kind: 'system' },
      actor,
    });
    await putPassAsset(jobCtxOf(kit), actor, pass.id, 'logo.png', makePng(30, 30), null);
    const published = await getPass(kit.env.DB, pass.id);
    const names = expectValidZip(await bytesOf(published?.objectKey ?? ''));
    expect(names).toContain('logo.png');
    expect(names).not.toContain('logo@2x.png');
    expect(names).not.toContain('logo@3x.png');
    expect(names).toContain('icon.png');
    const served = await assetNamesOf(kit.ctx, published ?? pass);
    expect(served.filter((n) => n.startsWith('logo'))).toEqual(['logo.png']);
  }, 60_000);

  it('rejects truncated and corrupt PNGs', async () => {
    const pass = await kit.pass();
    const corrupt = ICON_PNG.slice();
    corrupt[corrupt.length - 20] = (corrupt[corrupt.length - 20] ?? 0) ^ 0xff;
    for (const bad of [ICON_PNG.slice(0, 50), corrupt]) {
      await expect(
        putPassAsset(jobCtxOf(kit), actor, pass.id, 'icon.png', bad, null),
      ).rejects.toMatchObject({
        code: 'ASSET_NOT_PNG',
      });
    }
  });

  it('stores correct CRCs for overridden images, including rows without a stored CRC', async () => {
    const pass = await kit.pass();
    await putPassAsset(jobCtxOf(kit), actor, pass.id, 'icon.png', ICON_PNG, null);
    const published = await getPass(kit.env.DB, pass.id);
    expect(expectValidZip(await bytesOf(published?.objectKey ?? ''))).toContain('icon.png');
    await run(kit.env.DB, 'UPDATE pass_assets SET crc32 = NULL WHERE pass_id = ?', [pass.id]);
    await updatePass(
      jobCtxOf(kit),
      actor,
      pass.id,
      { input: { memberName: 'Legacy' } },
      { scope: null },
    );
    const next = await getPass(kit.env.DB, pass.id);
    expectValidZip(await bytesOf(next?.objectKey ?? ''));
  });
});

describe('template upgrades and re-sign', () => {
  it.each(['fixture', 'build-key'] as const)(
    'releases the %s version without replacing its first-insert assets',
    async (kind) => {
      const template = kit.registry.add({
        id: `tpl-materialized-${kit.fx.ids.token(6)}`,
        orgId: kit.org.id,
        manifest: kit.template.manifest,
        passJson: kit.template.passJson,
        assets: { 'icon.png': TINY_PNG, 'logo.png': ICON_PNG },
      });
      if (kind === 'fixture') await persistTemplate(kit.fx, template, { registry: kit.registry });
      else await persistBuiltTemplate(template);
      const original = await getVersion(kit.env.DB, template.id, template.version);
      expect(original?.assets.map((asset) => asset.name).sort()).toEqual(['icon.png', 'logo.png']);
      for (const [name, bytes] of [
        ['icon.png', TINY_PNG],
        ['logo.png', ICON_PNG],
      ] as const) {
        const asset = original?.assets.find((entry) => entry.name === name);
        if (asset?.source.kind !== 'r2') throw new Error(`Missing materialized ${name}`);
        expect(await bytesOf(asset.source.key)).toEqual(bytes);
      }
      const release = await approveAppleRelease(kit, {
        templateId: template.id,
        version: template.version,
      });
      expect(release.version).toBe(template.version);
      expect(await getVersion(kit.env.DB, template.id, template.version)).toEqual(original);
      expect(
        await first(
          kit.env.DB,
          'SELECT 1 FROM template_version_tombstones WHERE template_id = ? AND version = ?',
          [template.id, template.version],
        ),
      ).toBeNull();
    },
    60_000,
  );

  /** A fresh template id per test, so other tests keep resolving the kit template. */
  async function upgradable() {
    const id = `tpl-up-${kit.fx.ids.token(4)}`;
    const add = async (version: string, description?: string) => {
      const t = kit.registry.add({
        id,
        version,
        manifest: kit.template.manifest,
        passJson: { ...kit.template.passJson, ...(description ? { description } : {}) },
        assets: { 'icon.png': TINY_PNG },
      });
      await persistBuiltTemplate(t);
      return approveAppleRelease(kit, { templateId: id, version });
    };
    const v1 = await add('v1');
    const pass = await createPassRow(jobCtxOf(kit), {
      orgId: kit.org.id,
      templateId: id,
      templateVersion: v1.version,
      releaseId: v1.id,
      releaseGeneration: v1.generation,
      input: { memberName: 'Up' },
      source: 'manual',
      mode: 'live',
      execution: { kind: 'system' },
      actor,
    });
    return { pass, add };
  }

  it('moves the version without a new object or push when the content is identical', async () => {
    const { pass, add } = await upgradable();
    const release = await add('same-1');
    const beforeVersion = await getVersion(kit.env.DB, pass.templateId, pass.templateVersion);
    const afterVersion = await getVersion(kit.env.DB, pass.templateId, release.version);
    expect(beforeVersion?.buildKey).toMatch(/^[0-9a-f]{64}$/);
    expect(afterVersion?.buildKey).toBe(beforeVersion?.buildKey);
    await settled(pass.id);
    const before = await pushes(pass.id);
    const result = await updatePass(
      jobCtxOf(kit),
      actor,
      pass.id,
      { templateVersion: 'same-1' },
      { scope: null },
    );
    const after = await getPass(kit.env.DB, pass.id);
    expect(result.templateVersion).toBe('same-1');
    expect(after?.releaseId).toBe(release.id);
    expect(after?.objectKey).toBe(pass.objectKey);
    expect(await pushes(pass.id)).toBe(before);
  }, 60_000);

  it('publishes and pushes when the upgrade changes the pass', async () => {
    const { pass, add } = await upgradable();
    const release = await add('changed-1', 'Changed description');
    const beforeVersion = await getVersion(kit.env.DB, pass.templateId, pass.templateVersion);
    const afterVersion = await getVersion(kit.env.DB, pass.templateId, release.version);
    expect(beforeVersion?.buildKey).toMatch(/^[0-9a-f]{64}$/);
    expect(afterVersion?.buildKey).toMatch(/^[0-9a-f]{64}$/);
    expect(afterVersion?.buildKey).not.toBe(beforeVersion?.buildKey);
    await settled(pass.id);
    await updatePass(
      jobCtxOf(kit),
      actor,
      pass.id,
      { templateVersion: 'changed-1' },
      { scope: null },
    );
    const after = await getPass(kit.env.DB, pass.id);
    expect(after?.releaseId).toBe(release.id);
    expect(after?.objectKey).not.toBe(pass.objectKey);
    expect(await pushes(pass.id)).toBe(1);
  }, 60_000);

  it('re-signs into a new object without queuing a push', async () => {
    const pass = await kit.pass();
    await settled(pass.id);
    const before = await pushes(pass.id);
    await publishPass(jobCtxOf(kit), { passId: pass.id, cause: 'resign', actor, force: true });
    const after = await getPass(kit.env.DB, pass.id);
    expect(after?.objectKey).not.toBe(pass.objectKey);
    expect(after?.version).toBe(2);
    expect(await pushes(pass.id)).toBe(before);
  });
});

describe('idempotent create', () => {
  it('keeps the key after the pass row exists, so a retry replays the pass even when the mail enqueue failed', async () => {
    const params = {
      orgId: kit.org.id,
      templateId: kit.template.id,
      templateVersion: liveRelease.version,
      releaseId: liveRelease.id,
      releaseGeneration: liveRelease.generation,
      input: { memberName: 'Idem' },
      holderEmail: 'idem@example.com',
      externalId: 'idem-after-insert',
      sendEmail: true,
      source: 'manual' as const,
      mode: 'live' as const,
      execution: { kind: 'system' as const },
      actor,
    };
    await run(
      kit.env.DB,
      "CREATE TRIGGER fail_email BEFORE INSERT ON outbox WHEN NEW.kind = 'email' BEGIN SELECT RAISE(ABORT, 'boom'); END",
    );
    try {
      // W1-07: once the pass row is committed the create succeeds; a failed mail enqueue is reported, not thrown.
      await expect(
        createPassIdempotent(jobCtxOf(kit), params, 'key-after-insert'),
      ).resolves.toBeDefined();
    } finally {
      await run(kit.env.DB, 'DROP TRIGGER fail_email');
    }
    const replay = await createPassIdempotent(jobCtxOf(kit), params, 'key-after-insert');
    expect(replay.externalId).toBe('idem-after-insert');
    expect(
      await count("SELECT count(*) AS n FROM passes WHERE external_id = 'idem-after-insert'"),
    ).toBe(1);
    // The replay returns the stored result; a mail that failed to enqueue is reported, not re-sent here (W1-07).
  });
});

describe('connection records', () => {
  const input = (connectionId: string, externalRef: string) => ({
    orgId: kit.org.id,
    templateId: kit.template.id,
    expectedRelease: {
      id: liveRelease.id,
      generation: liveRelease.generation,
      version: liveRelease.version,
    },
    mode: 'live' as const,
    generation: 1,
    expectedConnectionMode: 'poll' as const,
    credentialKeysetCommitment,
    connectionId,
    externalRef,
    fields: { memberName: 'Race' },
    holderEmail: 'race@example.com',
    sendEmail: true,
  });

  it('creates one pass and one email for concurrent syncs of the same ref', async () => {
    const connectionId = await connection();
    const results = await Promise.all([
      createPassFromConnection(jobCtxOf(kit), input(connectionId, 'ref-race')),
      createPassFromConnection(jobCtxOf(kit), input(connectionId, 'ref-race')),
    ]);
    expect(results[0].passId).toBe(results[1].passId);
    expect(await getPass(kit.env.DB, results[0].passId)).toMatchObject({
      mode: 'live',
      releaseId: liveRelease.id,
      templateVersion: liveRelease.version,
    });
    expect(
      await count('SELECT count(*) AS n FROM passes WHERE connection_id = ? AND external_ref = ?', [
        connectionId,
        'ref-race',
      ]),
    ).toBe(1);
    expect(
      await count("SELECT count(*) AS n FROM outbox WHERE pass_id = ? AND kind = 'email'", [
        results[0].passId,
      ]),
    ).toBe(1);
  });

  it('refuses a duplicate ref at the database', async () => {
    const connectionId = await connection();
    const first = await createPassFromConnection(jobCtxOf(kit), input(connectionId, 'ref-dup'));
    await expect(
      createPassRow(jobCtxOf(kit), {
        orgId: kit.org.id,
        templateId: kit.template.id,
        templateVersion: liveRelease.version,
        releaseId: liveRelease.id,
        releaseGeneration: liveRelease.generation,
        mode: 'live',
        connectionId,
        externalRef: 'ref-dup',
        holderEmail: 'race@example.com',
        sendEmail: true,
        input: { memberName: 'Dup' },
        source: 'connection',
        connectionGeneration: 1,
        expectedConnectionMode: 'poll',
        credentialKeysetCommitment,
        execution: { kind: 'connection', connectionId, generation: 1 },
        actor: { type: 'connection', id: connectionId },
      }),
    ).rejects.toMatchObject({ code: 'PASS_REF_TAKEN' });
    expect(first.passId).toBeTruthy();
  });

  it('records a holder assignment only when the email changes', async () => {
    const connectionId = await connection();
    const { passId } = await createPassFromConnection(jobCtxOf(kit), {
      ...input(connectionId, 'ref-audit'),
      holderEmail: null,
    });
    const pass = await getPass(kit.env.DB, passId);
    if (!pass) throw new Error('Created pass not found');
    let snapshot = {
      expectedVersion: pass.version,
      ownerUserId: pass.ownerUserId,
      linkGeneration: pass.linkGeneration,
      identityId: pass.identityId,
      credentialGeneration: pass.credentialGeneration,
      lifecycleGeneration: pass.lifecycleGeneration,
      credentialKeysetCommitment,
      transferPending: false as const,
    };
    const base = {
      passId,
      orgId: kit.org.id,
      mode: 'live' as const,
      status: 'active' as const,
      connectionId,
      externalRef: 'ref-audit',
      generation: 1,
      expectedConnectionMode: 'poll' as const,
      fields: {},
      cause: 'connection' as const,
    };
    for (let i = 0; i < 3; i++) {
      const result = await applyConnectionRecord(jobCtxOf(kit), {
        ...base,
        ...snapshot,
        holderEmail: 'Same@Example.com',
      });
      snapshot = {
        expectedVersion: result.version,
        ownerUserId: result.ownerUserId,
        linkGeneration: result.linkGeneration,
        identityId: result.identityId,
        credentialGeneration: result.credentialGeneration,
        lifecycleGeneration: result.lifecycleGeneration,
        credentialKeysetCommitment: result.credentialKeysetCommitment,
        transferPending: result.transferPending,
      };
    }
    expect(
      await count(
        "SELECT count(*) AS n FROM audit_log WHERE action = 'holder.assign' AND target_id = ?",
        [passId],
      ),
    ).toBe(1);
    await applyConnectionRecord(jobCtxOf(kit), {
      ...base,
      ...snapshot,
      holderEmail: 'next@example.com',
    });
    expect(
      await count(
        "SELECT count(*) AS n FROM audit_log WHERE action = 'holder.assign' AND target_id = ?",
        [passId],
      ),
    ).toBe(2);
  });
});

describe('registry failures', () => {
  const failing = () =>
    overrideDeps(kit.env, {
      registry: {
        list: (q) => kit.registry.list(q),
        openAsset: (t, n) => kit.registry.openAsset(t, n),
        resolve: async () => {
          throw new Error('D1_ERROR: Network connection lost.');
        },
      },
    });
  const restore = () => overrideDeps(kit.env, { registry: kit.registry });

  it('retries a reissue page instead of dropping it as TEMPLATE_NOT_FOUND', async () => {
    const templateId = `tpl-reissue-failure-${kit.fx.ids.token(4)}`;
    const add = async (version: string, description: string) => {
      const template = kit.registry.add({
        id: templateId,
        version,
        manifest: kit.template.manifest,
        passJson: { ...kit.template.passJson, description },
        assets: { 'icon.png': TINY_PNG },
      });
      await persistBuiltTemplate(template);
      return approveAppleRelease(kit, { templateId, version });
    };
    const initial = await add('v1', 'Before reissue');
    const pass = await createPassRow(jobCtxOf(kit), {
      orgId: kit.org.id,
      templateId,
      templateVersion: initial.version,
      releaseId: initial.id,
      releaseGeneration: initial.generation,
      input: { memberName: 'Registry failure' },
      source: 'manual',
      mode: 'live',
      execution: { kind: 'system' },
      actor,
    });
    const target = await add('v2', 'After reissue');
    const originalVersion = await getVersion(kit.env.DB, templateId, initial.version);
    const targetVersion = await getVersion(kit.env.DB, templateId, target.version);
    expect(originalVersion?.buildKey).toMatch(/^[0-9a-f]{64}$/);
    expect(targetVersion?.buildKey).toMatch(/^[0-9a-f]{64}$/);
    expect(targetVersion?.buildKey).not.toBe(originalVersion?.buildKey);
    const instanceId = await startBulkReissue(
      kit.ctx,
      actor,
      {
        templateId,
        version: target.version,
        orgId: kit.org.id,
        identityId: pass.identityId,
        cause: 'template_upgrade',
      },
      { mode: 'live' },
    );
    const params = kit.workflow.created.find((entry) => entry.id === instanceId)?.params as
      | ReissueParams
      | undefined;
    if (!params) throw new Error('Reissue workflow was not created');
    expect(params).toMatchObject({
      workflowInstanceId: instanceId,
      releaseId: target.id,
      releaseGeneration: target.generation,
    });
    failing();
    try {
      await expect(reissuePage(jobCtxOf(kit), params, null)).rejects.toThrow('D1_ERROR');
    } finally {
      restore();
    }
  }, 60_000);

  it('still reports a missing template as 404', async () => {
    const { resolved } = makeTemplate({ id: `missing-${kit.fx.ids.token(4)}` });
    await expect(
      createPassRow(jobCtxOf(kit), {
        orgId: kit.org.id,
        templateId: resolved.id,
        templateVersion: resolved.version,
        input: {},
        source: 'manual',
        mode: 'live',
        execution: { kind: 'system' },
        actor,
      }),
    ).rejects.toMatchObject({ status: 404, code: 'TEMPLATE_NOT_FOUND' });
  });
});

describe('parallel edits', () => {
  function loseRaces(passId: string, times: number) {
    let left = times;
    overrideDeps(kit.env, {
      registry: {
        list: (q) => kit.registry.list(q),
        openAsset: (t, n) => kit.registry.openAsset(t, n),
        async resolve(id, version) {
          if (left > 0) {
            left--;
            await run(kit.env.DB, 'UPDATE passes SET version = version + 1 WHERE id = ?', [passId]);
          }
          return kit.registry.resolve(id, version);
        },
      },
    });
  }
  const restore = () => overrideDeps(kit.env, { registry: kit.registry });

  it('keeps versions contiguous and objects referenced', async () => {
    const pass = await kit.pass();
    const results = await Promise.allSettled(
      [1, 2, 3, 4, 5].map((i) =>
        updatePass(
          jobCtxOf(kit),
          actor,
          pass.id,
          { input: { memberName: `P${i}` } },
          { scope: null },
        ),
      ),
    );
    for (const r of results)
      if (r.status === 'rejected') expect(r.reason).toBeInstanceOf(ConflictError);
    expect(results.some((r) => r.status === 'fulfilled')).toBe(true);
    const versions = await all<{ version: number; object_key: string }>(
      kit.env.DB,
      'SELECT version, object_key FROM pass_versions WHERE pass_id = ? ORDER BY version',
      [pass.id],
    );
    expect(versions.map((v) => v.version)).toEqual(versions.map((_, i) => i + 1));
    const stored = (await kit.env.BUCKET.list({ prefix: `passes/${pass.id}/` })).objects;
    const referenced = new Set(versions.map((v) => v.object_key));
    for (const object of stored) expect(referenced.has(object.key)).toBe(true);
    const current = await getPass(kit.env.DB, pass.id);
    expect(await kit.env.BUCKET.head(current?.objectKey ?? '')).not.toBeNull();
  });

  it('answers 412 and deletes the new object when If-Match is current but the CAS is lost', async () => {
    const pass = await kit.pass();
    const before = (await kit.env.BUCKET.list({ prefix: `passes/${pass.id}/` })).objects.length;
    loseRaces(pass.id, 1);
    try {
      await expect(
        updatePass(
          jobCtxOf(kit),
          actor,
          pass.id,
          { input: { memberName: 'Late' } },
          { scope: null, ifMatch: 1 },
        ),
      ).rejects.toBeInstanceOf(PreconditionFailedError);
    } finally {
      restore();
    }
    expect((await kit.env.BUCKET.list({ prefix: `passes/${pass.id}/` })).objects).toHaveLength(
      before,
    );
  });

  it('retries a metadata-only write that lost the race', async () => {
    const pass = await kit.pass();
    loseRaces(pass.id, 1);
    try {
      await updatePass(jobCtxOf(kit), actor, pass.id, { externalId: 'meta-race' }, { scope: null });
    } finally {
      restore();
    }
    expect((await getPass(kit.env.DB, pass.id))?.externalId).toBe('meta-race');
  });
});
