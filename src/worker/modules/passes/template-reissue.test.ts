import { beforeAll, describe, expect, it } from 'vitest';
import {
  makeOrg,
  materializeTemplateAssets,
  persistTemplate,
} from '../../../../test/helpers/index.ts';
import type { PassJson, TemplateManifest } from '../../../passkit/types.ts';
import type { Mode } from '../../../shared/contracts/common.ts';
import { first } from '../../platform/db.ts';
import { runBulkReissue } from '../../workflows/bulk-reissue.ts';
import { jobCtxOf } from '../delivery/delivery-test-fixtures.ts';
import { basicPackage, passJson } from '../templates/package/fixtures.ts';
import { requireApprovedRelease, type TemplateRelease } from '../templates/releases.ts';
import { countStalePasses, olderLivePasses } from '../templates/repo-stale.ts';
import { generatedSource, resetBakedSync, syncBakedTemplates } from '../templates/sync.ts';
import { bakedFrom, fakeAssets, sourceOf } from '../templates/testing.ts';
import { approveAppleRelease } from './apple-release-test-fixtures.ts';
import { createPassRow } from './create.ts';
import { type Kit, setupKit, TINY_PNG } from './pass-test-fixtures.ts';
import { publishPass } from './publish.ts';
import { getPass } from './repo-read-pass.ts';
import { reissueStalePasses, STALE_QUIET_MS } from './stale-reissue.ts';

let kit: Kit;
beforeAll(async () => {
  kit = await setupKit();
}, 60_000);

const admin = { type: 'user', id: 'admin-1' } as const;
type Fn = () => Promise<unknown>;
const call = (a: unknown, b: unknown) => ((typeof a === 'function' ? a : b) as Fn)();
const step = {
  do: async (_name: string, a: unknown, b?: unknown) => call(a, b),
} as unknown as Parameters<typeof runBulkReissue>[3];

const SLOT = [{ key: 'pass-service', label: 'Pass service', value: '' }];
let seq = 0;

/** Registers a version with the registry the builder reads and with D1 the cron reads. */
async function addVersion(
  id: string,
  version: string,
  options: { orgId?: string | null; backFields?: object[]; manifest?: TemplateManifest } = {},
) {
  const base = kit.template;
  const pass = structuredClone(base.passJson) as PassJson;
  pass.generic = { ...pass.generic, backFields: options.backFields ?? [] } as PassJson['generic'];
  const resolved = kit.registry.add({
    id,
    version,
    orgId: options.orgId === undefined ? kit.org.id : options.orgId,
    manifest: options.manifest ?? base.manifest,
    passJson: pass,
    assets: { 'icon.png': TINY_PNG },
  });
  await persistTemplate(kit.fx, resolved, { registry: kit.registry });
  return resolved;
}

/** Change the draft pointer without approving a release. */
async function activate(id: string, version: string) {
  await kit.env.DB.prepare('UPDATE templates SET active_version = ?, updated_at = ? WHERE id = ?')
    .bind(version, kit.clock.now(), id)
    .run();
}

/** Create an immutable keyed version while preserving the legacy v1 fixture. */
async function addKeyedVersion(id: string, version: string, key: string) {
  const base = await kit.registry.resolve(id, 'v1');
  const resolved = kit.registry.add({
    id,
    version,
    orgId: base.orgId,
    origin: base.origin,
    manifest: base.manifest,
    passJson: base.passJson,
    assets: { 'icon.png': TINY_PNG },
  });
  const assets = await materializeTemplateAssets(kit.fx, resolved, kit.registry);
  await kit.env.DB.prepare(
    `INSERT INTO template_versions
       (template_id, version, build_key, manifest, pass_json, assets, report, created_by, created_at)
     SELECT template_id, ?, ?, manifest, pass_json, ?, report, created_by, created_at
     FROM template_versions WHERE template_id = ? AND version = 'v1'`,
  )
    .bind(version, key, JSON.stringify(assets), id)
    .run();
}

