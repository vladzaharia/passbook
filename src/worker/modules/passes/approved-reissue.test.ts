import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { makeOrg, makePass } from '../../../../test/helpers/index.ts';
import { crc32 } from '../../../passkit/index.ts';
import type { PassJson, TemplateManifest } from '../../../passkit/types.ts';
import type { Mode } from '../../../shared/contracts/common.ts';
import { JobSchema } from '../../jobs/types.ts';
import { first, run } from '../../platform/db.ts';
import { createServiceContext } from '../../platform/service-context.ts';
import { runBulkReissue } from '../../workflows/bulk-reissue.ts';
import { interveneAtD1 } from '../apple/credential-transfer-test-fixtures.ts';
import { handlePassRefresh } from '../connections/jobs.ts';
import { jobCtxOf } from '../delivery/delivery-test-fixtures.ts';
import { basicPackage, passJson } from '../templates/package/fixtures.ts';
import { buildKey, sha1Hex } from '../templates/package/hash.ts';
import { createTemplateRegistry } from '../templates/registry.ts';
import { activeRelease, requireApprovedRelease } from '../templates/releases.ts';
import { issuedReleasePredicateSql } from '../templates/repo-releases.ts';
import { countStalePasses } from '../templates/repo-stale.ts';
import { resetBakedSync, syncBakedTemplates } from '../templates/sync.ts';
import { bakedFrom, fakeAssets, sourceOf } from '../templates/testing.ts';
import { approveAppleRelease, createAppleReleaseCandidate } from './apple-release-test-fixtures.ts';
import { type ReissueParams, reissuePage } from './bulk-reissue-page.ts';
import { createPassRow } from './create.ts';
import { overrideDeps } from './deps.ts';
import { requestRefresh } from './pass-service-refresh.ts';
import { ICON_PNG, type Kit, setupKit } from './pass-test-fixtures.ts';
import { publishPass } from './publish.ts';
import { getPass } from './repo-read-pass.ts';
import { hasNoReleaseHistory } from './repo-release.ts';
import { updatePass } from './service.ts';
import { reissueStaleTemplates, STALE_QUIET_MS } from './stale-reissue.ts';

let build = 0;
/** A newer worker build for each sync: an unordered build never replaces a different stored source. */
const syncBaked = (source: ReturnType<typeof sourceOf>) => {
  build += 1;
  const worker = {
    ...kit.env,
    CF_VERSION: {
      id: `approved-reissue-${build}`,
      tag: '',
      timestamp: new Date(Date.UTC(2040, 0, 1) + build * 1000).toISOString(),
    },
  };
  return syncBakedTemplates(createServiceContext(worker, { clock: kit.clock }), source);
};

let kit: Kit;
const assets = fakeAssets();
const system = { type: 'system', id: null } as const;
const admin = { type: 'user', id: 'admin-1' } as const;
let sequence = 0;

beforeAll(async () => {
  kit = await setupKit({ approvedReleases: false });
  kit.env.ASSETS = assets;
  overrideDeps(kit.env, { registry: createTemplateRegistry(kit.env, { ctx: kit.ctx }) });
});
afterEach(() => {
  overrideDeps(kit.env, { registry: createTemplateRegistry(kit.env, { ctx: kit.ctx }) });
});

const step = {
  do: async (_name: string, a: unknown, b?: unknown) =>
    ((typeof a === 'function' ? a : b) as () => Promise<unknown>)(),
} as unknown as Parameters<typeof runBulkReissue>[3];

const templateId = () => `tpl-approved-reissue-${sequence++}`;