const approve = (templateId: string, version: string, orgId = kit.org.id, mode: Mode = 'live') =>
  approveAppleRelease(kit, { templateId, version, orgId, mode });

const newTemplate = async (backFields: object[] = [], orgId: string | null = kit.org.id) => {
  const id = `tpl-reissue-${seq++}`;
  await addVersion(id, 'v1', { backFields, orgId });
  await approve(id, 'v1', orgId ?? kit.org.id);
  return id;
};

const passOn = async (templateId: string, orgId = kit.org.id, mode: Mode = 'live') => {
  const release = await requireApprovedRelease(kit.ctx, templateId, orgId, mode, 'apple');
  return createPassRow(jobCtxOf(kit), {
    orgId,
    templateId,
    templateVersion: release.version,
    releaseId: release.id,
    releaseGeneration: release.generation,
    input: { memberName: 'Alex Morgan' },
    holderEmail: null,
    source: 'manual',
    mode,
    execution: { kind: 'system' },
    actor: { type: 'system', id: null },
  });
};

const cron = async (advance = STALE_QUIET_MS + 1) => {
  kit.clock.set(kit.clock.now() + advance);
  await reissueStalePasses(kit.ctx);
};
const started = (templateId: string) =>
  kit.workflow.created.filter((job) => {
    const params = job.params;
    return (
      params !== null &&
      typeof params === 'object' &&
      'templateId' in params &&
      params.templateId === templateId
    );
  });
const inScope = (job: { params: unknown }, orgId: string, mode: Mode) => {
  const params = job.params;
  return (
    params !== null &&
    typeof params === 'object' &&
    'orgId' in params &&
    params.orgId === orgId &&
    'mode' in params &&
    params.mode === mode
  );
};
const run = async (w: { id: string; params: unknown } | undefined) =>
  runBulkReissue(kit.env, w?.id ?? '', w?.params as Parameters<typeof runBulkReissue>[2], step);
const queuedRelease = async (id: string, orgId = kit.org.id, mode: Mode = 'live') =>
  (
    await first<{ id: string }>(
      kit.env.DB,
      `SELECT release_id AS id FROM template_release_reissues
       WHERE template_id = ? AND org_id = ? AND mode = ? AND provider = 'apple'`,
      [id, orgId, mode],
    )
  )?.id;
const expectSnapshot = async (
  workflow: { id: string } | undefined,
  release: TemplateRelease,
  orgId = kit.org.id,
) => {
  expect(
    await first(
      kit.env.DB,
      `SELECT org_id, mode, template_id, release_id, generation, version
       FROM workflow_release_snapshots WHERE instance_id = ? AND org_id = ? AND mode = ? AND template_id = ?`,
      [workflow?.id, orgId, release.mode, release.templateId],
    ),
  ).toEqual({
    org_id: orgId,
    mode: release.mode,
    template_id: release.templateId,
    release_id: release.id,
    generation: release.generation,
    version: release.version,
  });
};
const lastPassJson = async (passId: string) =>
  JSON.parse(
    (
      await first<{ pass_json: string }>(
        kit.env.DB,
        'SELECT pass_json FROM pass_versions WHERE pass_id = ? ORDER BY version DESC LIMIT 1',
        [passId],
      )
    )?.pass_json ?? '{}',
  );