/** The release digest and builder both read these same persisted version inputs and R2 bytes. */
async function version(
  id: string,
  v: string,
  options: { note?: string; subtitle?: string; global?: boolean } = {},
) {
  const manifest = structuredClone(kit.template.manifest) as TemplateManifest;
  if (options.subtitle !== undefined) {
    manifest.scan = {
      actions: [{ id: 'check_in', label: 'Check in', kind: 'check_in' }],
      display: { v: 1, header: { subtitle: options.subtitle } },
    };
  }
  const pass = structuredClone(kit.template.passJson) as PassJson;
  if (options.note) {
    pass.generic = {
      ...pass.generic,
      backFields: [{ key: 'note', label: 'Note', value: options.note }],
    } as PassJson['generic'];
  }
  const key = `templates/${kit.org.id}/${id}/${v}/icon.png`;
  await kit.env.BUCKET.put(key, ICON_PNG);
  const entry = {
    name: 'icon.png',
    slot: 'icon',
    scale: 1,
    size: ICON_PNG.length,
    sha1: await sha1Hex(ICON_PNG),
    crc32: crc32(ICON_PNG),
    width: 38,
    height: 38,
    source: { kind: 'r2', key },
  };
  await run(
    kit.env.DB,
    `INSERT OR IGNORE INTO templates
     (id, org_id, slug, name, origin, active_version, created_at, updated_at)
     VALUES (?, ?, ?, ?, 'uploaded', ?, ?, ?)`,
    [
      id,
      options.global ? null : kit.org.id,
      id,
      manifest.name,
      v,
      kit.clock.now(),
      kit.clock.now(),
    ],
  );
  await run(
    kit.env.DB,
    `INSERT INTO template_versions (template_id, version, manifest, pass_json, assets, build_key, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      v,
      JSON.stringify(manifest),
      JSON.stringify(pass),
      JSON.stringify([entry]),
      await buildKey({ manifest, passJson: pass, assets: [entry] }),
      kit.clock.now(),
    ],
  );
}
const approve = (id: string, v: string, orgId = kit.org.id, mode: Mode = 'live') =>
  approveAppleRelease(kit, { templateId: id, version: v, orgId, mode });
const issue = async (id: string, orgId = kit.org.id, mode: Mode = 'live') => {
  const release = await requireApprovedRelease(kit.ctx, id, orgId, mode, 'apple');
  return createPassRow(jobCtxOf(kit), {
    orgId,
    templateId: id,
    templateVersion: release.version,
    input: { memberName: 'Alex Morgan' },
    holderEmail: null,
    source: 'manual',
    mode,
    actor: system,
    execution: { kind: 'system' },
  });
};
/** Inserts a pre-release-era pass without fabricating a release or approval. */
async function legacyPass(id: string) {
  const template = await createTemplateRegistry(kit.env, { ctx: kit.ctx }).resolve(id, 'v1');
  return makePass(kit.fx, { orgId: kit.org.id, template });
}
const cron = async () => {
  kit.clock.set(kit.clock.now() + STALE_QUIET_MS + 1);
  await reissueStaleTemplates(kit.ctx);
};
const workflows = (id: string) =>
  kit.workflow.created
    .filter((w) => (w.params as ReissueParams).templateId === id)
    .map((w) => ({ id: w.id, params: w.params as ReissueParams }));
const execute = (w: { id: string; params: ReissueParams }) =>
  runBulkReissue(kit.env, w.id, w.params, step);
const snapshot = async (id: string) => ({
  pass: await first(
    kit.env.DB,
    'SELECT org_id, mode, template_version, release_id, version, object_key FROM passes WHERE id = ?',
    [id],
  ),
  versions: await first(kit.env.DB, 'SELECT COUNT(*) AS n FROM pass_versions WHERE pass_id = ?', [
    id,
  ]),
  outbox: await first(kit.env.DB, 'SELECT COUNT(*) AS n FROM outbox WHERE pass_id = ?', [id]),
  events: await first(kit.env.DB, 'SELECT COUNT(*) AS n FROM pass_events WHERE pass_id = ?', [id]),
  objects: (await kit.env.BUCKET.list({ prefix: `passes/${id}/` })).objects
    .map((o) => o.key)
    .sort(),
});
async function atUpload(id: string, change: () => Promise<unknown>, work: () => Promise<unknown>) {
  let hits = 0;
  const put = kit.env.BUCKET.put.bind(kit.env.BUCKET);
  const spy = vi.spyOn(kit.env.BUCKET, 'put').mockImplementation(async (key, value, options) => {
    const object = await put(key, value, options);
    if (key.startsWith(`passes/${id}/`) && !hits++) await change();
    return object;
  });
  try {
    await work();
    expect(hits).toBe(1);
  } finally {
    spy.mockRestore();
  }
}
describe('approved release reissue', () => {
  it('queues and executes each mode against its own approval, ignoring the draft pointer', async () => {
    const id = templateId();
    await version(id, 'v1', { note: 'Initial', global: true });
    await approve(id, 'v1');
    await approve(id, 'v1', kit.org.id, 'test');
    const other = await makeOrg(kit.fx, { name: 'Independent tenant' });
    await approve(id, 'v1', other.id);
    const otherPass = await issue(id, other.id);
    const live = await issue(id);
    const test = await issue(id, kit.org.id, 'test');
    await kit.settle();
    await cron();
    expect(workflows(id)).toHaveLength(0);
    await version(id, 'v2', { note: 'Live approved' });
    await version(id, 'v3', { note: 'Test approved' });
    const liveRelease = await approve(id, 'v2');
    const testRelease = await approve(id, 'v3', kit.org.id, 'test');
    await version(id, 'v4', { note: 'Unapproved draft' });
    await run(kit.env.DB, 'UPDATE templates SET active_version = ?, updated_at = ? WHERE id = ?', [
      'v4',
      kit.clock.now(),
      id,
    ]);
    expect(await countStalePasses(kit.env.DB, id, 'v2', kit.org.id, 'live')).toBe(1);
    expect(await countStalePasses(kit.env.DB, id, 'v3', kit.org.id, 'test')).toBe(1);
    const testBefore = await snapshot(test.id);
    const otherBefore = await snapshot(otherPass.id);
    await cron();
    await cron();
    const jobs = workflows(id);
    expect(jobs).toHaveLength(2);
    const liveJob = jobs.find((job) => job.params.mode === 'live');
    const testJob = jobs.find((job) => job.params.mode === 'test');
    expect(liveJob?.params).toMatchObject({
      orgId: kit.org.id,
      templateId: id,
      mode: 'live',
      version: 'v2',
      releaseId: liveRelease.id,
      releaseGeneration: liveRelease.generation,
    });
    expect(testJob?.params).toMatchObject({
      orgId: kit.org.id,
      templateId: id,
      mode: 'test',
      version: 'v3',
      releaseId: testRelease.id,
      releaseGeneration: testRelease.generation,
    });
    if (!liveJob || !testJob) throw new Error('Missing mode-scoped reissue');
    expect(await execute(liveJob)).toEqual({ changed: 1, unchanged: 0, failed: 0 });
    expect(await snapshot(test.id)).toEqual(testBefore);
    expect((await snapshot(live.id)).pass).toMatchObject({
      template_version: 'v2',
      release_id: liveRelease.id,
    });
    expect(await execute(testJob)).toEqual({ changed: 1, unchanged: 0, failed: 0 });
    expect((await snapshot(test.id)).pass).toMatchObject({
      template_version: 'v3',
      release_id: testRelease.id,
    });
    expect(await snapshot(otherPass.id)).toEqual(otherBefore);
  }, 60_000);

  it('rejects draft and submitted-but-unapproved versions even when the draft pointer names them', async () => {
    const id = templateId();
    await version(id, 'v1', { note: 'Initial' });
    const old = await approve(id, 'v1');
    const pass = await issue(id);
    await kit.settle();
    const before = await snapshot(pass.id);
    for (const v of ['v2', 'v3']) {
      await version(id, v, { note: v });
      await run(
        kit.env.DB,
        'UPDATE templates SET active_version = ?, updated_at = ? WHERE id = ?',
        [v, kit.clock.now(), id],
      );
      if (v === 'v3') await createAppleReleaseCandidate(kit, { templateId: id, version: v });
      await expect(
        updatePass(jobCtxOf(kit), admin, pass.id, { templateVersion: v }, { scope: null }),
      ).rejects.toMatchObject({ code: 'TEMPLATE_RELEASE_CONFLICT' });
      await cron();
      expect(workflows(id)).toHaveLength(0);
      expect(await snapshot(pass.id)).toEqual(before);
    }
    expect((await snapshot(pass.id)).pass).toMatchObject({
      template_version: 'v1',
      release_id: old.id,
    });
  }, 60_000);

  it('fences an old queued generation even when approval changes after artifact upload', async () => {
    const id = templateId();
    await version(id, 'v1', { note: 'Initial' });
    await approve(id, 'v1');
    const pass = await issue(id);
    await kit.settle();
    await version(id, 'v2', { note: 'Queued' });
    const queued = await approve(id, 'v2');
    await cron();
    const oldJob = workflows(id)[0];
    expect(oldJob?.params).toMatchObject({
      releaseId: queued.id,
      releaseGeneration: queued.generation,
    });
    if (!oldJob) throw new Error('Missing queued reissue');
    await version(id, 'v3', { note: 'New approval' });
    const before = await snapshot(pass.id);
    await atUpload(
      pass.id,
      () => approve(id, 'v3'),
      async () => {
        expect(await execute(oldJob)).toEqual({ changed: 0, unchanged: 0, failed: 1 });
      },
    );
    const current = await requireApprovedRelease(kit.ctx, id, kit.org.id, 'live', 'apple');
    expect(current.version).toBe('v3');
    expect(await snapshot(pass.id)).toEqual(before);
    await cron();
    const latest = workflows(id).find((job) => job.params.version === 'v3');
    expect(latest?.params).toMatchObject({
      releaseId: current.id,
      releaseGeneration: current.generation,
    });
    if (!latest) throw new Error('Missing newer release');
    expect(await execute(latest)).toEqual({ changed: 1, unchanged: 0, failed: 0 });
    expect((await snapshot(pass.id)).pass).toMatchObject({
      template_version: 'v3',
      release_id: current.id,
    });
    const republished = await approve(id, 'v3');
    expect(republished.generation).toBeGreaterThan(current.generation);
    const settled = await snapshot(pass.id);
    await expect(
      publishPass(jobCtxOf(kit), {
        passId: pass.id,
        cause: 'template_upgrade',
        actor: system,
        expectedRelease: { id: current.id, generation: current.generation },
        mutate: () => ({ templateVersion: 'v3' }),
      }),
    ).rejects.toMatchObject({ code: 'TEMPLATE_RELEASE_CONFLICT' });
    expect(await snapshot(pass.id)).toEqual(settled);
    await version(id, 'v4', { note: 'Direct update' });
    const target = await approve(id, 'v4');
    await atUpload(
      pass.id,
      () => approve(id, 'v4'),
      async () => {
        await expect(
          updatePass(jobCtxOf(kit), admin, pass.id, { templateVersion: 'v4' }, { scope: null }),
        ).rejects.toMatchObject({ code: 'TEMPLATE_RELEASE_CONFLICT' });
      },
    );
    expect(
      (await requireApprovedRelease(kit.ctx, id, kit.org.id, 'live', 'apple')).generation,
    ).toBeGreaterThan(target.generation);
    expect(await snapshot(pass.id)).toEqual(settled);
  }, 60_000);

  it('allows a same-version refresh and resign after approval advances without replacing provenance', async () => {
    const id = templateId();
    await version(id, 'v1', { note: 'Initial' });
    const initial = await approve(id, 'v1');
    const pass = await issue(id);
    await version(id, 'v2', { note: 'New approval' });
    await approve(id, 'v2');
    await updatePass(
      jobCtxOf(kit),
      admin,
      pass.id,
      { input: { memberName: 'Updated' } },
      { scope: null },
    );
    await kit.settle();
    const updated = await getPass(kit.env.DB, pass.id);
    if (!updated) throw new Error('Pass not found');
    expect(
      await requestRefresh(jobCtxOf(kit), pass.id, admin, {
        ...updated,
        ownerUserId: updated.ownerUserId ?? undefined,
      }),
    ).toMatchObject({ coalesced: false });
    const job = JobSchema.parse(kit.queue.sent.at(-1));
    if (job.kind !== 'pass.refresh') throw new Error('Missing refresh job');
    await handlePassRefresh(job, jobCtxOf(kit));
    expect(
      await first(kit.env.DB, 'SELECT last_refreshed_at FROM passes WHERE id = ?', [pass.id]),
    ).toEqual({ last_refreshed_at: kit.clock.now() });
    const refreshed = await snapshot(pass.id);
    expect(refreshed.pass).toMatchObject({ template_version: 'v1', release_id: initial.id });
    const result = await reissuePage(
      jobCtxOf(kit),
      {
        templateId: id,
        version: 'v2',
        orgId: kit.org.id,
        mode: 'live',
        cause: 'resign',
      },
      null,
    );
    expect(result).toMatchObject({ changed: 1, failed: 0 });
    const resigned = await snapshot(pass.id);
    expect(resigned.pass).toMatchObject({ template_version: 'v1', release_id: initial.id });
    expect(resigned.objects).toHaveLength(refreshed.objects.length + 1);
  }, 60_000);

  it('keeps legacy provenance empty for matching or absent heads, and rejects a different head', async () => {
    const id = templateId();
    await version(id, 'v1', { note: 'Legacy', global: true });
    const other = await makeOrg(kit.fx, { name: 'Other release scope' });
    await approve(id, 'v1', other.id);
    await approve(id, 'v1', kit.org.id, 'test');
    const pass = await legacyPass(id);
    expect(await activeRelease(kit.ctx, id, kit.org.id, 'live', 'apple')).toBeNull();
    expect(await hasNoReleaseHistory(kit.env.DB, id, kit.org.id, 'live')).toBe(true);
    const resign = () =>
      publishPass(jobCtxOf(kit), {
        passId: pass.id,
        actor: system,
        cause: 'resign',
        force: true,
      });
    expect((await resign()).changed).toBe(true);
    expect((await snapshot(pass.id)).pass).toMatchObject({
      template_version: 'v1',
      release_id: null,
    });
    expect(
      (await publishPass(jobCtxOf(kit), { passId: pass.id, actor: system, cause: 'admin' }))
        .changed,
    ).toBe(false);
    await version(id, 'v2', { note: 'Different approved version' });
    const withoutHead = await snapshot(pass.id);
    await expect(
      updatePass(jobCtxOf(kit), admin, pass.id, { templateVersion: 'v2' }, { scope: null }),
    ).rejects.toMatchObject({ code: 'TEMPLATE_RELEASE_REQUIRED' });
    expect(await snapshot(pass.id)).toEqual(withoutHead);

    await approve(id, 'v1');
    await updatePass(
      jobCtxOf(kit),
      admin,
      pass.id,
      { input: { memberName: 'Refreshed' } },
      { scope: null },
    );
    expect((await resign()).changed).toBe(true);
    await kit.settle();
    const before = await snapshot(pass.id);
    expect(before.pass).toMatchObject({ template_version: 'v1', release_id: null });

    await approve(id, 'v2');
    for (const force of [false, true]) {
      await expect(
        publishPass(jobCtxOf(kit), {
          passId: pass.id,
          actor: system,
          cause: force ? 'resign' : 'admin',
          force,
        }),
      ).rejects.toMatchObject({ code: 'TEMPLATE_RELEASE_CONFLICT' });
    }
    await expect(
      updatePass(
        jobCtxOf(kit),
        admin,
        pass.id,
        { input: { memberName: 'Blocked' } },
        { scope: null },
      ),
    ).rejects.toMatchObject({ code: 'TEMPLATE_RELEASE_CONFLICT' });
    expect(await snapshot(pass.id)).toEqual(before);
  }, 60_000);

  it.each([
    ['no-op', 'absent'],
    ['resign', 'absent'],
    ['no-op', 'matching'],
    ['resign', 'matching'],
    ['no-op', 'ineligible'],
    ['resign', 'ineligible'],
  ] as const)(
    'fences a legacy %s when the %s release context changes during the build',
    async (kind, initial) => {
      const id = templateId();
      await version(id, 'v1', { note: 'Legacy race' });
      const pass = await legacyPass(id);
      expect(await activeRelease(kit.ctx, id, kit.org.id, 'live', 'apple')).toBeNull();
      await publishPass(jobCtxOf(kit), {
        passId: pass.id,
        actor: system,
        cause: 'resign',
        force: true,
      });
      const original = initial === 'matching' ? await approve(id, 'v1') : null;
      const changeHead = async () => {
        await approve(id, 'v1');
        if (initial === 'ineligible')
          await run(kit.env.DB, "UPDATE templates SET status = 'archived' WHERE id = ?", [id]);
      };
      await kit.settle();
      const before = await snapshot(pass.id);
      expect(before.pass).toMatchObject({ template_version: 'v1', release_id: null });
      if (kind === 'resign') {
        await atUpload(pass.id, changeHead, async () => {
          await expect(
            publishPass(jobCtxOf(kit), {
              passId: pass.id,
              actor: system,
              cause: 'resign',
              force: true,
            }),
          ).rejects.toMatchObject({ code: 'TEMPLATE_RELEASE_CONFLICT' });
        });
      } else {
        expect(
          (await publishPass(jobCtxOf(kit), { passId: pass.id, actor: system, cause: 'admin' }))
            .changed,
        ).toBe(false);
        // A no-op publish never opens a template asset, so the race lands on its final fence: the
        // read that proves the snapshot and the absence (or identity) of release history.
        const seam = interveneAtD1(
          kit.env.DB,
          { method: 'first', sql: /^\s*SELECT id FROM passes WHERE/i, when: 'before' },
          changeHead,
        );
        await expect(
          publishPass(
            { ...kit.ctx, env: { ...kit.env, DB: seam.db } },
            { passId: pass.id, actor: system, cause: 'admin' },
          ),
        ).rejects.toMatchObject({ code: 'TEMPLATE_RELEASE_CONFLICT' });
        expect(seam.hits()).toBe(1);
      }
      const head = await activeRelease(kit.ctx, id, kit.org.id, 'live', 'apple');
      if (initial === 'ineligible') {
        expect(head).toBeNull();
        expect(await hasNoReleaseHistory(kit.env.DB, id, kit.org.id, 'live')).toBe(false);
      } else {
        expect(head).toMatchObject({ version: 'v1' });
        if (original) expect(head?.generation).toBeGreaterThan(original.generation);
      }
      expect(await snapshot(pass.id)).toEqual(before);
    },
    60_000,
  );

  it.each(['tenant', 'baked system'] as const)(
    'rejects legacy maintenance when %s release history is present but ineligible',
    async (scope) => {
      let id: string;
      let passId: string;
      let retire: () => Promise<unknown>;
      if (scope === 'tenant') {
        id = templateId();
        await version(id, 'v1', { note: 'Retired release' });
        passId = (await legacyPass(id)).id;
        await approve(id, 'v1');
        retire = () =>
          run(kit.env.DB, "UPDATE templates SET status = 'archived' WHERE id = ?", [id]);
      } else {
        const slug = `legacy-history-${sequence++}`;
        const fixture = await bakedFrom(
          slug,
          basicPackage({
            'wallet.template.json': JSON.stringify(kit.template.manifest),
          }),
        );
        for (const [path, bytes] of fixture.files) assets.files.set(path, bytes);
        const source = sourceOf([fixture], `${slug}-published`);
        resetBakedSync();
        await syncBaked(source);
        const registry = createTemplateRegistry(kit.env, { source, ctx: kit.ctx });
        overrideDeps(kit.env, { registry });
        id = fixture.template.id;
        const template = await registry.resolve(id, fixture.template.version);
        passId = (await makePass(kit.fx, { orgId: kit.org.id, template })).id;
        retire = async () => {
          resetBakedSync();
          await syncBaked(sourceOf([], `${slug}-retired`));
        };
      }
      expect(await activeRelease(kit.ctx, id, kit.org.id, 'live', 'apple')).not.toBeNull();
      expect(await hasNoReleaseHistory(kit.env.DB, id, kit.org.id, 'live')).toBe(false);
      expect(
        (
          await publishPass(jobCtxOf(kit), {
            passId,
            actor: system,
            cause: 'resign',
            force: true,
          })
        ).pass.releaseId,
      ).toBeNull();
      await kit.settle();
      const before = await snapshot(passId);
      await retire();
      expect(await activeRelease(kit.ctx, id, kit.org.id, 'live', 'apple')).toBeNull();
      expect(await hasNoReleaseHistory(kit.env.DB, id, kit.org.id, 'live')).toBe(false);
      for (const force of [false, true]) {
        await expect(
          publishPass(jobCtxOf(kit), {
            passId,
            actor: system,
            cause: force ? 'resign' : 'admin',
            force,
          }),
        ).rejects.toMatchObject({ code: 'TEMPLATE_RELEASE_CONFLICT' });
      }
      expect(await snapshot(passId)).toEqual(before);
    },
    60_000,
  );

  it('does not rebuild equivalent display-only releases, including a direct metadata upgrade', async () => {
    const id = templateId();
    await version(id, 'v1', { subtitle: 'Before' });
    const initial = await approve(id, 'v1');
    const pass = await issue(id);
    await kit.settle();
    const before = await snapshot(pass.id);
    await version(id, 'v2', { subtitle: 'After' });
    const next = await approve(id, 'v2');
    expect(
      await first(
        kit.env.DB,
        `SELECT COUNT(*) AS n, COUNT(DISTINCT build_key) AS keys
      FROM template_versions WHERE template_id = ? AND build_key IS NOT NULL`,
        [id],
      ),
    ).toEqual({ n: 2, keys: 1 });
    expect(await countStalePasses(kit.env.DB, id, 'v2', kit.org.id, 'live')).toBe(0);
    await cron();
    expect(workflows(id)).toHaveLength(0);
    expect(await snapshot(pass.id)).toEqual(before);
    expect(before.pass).toMatchObject({ template_version: 'v1', release_id: initial.id });
    await updatePass(jobCtxOf(kit), admin, pass.id, { templateVersion: 'v2' }, { scope: null });
    const after = await snapshot(pass.id);
    expect(after.pass).toMatchObject({ template_version: 'v2', release_id: next.id });
    expect(after).toMatchObject({
      objects: before.objects,
      versions: before.versions,
      outbox: before.outbox,
      events: before.events,
    });
  }, 60_000);

  it('fans a baked global fallback out into isolated organization-scoped reissues', async () => {
    const slug = `approved-fallback-${sequence++}`;
    const pack = (note: string) =>
      basicPackage(
        { 'wallet.template.json': JSON.stringify(kit.template.manifest) },
        passJson({
          generic: {
            primaryFields: [{ key: 'name', label: 'Member', value: '' }],
            backFields: [{ key: 'note', label: 'Note', value: note }],
          },
        }),
      );
    const [v1, v2] = await Promise.all([
      bakedFrom(slug, pack('Initial')),
      bakedFrom(slug, pack('Global')),
    ]);
    for (const fixture of [v1, v2])
      for (const [path, bytes] of fixture.files) assets.files.set(path, bytes);
    const sync = async (fixture: typeof v1, hash: string) => {
      const source = sourceOf([fixture], hash);
      resetBakedSync();
      await syncBaked(source);
      overrideDeps(kit.env, {
        registry: createTemplateRegistry(kit.env, { source, ctx: kit.ctx }),
      });
    };
    await sync(v1, `${slug}-1`);
    const id = v1.template.id;
    const other = await makeOrg(kit.fx, { name: 'Fallback org' });
    const current = await makeOrg(kit.fx, { name: 'Already current' });
    const global = await requireApprovedRelease(kit.ctx, id, other.id, 'live', 'apple');
    expect(global).toMatchObject({ orgId: null, version: v1.template.version });
    const a = await issue(id);
    const b = await issue(id, other.id);
    await kit.settle();
    const bBefore = await snapshot(b.id);
    await sync(v2, `${slug}-2`);
    const fallback = await requireApprovedRelease(kit.ctx, id, other.id, 'live', 'apple');
    expect(fallback).toMatchObject({ orgId: null, version: v2.template.version });
    const c = await issue(id, current.id);
    await kit.settle();
    const cBefore = await snapshot(c.id);
    expect(await countStalePasses(kit.env.DB, id, v2.template.version, kit.org.id, 'live')).toBe(1);
    expect(await countStalePasses(kit.env.DB, id, v2.template.version, other.id, 'live')).toBe(1);
    expect(await countStalePasses(kit.env.DB, id, v2.template.version, current.id, 'live')).toBe(0);
    await cron();
    const jobs = workflows(id);
    expect(jobs).toHaveLength(2);
    const aJob = jobs.find((job) => job.params.orgId === kit.org.id);
    const bJob = jobs.find((job) => job.params.orgId === other.id);
    expect(aJob?.params).toMatchObject({
      mode: 'live',
      version: v2.template.version,
      releaseId: fallback.id,
    });
    expect(bJob?.params).toMatchObject({
      mode: 'live',
      version: v2.template.version,
      releaseId: fallback.id,
    });
    if (!aJob || !bJob) throw new Error('Missing tenant-scoped reissue');
    expect(await execute(aJob)).toEqual({ changed: 1, unchanged: 0, failed: 0 });
    expect(await snapshot(b.id)).toEqual(bBefore);
    expect(await snapshot(c.id)).toEqual(cBefore);
    expect((await snapshot(a.id)).pass).toMatchObject({
      template_version: v2.template.version,
      release_id: fallback.id,
    });
    expect(await execute(bJob)).toEqual({ changed: 1, unchanged: 0, failed: 0 });
    expect((await snapshot(b.id)).pass).toMatchObject({
      template_version: v2.template.version,
      release_id: fallback.id,
    });
    expect((await snapshot(c.id)).pass).toMatchObject({
      template_version: v2.template.version,
      release_id: fallback.id,
    });
  }, 60_000);
});

describe('issued release provenance', () => {
  it('retains historical scoped proof after the head advances and rejects mismatched bindings', async () => {
    const id = templateId();
    await version(id, 'v1', { note: 'First issuance' });
    const original = await approve(id, 'v1');
    await version(id, 'v2', { note: 'Later release' });
    await approve(id, 'v2');
    const predicate = issuedReleasePredicateSql(
      {
        releaseIdSql: 'requested.release_id',
        versionSql: 'requested.version',
        generationSql: 'requested.generation',
        candidateHashSql: 'requested.hash',
      },
      {
        templateIdSql: 'requested.template_id',
        orgIdSql: 'requested.org_id',
        modeSql: 'requested.mode',
        providerSql: "'apple'",
      },
    );
    const check = (
      overrides: {
        id?: string;
        version?: string;
        generation?: number;
        hash?: string;
        orgId?: string;
        mode?: Mode;
      } = {},
    ) =>
      first<{ ok: number }>(
        kit.env.DB,
        `
      SELECT 1 AS ok FROM
        (SELECT ? AS release_id, ? AS version, ? AS generation, ? AS hash,
                ? AS template_id, ? AS org_id, ? AS mode) requested
      WHERE ${predicate}`,
        [
          overrides.id ?? original.id,
          overrides.version ?? original.version,
          overrides.generation ?? original.generation,
          overrides.hash ?? original.candidateHash,
          id,
          overrides.orgId ?? kit.org.id,
          overrides.mode ?? 'live',
        ],
      );
    expect(await check()).toEqual({ ok: 1 });
    expect(await check({ version: 'v2' })).toBeNull();
    expect(await check({ generation: original.generation + 1 })).toBeNull();
    expect(await check({ hash: '0'.repeat(64) })).toBeNull();
    expect(await check({ orgId: 'foreign-org' })).toBeNull();
    expect(await check({ mode: 'test' })).toBeNull();
  }, 60_000);
});