describe('template reissue', () => {
  it('claims an equivalent approved release without moving, notifying, or rebuilding passes', async () => {
    const id = await newTemplate();
    const key = 'a'.repeat(64);
    await addKeyedVersion(id, 'v2', key);
    const v2 = await approve(id, 'v2');
    await activate(id, 'v1');
    const issued = await passOn(id);
    expect(
      await first(kit.env.DB, 'SELECT active_version FROM templates WHERE id = ?', [id]),
    ).toEqual({ active_version: 'v1' });
    expect(issued).toMatchObject({ templateVersion: v2.version, releaseId: v2.id });
    await kit.settle();
    await cron();
    expect(await queuedRelease(id)).toBe(v2.id);
    const passBefore = await first(
      kit.env.DB,
      'SELECT template_version, release_id, version, object_key FROM passes WHERE id = ?',
      [issued.id],
    );
    const versionsBefore = await first(
      kit.env.DB,
      'SELECT COUNT(*) AS n FROM pass_versions WHERE pass_id = ?',
      [issued.id],
    );
    const outboxBefore = await first(
      kit.env.DB,
      'SELECT COUNT(*) AS n FROM outbox WHERE pass_id = ?',
      [issued.id],
    );
    const objectsBefore = (
      await kit.env.BUCKET.list({ prefix: `passes/${issued.id}/` })
    ).objects.map((object) => object.key);
    const queuedBefore = kit.queue.sent.length;
    await addKeyedVersion(id, 'v3', key);
    const v3 = await approve(id, 'v3');
    expect(await countStalePasses(kit.env.DB, id, 'v3', kit.org.id, 'live')).toBe(0);
    expect((await olderLivePasses(kit.env.DB, id, 'live', kit.org.id)).older).toBe(0);
    await cron();
    await kit.settle();
    expect(await queuedRelease(id)).toBe(v3.id);
    expect(started(id)).toHaveLength(0);
    expect(
      await first(
        kit.env.DB,
        'SELECT template_version, release_id, version, object_key FROM passes WHERE id = ?',
        [issued.id],
      ),
    ).toEqual(passBefore);
    expect(
      await first(kit.env.DB, 'SELECT COUNT(*) AS n FROM pass_versions WHERE pass_id = ?', [
        issued.id,
      ]),
    ).toEqual(versionsBefore);
    expect(
      await first(kit.env.DB, 'SELECT COUNT(*) AS n FROM outbox WHERE pass_id = ?', [issued.id]),
    ).toEqual(outboxBefore);
    expect(
      (await kit.env.BUCKET.list({ prefix: `passes/${issued.id}/` })).objects.map(
        (object) => object.key,
      ),
    ).toEqual(objectsBefore);
    expect(kit.queue.sent).toHaveLength(queuedBefore);
    const republished = await approve(id, 'v3');
    expect(republished.id).not.toBe(v3.id);
    expect(republished.generation).toBe(v3.generation + 1);
    await cron();
    expect(await queuedRelease(id)).toBe(republished.id);
    expect(started(id)).toHaveLength(0);
    expect(
      await first(
        kit.env.DB,
        'SELECT template_version, release_id, version, object_key FROM passes WHERE id = ?',
        [issued.id],
      ),
    ).toEqual(passBefore);
  }, 60_000);

  it('keeps NULL build keys stale for either the pinned or target version', async () => {
    const id = await newTemplate();
    const issued = await passOn(id);
    await kit.settle();
    await cron();
    await addKeyedVersion(id, 'v2', 'b'.repeat(64));
    const target = await approve(id, 'v2');
    expect(await countStalePasses(kit.env.DB, id, 'v2', kit.org.id, 'live')).toBe(1);
    await cron();
    expect(started(id)).toHaveLength(1);
    await expectSnapshot(started(id)[0], target);

    const other = await newTemplate();
    await addKeyedVersion(other, 'v2', 'b'.repeat(64));
    await approve(other, 'v2');
    await passOn(other);
    await kit.settle();
    await cron();
    const rollback = await approve(other, 'v1');
    expect(await countStalePasses(kit.env.DB, other, 'v1', kit.org.id, 'live')).toBe(1);
    await cron();
    expect(started(other)).toHaveLength(1);
    await expectSnapshot(started(other)[0], rollback);
    expect((await getPass(kit.env.DB, issued.id))?.templateVersion).toBe('v1');
  }, 60_000);

  it('counts stale passes only in the requested mode', async () => {
    const id = await newTemplate();
    await approve(id, 'v1', kit.org.id, 'test');
    await passOn(id, kit.org.id, 'test');
    await addKeyedVersion(id, 'v2', 'c'.repeat(64));
    await approve(id, 'v2', kit.org.id, 'test');
    expect((await olderLivePasses(kit.env.DB, id, 'live', kit.org.id)).older).toBe(0);
    expect((await olderLivePasses(kit.env.DB, id, 'test', kit.org.id)).older).toBe(1);
  }, 60_000);

  it('queues and rebuilds only the approved tenant and mode', async () => {
    const id = await newTemplate([], null);
    const other = await makeOrg(kit.fx, { name: 'Other reissue tenant' });
    const testV1 = await approve(id, 'v1', kit.org.id, 'test');
    const otherV1 = await approve(id, 'v1', other.id);
    const livePass = await passOn(id);
    const testPass = await passOn(id, kit.org.id, 'test');
    const otherPass = await passOn(id, other.id);
    await cron();

    await addVersion(id, 'v2', { orgId: null, backFields: SLOT });
    const liveV2 = await approve(id, 'v2');
    await cron();
    expect(started(id)).toHaveLength(1);
    const liveJob = started(id)[0];
    expect(liveJob?.params).toMatchObject({
      orgId: kit.org.id,
      mode: 'live',
      version: 'v2',
      releaseId: liveV2.id,
      releaseGeneration: liveV2.generation,
    });
    await expectSnapshot(liveJob, liveV2);
    expect(await queuedRelease(id, kit.org.id, 'test')).toBe(testV1.id);
    expect(await queuedRelease(id, other.id)).toBe(otherV1.id);
    expect(await run(liveJob)).toEqual({ changed: 1, unchanged: 0, failed: 0 });
    expect((await getPass(kit.env.DB, livePass.id))?.templateVersion).toBe('v2');
    expect((await getPass(kit.env.DB, testPass.id))?.templateVersion).toBe('v1');
    expect((await getPass(kit.env.DB, otherPass.id))?.templateVersion).toBe('v1');

    const testV2 = await approve(id, 'v2', kit.org.id, 'test');
    const otherV2 = await approve(id, 'v2', other.id);
    await cron();
    const jobs = started(id);
    expect(jobs).toHaveLength(3);
    const testJob = jobs.find((job) => inScope(job, kit.org.id, 'test'));
    const otherJob = jobs.find((job) => inScope(job, other.id, 'live'));
    expect(testJob?.params).toMatchObject({
      releaseId: testV2.id,
      releaseGeneration: testV2.generation,
    });
    expect(otherJob?.params).toMatchObject({
      releaseId: otherV2.id,
      releaseGeneration: otherV2.generation,
    });
    await expectSnapshot(testJob, testV2);
    await expectSnapshot(otherJob, otherV2, other.id);
    expect(await run(testJob)).toEqual({ changed: 1, unchanged: 0, failed: 0 });
    expect(await run(otherJob)).toEqual({ changed: 1, unchanged: 0, failed: 0 });
    expect((await getPass(kit.env.DB, testPass.id))?.releaseId).toBe(testV2.id);
    expect((await getPass(kit.env.DB, otherPass.id))?.releaseId).toBe(otherV2.id);
  }, 60_000);

  it('restores the previous release claim and retries when a workflow cannot start', async () => {
    const id = await newTemplate();
    const initial = await requireApprovedRelease(kit.ctx, id, kit.org.id, 'live', 'apple');
    await passOn(id);
    await cron();
    expect(await queuedRelease(id)).toBe(initial.id);
    await addVersion(id, 'v2');
    const target = await approve(id, 'v2');
    const create = kit.workflow.create;
    try {
      kit.workflow.create = async () => {
        throw new Error('down');
      };
      await cron();
    } finally {
      kit.workflow.create = create;
    }
    expect(await queuedRelease(id)).toBe(initial.id);
    expect(started(id)).toHaveLength(0);
    await cron();
    expect(await queuedRelease(id)).toBe(target.id);
    expect(started(id)).toHaveLength(1);
    await expectSnapshot(started(id)[0], target);
  }, 60_000);

  it('rebuilds live passes on the new version with its back fields; voided passes stay', async () => {
    const id = await newTemplate();
    const initial = await requireApprovedRelease(kit.ctx, id, kit.org.id, 'live', 'apple');
    const live = await passOn(id);
    const voided = await passOn(id);
    await publishPass(jobCtxOf(kit), {
      passId: voided.id,
      cause: 'admin',
      actor: admin,
      mutate: () => ({ status: 'voided' }),
    });
    await kit.settle();
    await cron();
    expect(started(id)).toHaveLength(0);
    expect(await queuedRelease(id)).toBe(initial.id);

    await addVersion(id, 'v2', { backFields: SLOT });
    await activate(id, 'v2');
    await cron();
    expect(started(id)).toHaveLength(0);
    expect(await queuedRelease(id)).toBe(initial.id);
    expect((await getPass(kit.env.DB, live.id))?.templateVersion).toBe('v1');
    const target = await approve(id, 'v2');
    await cron(STALE_QUIET_MS / 2);
    expect(started(id)).toHaveLength(0);
    await cron();
    await cron();
    const [workflow] = started(id);
    expect(started(id)).toHaveLength(1);
    expect(workflow?.params).toMatchObject({
      templateId: id,
      version: 'v2',
      orgId: kit.org.id,
      mode: 'live',
      releaseId: target.id,
      releaseGeneration: target.generation,
      cause: 'template_upgrade',
    });
    await expectSnapshot(workflow, target);

    kit.queue.sent.length = 0;
    expect(await run(workflow)).toEqual({ changed: 1, unchanged: 0, failed: 0 });
    await kit.settle();
    expect(await getPass(kit.env.DB, live.id)).toMatchObject({
      templateVersion: 'v2',
      releaseId: target.id,
    });
    expect((await getPass(kit.env.DB, voided.id))?.templateVersion).toBe('v1');
    const back = (await lastPassJson(live.id)).generic.backFields as {
      key: string;
      value: string;
    }[];
    expect(back.find((f) => f.key === 'pass-service')?.value).toContain('support@passbook.mobile');
    expect((await olderLivePasses(kit.env.DB, id, 'live', kit.org.id)).older).toBe(0);
  }, 60_000);

  it('turns a burst of approved releases into one reissue to the latest', async () => {
    const id = await newTemplate();
    await passOn(id);
    await cron();
    let latest: TemplateRelease | undefined;
    for (const v of ['v2', 'v3', 'v4']) {
      await addVersion(id, v);
      latest = await approve(id, v);
      kit.clock.set(kit.clock.now() + 20_000);
    }
    await cron(0);
    expect(started(id)).toHaveLength(0);
    await cron();
    await cron();
    expect(started(id)).toHaveLength(1);
    expect(latest).toBeDefined();
    expect(started(id)[0]?.params).toMatchObject({
      orgId: kit.org.id,
      mode: 'live',
      version: 'v4',
      releaseId: latest?.id,
      releaseGeneration: latest?.generation,
    });
    if (!latest) throw new Error('Expected the latest release');
    await expectSnapshot(started(id)[0], latest);
  }, 60_000);

  it('rejects a queued snapshot superseded by a new generation of the same version', async () => {
    const id = await newTemplate();
    const pass = await passOn(id);
    await addVersion(id, 'v2', { backFields: SLOT });
    const firstRelease = await approve(id, 'v2');
    await cron();
    const firstJob = started(id)[0];
    await expectSnapshot(firstJob, firstRelease);
    const newerRelease = await approve(id, 'v2');
    expect(newerRelease.generation).toBe(firstRelease.generation + 1);
    expect(newerRelease.id).not.toBe(firstRelease.id);

    expect(await run(firstJob)).toEqual({ changed: 0, unchanged: 0, failed: 1 });
    expect(await getPass(kit.env.DB, pass.id)).toMatchObject({
      templateVersion: 'v1',
      releaseId: pass.releaseId,
      version: pass.version,
    });
    await cron();
    expect(started(id)).toHaveLength(2);
    const secondJob = started(id)[1];
    expect(secondJob?.params).toMatchObject({
      version: 'v2',
      releaseId: newerRelease.id,
      releaseGeneration: newerRelease.generation,
    });
    await expectSnapshot(secondJob, newerRelease);
    expect(await run(secondJob)).toEqual({ changed: 1, unchanged: 0, failed: 0 });
    expect((await getPass(kit.env.DB, pass.id))?.releaseId).toBe(newerRelease.id);
  }, 60_000);

  it('starts nothing when current and queues a fresh generation after rollback', async () => {
    const id = await newTemplate();
    const pass = await passOn(id);
    await addVersion(id, 'v2', { backFields: SLOT });
    const v2 = await approve(id, 'v2');
    await cron();
    await expectSnapshot(started(id)[0], v2);
    expect(await run(started(id)[0])).toMatchObject({ changed: 1, failed: 0 });
    await cron();
    expect(started(id)).toHaveLength(1);

    const rollback = await approve(id, 'v1');
    expect(rollback.generation).toBe(v2.generation + 1);
    expect(rollback.id).not.toBe(v2.id);
    await cron();
    expect(started(id)).toHaveLength(2);
    expect(started(id)[1]?.params).toMatchObject({
      orgId: kit.org.id,
      mode: 'live',
      version: 'v1',
      releaseId: rollback.id,
      releaseGeneration: rollback.generation,
    });
    await expectSnapshot(started(id)[1], rollback);
    expect(await run(started(id)[1])).toMatchObject({ changed: 1, failed: 0 });
    expect(await getPass(kit.env.DB, pass.id)).toMatchObject({
      templateVersion: 'v1',
      releaseId: rollback.id,
    });
  }, 60_000);

  it('keeps a pass on its version when the new one no longer fits, and says so', async () => {
    const id = await newTemplate();
    const pass = await passOn(id);
    const inputs = kit.template.manifest.inputs as {
      required: string[];
      properties: Record<string, unknown>;
    };
    await addVersion(id, 'v2', {
      manifest: {
        ...kit.template.manifest,
        inputs: {
          ...inputs,
          type: 'object',
          required: [...inputs.required, 'tier'],
          properties: { ...inputs.properties, tier: { type: 'string', minLength: 1 } },
        },
        sample: { ...kit.template.manifest.sample, tier: 'gold' },
      } as TemplateManifest,
    });
    const target = await approve(id, 'v2');
    await cron();
    await expectSnapshot(started(id)[0], target);
    expect(await run(started(id)[0])).toMatchObject({ changed: 0, failed: 1 });
    expect((await getPass(kit.env.DB, pass.id))?.templateVersion).toBe('v1');
    expect(await olderLivePasses(kit.env.DB, id, 'live', kit.org.id)).toEqual({
      older: 1,
      settled: true,
    });
    await cron();
    expect(started(id)).toHaveLength(1);
  }, 60_000);

  it('follows a baked template that changed in a deploy', async () => {
    const previousSource = { ...generatedSource };
    const previousAssets = kit.env.ASSETS;
    const previousVersion = kit.env.CF_VERSION;
    const pack = (back: object[]) =>
      basicPackage(
        { 'wallet.template.json': JSON.stringify(kit.template.manifest) },
        passJson({
          generic: {
            primaryFields: [{ key: 'name', label: 'Name', value: 'Alex Morgan' }],
            backFields: back,
          },
        }),
      );
    const v1 = await bakedFrom('deploy-card', pack([]));
    const v2 = await bakedFrom('deploy-card', pack(SLOT));
    expect(v2.template.version).not.toBe(v1.template.version);
    const id = v1.template.id;

    const assets = fakeAssets(new Map([...v1.files, ...v2.files]));
    const register = (fixture: typeof v1) => {
      const t = fixture.template;
      const entries = t.assets.map((asset) => {
        const bytes = fixture.files.get(asset.source.path);
        if (!bytes) throw new Error(`Missing baked asset ${asset.name}`);
        return [asset.name, bytes] as const;
      });
      kit.registry.add({
        id,
        version: t.version,
        orgId: null,
        origin: 'baked',
        manifest: t.manifest,
        passJson: t.passJson as PassJson,
        assets: Object.fromEntries(entries),
      });
    };

    try {
      kit.clock.set(kit.clock.now() + 1_000);
      Object.assign(kit.env, {
        ASSETS: assets,
        CF_VERSION: { id: 'build-v1', tag: '', timestamp: new Date(kit.clock.now()).toISOString() },
      });
      Object.assign(generatedSource, sourceOf([v1], 'build-1'));
      resetBakedSync();
      await syncBakedTemplates(kit.ctx);
      register(v1);
      const initial = await requireApprovedRelease(kit.ctx, id, kit.org.id, 'live', 'apple');
      const initialTest = await requireApprovedRelease(kit.ctx, id, kit.org.id, 'test', 'apple');
      const other = await makeOrg(kit.fx, { name: 'Baked reissue tenant' });
      expect(initial.version).toBe(v1.template.version);
      const pass = await passOn(id);
      const testPass = await passOn(id, kit.org.id, 'test');
      const otherPass = await passOn(id, other.id);
      await cron();
      expect(started(id)).toHaveLength(0);
      expect(await queuedRelease(id)).toBe(initial.id);
      expect(await queuedRelease(id, kit.org.id, 'test')).toBe(initialTest.id);
      expect(await queuedRelease(id, other.id)).toBe(initial.id);

      register(v2);
      kit.clock.set(kit.clock.now() + 1_000);
      Object.assign(kit.env, {
        CF_VERSION: { id: 'build-v2', tag: '', timestamp: new Date(kit.clock.now()).toISOString() },
      });
      Object.assign(generatedSource, sourceOf([v2], 'build-2'));
      resetBakedSync();
      await syncBakedTemplates(kit.ctx);
      const target = await requireApprovedRelease(kit.ctx, id, kit.org.id, 'live', 'apple');
      const testTarget = await requireApprovedRelease(kit.ctx, id, kit.org.id, 'test', 'apple');
      expect(target.version).toBe(v2.template.version);
      expect(target.generation).toBe(initial.generation + 1);
      await cron();
      const jobs = started(id);
      expect(jobs).toHaveLength(3);
      const workflow = jobs.find((job) => inScope(job, kit.org.id, 'live'));
      const testWorkflow = jobs.find((job) => inScope(job, kit.org.id, 'test'));
      const otherWorkflow = jobs.find((job) => inScope(job, other.id, 'live'));
      expect(workflow?.params).toMatchObject({
        orgId: kit.org.id,
        mode: 'live',
        version: target.version,
        releaseId: target.id,
        releaseGeneration: target.generation,
      });
      await expectSnapshot(workflow, target);
      await expectSnapshot(testWorkflow, testTarget);
      await expectSnapshot(otherWorkflow, target, other.id);
      expect(await run(workflow)).toMatchObject({ changed: 1, failed: 0 });
      expect(await run(testWorkflow)).toMatchObject({ changed: 1, failed: 0 });
      expect(await run(otherWorkflow)).toMatchObject({ changed: 1, failed: 0 });
      expect(await getPass(kit.env.DB, pass.id)).toMatchObject({
        templateVersion: v2.template.version,
        releaseId: target.id,
      });
      expect((await getPass(kit.env.DB, testPass.id))?.releaseId).toBe(testTarget.id);
      expect((await getPass(kit.env.DB, otherPass.id))?.releaseId).toBe(target.id);
      const back = (await lastPassJson(pass.id)).generic.backFields as {
        key: string;
        value: string;
      }[];
      expect(back.find((f) => f.key === 'pass-service')?.value).toBe(
        `PassBook · support@passbook.mobile\n${kit.env.PUBLIC_BASE_URL}`,
      );
    } finally {
      Object.assign(kit.env, { ASSETS: previousAssets, CF_VERSION: previousVersion });
      Object.assign(generatedSource, previousSource);
      resetBakedSync();
    }
  }, 60_000);
});
