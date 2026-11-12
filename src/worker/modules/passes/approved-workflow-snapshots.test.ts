import type { OpenAPIHono } from '@hono/zod-openapi';
import { beforeAll, describe, expect, it } from 'vitest';
import { makeOrg, makePass, makeSession, makeUser } from '../../../../test/helpers/index.ts';
import { crc32 } from '../../../passkit/index.ts';
import type { PassJson, TemplateManifest } from '../../../passkit/types.ts';
import type { Mode } from '../../../shared/contracts/common.ts';
import { createApp } from '../../app.ts';
import type { AppBindings } from '../../platform/context.ts';
import { all, first, run } from '../../platform/db.ts';
import { runBulkReissue } from '../../workflows/bulk-reissue.ts';
import { hashSessionCookie } from '../auth/sessions.ts';
import { jobCtxOf } from '../delivery/delivery-test-fixtures.ts';
import { buildKey, sha1Hex } from '../templates/package/hash.ts';
import { createTemplateRegistry, r2Key } from '../templates/registry.ts';
import { requireApprovedRelease, type TemplateRelease } from '../templates/releases.ts';
import { fakeAssets, setTemplateStatus as setStatus } from '../templates/testing.ts';
import { approveAppleRelease } from './apple-release-test-fixtures.ts';
import { startBulkReissue } from './bulk.ts';
import { type ReissueParams, reissuePage } from './bulk-reissue-page.ts';
import { createPassRow } from './create.ts';
import { overrideDeps } from './deps.ts';
import { ICON_PNG, type Kit, setupKit } from './pass-test-fixtures.ts';
import { insertWorkflowRun } from './repo.ts';
import { getPass } from './repo-read-pass.ts';
import { reissueStaleTemplates, STALE_QUIET_MS } from './stale-reissue.ts';
import { setupTenantTestAuth, type TenantTestAuth } from './tenant-test-fixtures.ts';

const ORIGIN = 'https://wallet.test';
const system = { type: 'system', id: null } as const;
let kit: Kit;
let auth: TenantTestAuth;
let app: OpenAPIHono<AppBindings>;

beforeAll(async () => {
  kit = await setupKit({ approvedReleases: false });
  kit.env.ASSETS = fakeAssets();
  overrideDeps(kit.env, { registry: createTemplateRegistry(kit.env, { ctx: kit.ctx }) });
  auth = await setupTenantTestAuth(kit);
  app = createApp({ stores: auth.stores, clock: kit.clock });
}, 60_000);

type Workflow = { id: string; params: ReissueParams };
type Step = Parameters<typeof runBulkReissue>[3];
const call = (a: unknown, b: unknown) =>
  ((typeof a === 'function' ? a : b) as () => Promise<unknown>)();
const step = {
  do: async (_name: string, a: unknown, b?: unknown) => call(a, b),
} as unknown as Step;

/** Persist actual R2 assets and build inputs for a shared uploaded template. */
async function addVersion(
  id: string,
  version: string,
  options: { note?: string; subtitle?: string } = {},
) {
  const manifest = structuredClone(kit.template.manifest) as TemplateManifest;
  if (options.subtitle !== undefined) {
    manifest.scan = {
      actions: [{ id: 'check_in', label: 'Check in', kind: 'check_in' }],
      display: { v: 1, header: { subtitle: options.subtitle } },
    };
  }
  const pass = structuredClone(kit.template.passJson) as PassJson;
  if (options.note !== undefined) {
    pass.generic = {
      ...pass.generic,
      backFields: [{ key: 'note', label: 'Note', value: options.note }],
    } as PassJson['generic'];
  }
  const key = r2Key(null, id, version, 'icon.png');
  await kit.env.BUCKET.put(key, ICON_PNG);
  const asset = {
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
     VALUES (?, NULL, ?, ?, 'uploaded', ?, ?, ?)`,
    [id, id, manifest.name, version, kit.clock.now(), kit.clock.now()],
  );
  await run(
    kit.env.DB,
    `INSERT INTO template_versions (template_id, version, manifest, pass_json, assets, build_key, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      version,
      JSON.stringify(manifest),
      JSON.stringify(pass),
      JSON.stringify([asset]),
      await buildKey({ manifest, passJson: pass, assets: [asset] }),
      kit.clock.now(),
    ],
  );
}

const newTemplateId = () => `tpl-workflow-${kit.fx.ids.token(8)}`;
const approve = (
  id: string,
  version: string,
  orgId = kit.org.id,
  mode: Mode = 'live',
  db?: D1Database,
) => approveAppleRelease(kit, { templateId: id, version, orgId, mode, ...(db ? { db } : {}) });

async function issue(release: TemplateRelease, orgId: string, mode: Mode = 'live') {
  return createPassRow(jobCtxOf(kit), {
    orgId,
    mode,
    templateId: release.templateId,
    templateVersion: release.version,
    releaseId: release.id,
    releaseGeneration: release.generation,
    input: { memberName: 'Workflow member' },
    holderEmail: null,
    source: 'manual',
    execution: { kind: 'system' },
    actor: system,
  });
}

async function postReissue(body: object, mode: Mode = 'live', headers = auth.admin({ mode })) {
  return app.request(
    `${ORIGIN}/api/v1/passes/bulk-reissue`,
    {
      method: 'POST',
      headers: { ...headers, origin: ORIGIN, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    },
    kit.env,
  );
}

async function enqueue(body: object, mode: Mode = 'live'): Promise<Workflow> {
  const response = await postReissue(body, mode);
  expect(response.status).toBe(202);
  const { workflowInstanceId } = (await response.json()) as { workflowInstanceId: string };
  const workflow = kit.workflow.created.find((item) => item.id === workflowInstanceId);
  if (!workflow) throw new Error('The workflow was not enqueued');
  return { id: workflow.id, params: workflow.params as ReissueParams };
}

function queued(id: string): Workflow {
  const workflow = kit.workflow.created.find((item) => item.id === id);
  if (!workflow) throw new Error('The workflow was not enqueued');
  return { id: workflow.id, params: workflow.params as ReissueParams };
}

const execute = (workflow: Workflow, workflowStep = step) =>
  runBulkReissue(kit.env, workflow.id, workflow.params, workflowStep);

interface Snapshot {
  org_id: string;
  mode: Mode;
  template_id: string;
  release_id: string;
  generation: number;
  version: string;
}
const expectedSnapshot = (release: TemplateRelease, orgId: string): Snapshot => ({
  org_id: orgId,
  mode: release.mode,
  template_id: release.templateId,
  release_id: release.id,
  generation: release.generation,
  version: release.version,
});
const ordered = (rows: Snapshot[]) =>
  rows.sort(
    (a, b) =>
      a.org_id.localeCompare(b.org_id) ||
      a.mode.localeCompare(b.mode) ||
      a.template_id.localeCompare(b.template_id),
  );
const snapshots = (id: string) =>
  all<Snapshot>(
    kit.env.DB,
    `SELECT org_id, mode, template_id, release_id, generation, version
   FROM workflow_release_snapshots WHERE instance_id = ? ORDER BY org_id, mode, template_id`,
    [id],
  );

async function reservations(targetId: string) {
  return {
    runs: await all(
      kit.env.DB,
      'SELECT instance_id FROM workflow_runs WHERE target_id = ? ORDER BY instance_id',
      [targetId],
    ),
    sets: await all(
      kit.env.DB,
      `SELECT s.instance_id FROM workflow_release_snapshot_sets s
       JOIN workflow_runs w ON w.instance_id = s.instance_id
       WHERE w.target_id = ? ORDER BY s.instance_id`,
      [targetId],
    ),
    snapshots: await all(
      kit.env.DB,
      `SELECT s.instance_id, s.org_id, s.mode, s.template_id, s.release_id, s.generation, s.version
       FROM workflow_release_snapshots s JOIN workflow_runs w ON w.instance_id = s.instance_id
       WHERE w.target_id = ? ORDER BY s.instance_id, s.org_id, s.mode, s.template_id`,
      [targetId],
    ),
  };
}

async function effects(passId: string) {
  return {
    pass: await first(
      kit.env.DB,
      'SELECT template_version, release_id, version, object_key FROM passes WHERE id = ?',
      [passId],
    ),
    versions: await all(
      kit.env.DB,
      'SELECT version, template_version, cause FROM pass_versions WHERE pass_id = ? ORDER BY version',
      [passId],
    ),
    events: await first(kit.env.DB, 'SELECT COUNT(*) AS n FROM pass_events WHERE pass_id = ?', [
      passId,
    ]),
    outbox: await first(kit.env.DB, 'SELECT COUNT(*) AS n FROM outbox WHERE pass_id = ?', [passId]),
    objects: (await kit.env.BUCKET.list({ prefix: `passes/${passId}/` })).objects
      .map((object) => object.key)
      .sort(),
  };
}

/** Interleave a real release publication after reservation preflight, just before its D1 batch. */
async function atReservation<T>(
  change: (db: D1Database) => Promise<void>,
  action: () => Promise<T>,
) {
  const db = kit.env.DB;
  const statements = new WeakMap<
    D1PreparedStatement,
    { sql: string; native: D1PreparedStatement }
  >();
  let intercepted = 0;
  const wrap = (statement: D1PreparedStatement, sql: string): D1PreparedStatement => {
    const wrapped = new Proxy(statement, {
      get(target, prop) {
        if (prop === 'bind') return (...values: unknown[]) => wrap(target.bind(...values), sql);
        const value = Reflect.get(target, prop, target);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    statements.set(wrapped, { sql, native: statement });
    return wrapped;
  };
  const proxy = new Proxy(db, {
    get(target, prop) {
      if (prop === 'prepare') return (sql: string) => wrap(target.prepare(sql), sql);
      if (prop === 'batch')
        return async (batch: D1PreparedStatement[]) => {
          if (
            intercepted === 0 &&
            batch.some((statement) =>
              /^\s*INSERT\s+INTO\s+workflow_runs\b/i.test(statements.get(statement)?.sql ?? ''),
            )
          ) {
            intercepted++;
            await change(db);
          }
          return target.batch(
            batch.map((statement) => statements.get(statement)?.native ?? statement),
          );
        };
      const value = Reflect.get(target, prop, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  Object.assign(kit.env, { DB: proxy });
  try {
    const result = await action();
    expect(intercepted).toBe(1);
    return result;
  } finally {
    Object.assign(kit.env, { DB: db });
  }
}

describe('approved workflow release snapshots', () => {
  it('reserves each organization and mode independently for authenticated platform workflows', async () => {
    const id = newTemplateId();
    for (const v of ['v1', 'v2', 'v3', 'v4', 'v5']) await addVersion(id, v, { note: v });
    const other = await makeOrg(kit.fx, { name: 'Other workflow organization' });
    const initialALive = await approve(id, 'v1');
    const initialATest = await approve(id, 'v1', kit.org.id, 'test');
    const initialBLive = await approve(id, 'v1', other.id);
    const initialBTest = await approve(id, 'v1', other.id, 'test');
    const aLive = await issue(initialALive, kit.org.id);
    const aTest = await issue(initialATest, kit.org.id, 'test');
    const bLive = await issue(initialBLive, other.id);
    const bTest = await issue(initialBTest, other.id, 'test');
    const liveA = await approve(id, 'v2');
    const liveB = await approve(id, 'v3', other.id);
    const testA = await approve(id, 'v4', kit.org.id, 'test');
    const testB = await approve(id, 'v5', other.id, 'test');
    await kit.settle();

    expect((await postReissue({ templateId: id }, 'live', auth.user())).status).toBe(403);
    const live = await enqueue({ templateId: id });
    const test = await enqueue({ templateId: id }, 'test');
    const runsBeforeMismatch = await reservations(id);
    const workflowCount = kit.workflow.created.length;
    const mismatch = await postReissue({ templateId: id, version: 'v2' });
    expect(mismatch.status).toBe(409);
    expect(await mismatch.json()).toMatchObject({ code: 'TEMPLATE_RELEASE_CONFLICT' });
    expect(await reservations(id)).toEqual(runsBeforeMismatch);
    expect(kit.workflow.created).toHaveLength(workflowCount);
    const filtered = await enqueue({ templateId: id, orgId: kit.org.id, version: 'v2' });
    const systemId = await startBulkReissue(kit.ctx, system, { templateId: id });
    const bothModes = queued(systemId);
    expect(live.params).toMatchObject({
      orgId: null,
      mode: 'live',
      templateId: id,
      version: null,
      workflowInstanceId: live.id,
    });
    expect(live.params).not.toHaveProperty('releaseId');
    expect(await snapshots(live.id)).toEqual(
      ordered([expectedSnapshot(liveA, kit.org.id), expectedSnapshot(liveB, other.id)]),
    );
    expect(await snapshots(test.id)).toEqual(
      ordered([expectedSnapshot(testA, kit.org.id), expectedSnapshot(testB, other.id)]),
    );
    expect(await snapshots(filtered.id)).toEqual([expectedSnapshot(liveA, kit.org.id)]);
    const captured = ordered([
      expectedSnapshot(liveA, kit.org.id),
      expectedSnapshot(liveB, other.id),
      expectedSnapshot(testA, kit.org.id),
      expectedSnapshot(testB, other.id),
    ]);
    expect(await snapshots(bothModes.id)).toEqual(captured);
    await expect(
      run(
        kit.env.DB,
        'UPDATE workflow_release_snapshots SET generation = generation + 1 WHERE instance_id = ?',
        [bothModes.id],
      ),
    ).rejects.toThrow();

    expect(await execute(live)).toEqual({ changed: 2, unchanged: 0, failed: 0 });
    expect(await getPass(kit.env.DB, aLive.id)).toMatchObject({
      templateVersion: 'v2',
      releaseId: liveA.id,
    });
    expect(await getPass(kit.env.DB, bLive.id)).toMatchObject({
      templateVersion: 'v3',
      releaseId: liveB.id,
    });
    expect(await getPass(kit.env.DB, aTest.id)).toMatchObject({
      templateVersion: 'v1',
      releaseId: initialATest.id,
    });
    expect(await getPass(kit.env.DB, bTest.id)).toMatchObject({
      templateVersion: 'v1',
      releaseId: initialBTest.id,
    });
    expect(await execute(test)).toEqual({ changed: 2, unchanged: 0, failed: 0 });
    expect(await getPass(kit.env.DB, aTest.id)).toMatchObject({
      templateVersion: 'v4',
      releaseId: testA.id,
    });
    expect(await getPass(kit.env.DB, bTest.id)).toMatchObject({
      templateVersion: 'v5',
      releaseId: testB.id,
    });
    expect(await snapshots(bothModes.id)).toEqual(captured);
  }, 120_000);

  it('keeps page pins and excludes scopes appearing after enqueue, even for a newer same-version release', async () => {
    const id = newTemplateId();
    await addVersion(id, 'v1', { note: 'Initial' });
    await addVersion(id, 'v2', { note: 'Target' });
    const lateOrg = await makeOrg(kit.fx, { name: 'Late workflow organization' });
    const initial = await approve(id, 'v1');
    const lateInitial = await approve(id, 'v1', lateOrg.id);
    const passes = [];
    for (let i = 0; i < 101; i += 10) {
      passes.push(
        ...(await Promise.all(
          Array.from({ length: Math.min(10, 101 - i) }, () => issue(initial, kit.org.id)),
        )),
      );
    }
    const target = await approve(id, 'v2');
    const workflow = await enqueue({ templateId: id });
    const captured = [expectedSnapshot(target, kit.org.id)];
    expect(await snapshots(workflow.id)).toEqual(captured);

    const late = await issue(lateInitial, lateOrg.id);
    const lateTarget = await approve(id, 'v2', lateOrg.id);
    await kit.settle();
    const sorted = passes.map((pass) => pass.id).sort();
    const lastId = sorted[sorted.length - 1];
    if (!lastId) throw new Error('Missing final pass');
    const lastBefore = await effects(lastId);
    const lateBefore = await effects(late.id);
    const newer: TemplateRelease[] = [];
    const pages: string[] = [];
    const interleaved = {
      do: async (name: string, a: unknown, b?: unknown) => {
        if (name.startsWith('page-')) pages.push(name);
        if (name === 'page-1') newer.push(await approve(id, 'v2'));
        return call(a, b);
      },
    } as unknown as Step;
    expect(await execute(workflow, interleaved)).toEqual({ changed: 100, unchanged: 0, failed: 1 });
    expect(pages).toEqual(['page-0', 'page-1']);
    expect(newer).toHaveLength(1);
    expect(newer[0]).toMatchObject({ version: target.version, generation: target.generation + 1 });
    expect(newer[0]?.id).not.toBe(target.id);
    expect(await snapshots(workflow.id)).toEqual(captured);
    const advanced = await first<{ n: number }>(
      kit.env.DB,
      'SELECT COUNT(*) AS n FROM passes WHERE template_id = ? AND release_id = ?',
      [id, target.id],
    );
    expect(advanced?.n).toBe(100);
    expect(await effects(lastId)).toEqual(lastBefore);
    expect(await effects(late.id)).toEqual(lateBefore);
    expect((await getPass(kit.env.DB, late.id))?.releaseId).toBe(lateInitial.id);
    expect(lateTarget.id).not.toBe(lateInitial.id);
  }, 180_000);

  it('persists a valid zero-scope marker and never adopts passes added after reservation', async () => {
    const id = newTemplateId();
    await addVersion(id, 'v1', { note: 'Initial' });
    await addVersion(id, 'v2', { note: 'Target' });
    const initial = await approve(id, 'v1');
    const workflow = await enqueue({ templateId: id });
    expect(
      await first(
        kit.env.DB,
        'SELECT instance_id FROM workflow_release_snapshot_sets WHERE instance_id = ?',
        [workflow.id],
      ),
    ).toEqual({ instance_id: workflow.id });
    expect(await snapshots(workflow.id)).toEqual([]);

    const late = await issue(initial, kit.org.id);
    await approve(id, 'v2');
    await kit.settle();
    const before = await effects(late.id);
    expect(await execute(workflow)).toEqual({ changed: 0, unchanged: 0, failed: 0 });
    expect(
      await first(
        kit.env.DB,
        'SELECT status, error_code FROM workflow_runs WHERE instance_id = ?',
        [workflow.id],
      ),
    ).toEqual({ status: 'complete', error_code: null });
    expect(await snapshots(workflow.id)).toEqual([]);
    expect(await effects(late.id)).toEqual(before);
  }, 60_000);

  it('fails closed when snapshots are missing or an old workflow has no release pin', async () => {
    const id = newTemplateId();
    await addVersion(id, 'v1', { note: 'Initial' });
    await addVersion(id, 'v2', { note: 'Target' });
    const initial = await approve(id, 'v1');
    const pass = await issue(initial, kit.org.id);
    const target = await approve(id, 'v2');
    const workflow = await enqueue({ templateId: id });
    expect(await snapshots(workflow.id)).toEqual([expectedSnapshot(target, kit.org.id)]);
    await kit.settle();
    const before = await effects(pass.id);
    // A valid empty set is distinct from an absent or legacy snapshot set.
    await run(kit.env.DB, 'DELETE FROM workflow_release_snapshots WHERE instance_id = ?', [
      workflow.id,
    ]);
    expect(
      await first(
        kit.env.DB,
        'SELECT instance_id FROM workflow_release_snapshot_sets WHERE instance_id = ?',
        [workflow.id],
      ),
    ).toEqual({ instance_id: workflow.id });
    expect(await execute(workflow)).toEqual({ changed: 0, unchanged: 0, failed: 0 });
    expect(await effects(pass.id)).toEqual(before);

    const missing = await enqueue({ templateId: id });
    await run(kit.env.DB, 'DELETE FROM workflow_release_snapshots WHERE instance_id = ?', [
      missing.id,
    ]);
    await run(kit.env.DB, 'DELETE FROM workflow_release_snapshot_sets WHERE instance_id = ?', [
      missing.id,
    ]);
    await expect(execute(missing)).rejects.toMatchObject({ code: 'TEMPLATE_RELEASE_CONFLICT' });
    expect(
      await first(
        kit.env.DB,
        'SELECT status, error_code FROM workflow_runs WHERE instance_id = ?',
        [missing.id],
      ),
    ).toEqual({ status: 'errored', error_code: 'BULK_REISSUE_FAILED' });
    expect(await effects(pass.id)).toEqual(before);

    const legacyId = `bulk-legacy-${kit.fx.ids.token(8)}`;
    await insertWorkflowRun(kit.env.DB, {
      instanceId: legacyId,
      kind: 'bulk_reissue',
      orgId: null,
      targetId: id,
      now: kit.clock.now(),
    });
    await expect(
      runBulkReissue(
        kit.env,
        legacyId,
        {
          templateId: id,
          version: 'v2',
          orgId: null,
          workflowInstanceId: legacyId,
          cause: 'template_upgrade',
        },
        step,
      ),
    ).rejects.toMatchObject({ code: 'TEMPLATE_RELEASE_CONFLICT' });
    const legacy: ReissueParams = {
      templateId: id,
      version: 'v2',
      orgId: null,
      cause: 'template_upgrade',
    };
    await expect(runBulkReissue(kit.env, legacyId, legacy, step)).rejects.toMatchObject({
      code: 'TEMPLATE_RELEASE_CONFLICT',
    });
    expect(
      await first(
        kit.env.DB,
        'SELECT status, error_code FROM workflow_runs WHERE instance_id = ?',
        [legacyId],
      ),
    ).toEqual({ status: 'errored', error_code: 'BULK_REISSUE_FAILED' });
    const scoped: ReissueParams = {
      templateId: id,
      version: 'v2',
      orgId: kit.org.id,
      mode: 'live',
      workflowInstanceId: workflow.id,
      cause: 'template_upgrade',
    };
    for (const params of [
      scoped,
      { ...scoped, releaseId: target.id },
      { ...scoped, releaseGeneration: target.generation },
      { ...scoped, releaseId: target.id, releaseGeneration: 0 },
    ]) {
      await expect(reissuePage(jobCtxOf(kit), params, null)).rejects.toMatchObject({
        code: 'TEMPLATE_RELEASE_CONFLICT',
      });
    }
    expect(await effects(pass.id)).toEqual(before);
  }, 60_000);

  it('does not silently skip an affected legacy tenant with no approved release', async () => {
    const id = newTemplateId();
    await addVersion(id, 'v1', { note: 'Initial' });
    await addVersion(id, 'v2', { note: 'Target' });
    const other = await makeOrg(kit.fx, { name: 'Legacy workflow organization' });
    const initial = await approve(id, 'v1');
    const normal = await issue(initial, kit.org.id);
    // Older D1 passes can exist before release provenance was introduced.
    const template = await createTemplateRegistry(kit.env, { ctx: kit.ctx }).resolve(id, 'v1');
    const legacy = await makePass(kit.fx, { orgId: other.id, template });
    const target = await approve(id, 'v2');
    await kit.settle();
    const before = await Promise.all([effects(normal.id), effects(legacy.id)]);
    const runsBefore = await reservations(id);
    const workflowCount = kit.workflow.created.length;
    const response = await postReissue({ templateId: id });
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ code: 'TEMPLATE_RELEASE_CONFLICT' });
    expect(await reservations(id)).toEqual(runsBefore);
    expect(kit.workflow.created).toHaveLength(workflowCount);
    expect(await Promise.all([effects(normal.id), effects(legacy.id)])).toEqual(before);

    const otherTarget = await approve(id, 'v2', other.id);
    const retry = await enqueue({ templateId: id });
    expect(await snapshots(retry.id)).toEqual(
      ordered([expectedSnapshot(target, kit.org.id), expectedSnapshot(otherTarget, other.id)]),
    );
  }, 120_000);

  it('rejects the whole unscoped reservation when an affected scope loses its effective release', async () => {
    const id = newTemplateId();
    await addVersion(id, 'v1', { note: 'Initial' });
    await addVersion(id, 'v2', { note: 'Target' });
    const other = await makeOrg(kit.fx, { name: 'Release-loss organization' });
    const initialA = await approve(id, 'v1');
    const initialB = await approve(id, 'v1', other.id);
    const a = await issue(initialA, kit.org.id);
    const b = await issue(initialB, other.id);
    const targetA = await approve(id, 'v2');
    const targetB = await approve(id, 'v2', other.id);
    await kit.settle();
    const before = await Promise.all([effects(a.id), effects(b.id)]);
    const runsBefore = await all(
      kit.env.DB,
      'SELECT instance_id FROM workflow_runs WHERE target_id = ? ORDER BY instance_id',
      [id],
    );
    const setsBefore = await all(
      kit.env.DB,
      `SELECT s.instance_id FROM workflow_release_snapshot_sets s
       JOIN workflow_runs w ON w.instance_id = s.instance_id WHERE w.target_id = ?`,
      [id],
    );
    const workflowCount = kit.workflow.created.length;

    const response = await atReservation(
      (db) => setStatus(db, id, 'archived', kit.clock.now()),
      () => postReissue({ templateId: id }),
    );
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ code: 'TEMPLATE_RELEASE_CONFLICT' });
    expect(
      await all(
        kit.env.DB,
        'SELECT instance_id FROM workflow_runs WHERE target_id = ? ORDER BY instance_id',
        [id],
      ),
    ).toEqual(runsBefore);
    expect(
      await all(
        kit.env.DB,
        `SELECT s.instance_id FROM workflow_release_snapshot_sets s
       JOIN workflow_runs w ON w.instance_id = s.instance_id WHERE w.target_id = ?`,
        [id],
      ),
    ).toEqual(setsBefore);
    expect(kit.workflow.created).toHaveLength(workflowCount);
    expect(await Promise.all([effects(a.id), effects(b.id)])).toEqual(before);

    await setStatus(kit.env.DB, id, 'active', kit.clock.now());
    const retry = await enqueue({ templateId: id });
    expect(await snapshots(retry.id)).toEqual(
      ordered([expectedSnapshot(targetA, kit.org.id), expectedSnapshot(targetB, other.id)]),
    );
    expect(await execute(retry)).toEqual({ changed: 2, unchanged: 0, failed: 0 });
  }, 120_000);

  it('does not reserve an unscoped upgrade after the real admin session is revoked at commit', async () => {
    const id = newTemplateId();
    await addVersion(id, 'v1', { note: 'Initial' });
    await addVersion(id, 'v2', { note: 'Target' });
    const initial = await approve(id, 'v1');
    const pass = await issue(initial, kit.org.id);
    const target = await approve(id, 'v2');
    await kit.settle();
    const before = await effects(pass.id);
    const user = await makeUser(kit.fx);
    const session = await makeSession(kit.fx, { userId: user.id, roles: ['admin', 'user'] });
    const sessionId = await hashSessionCookie(session.cookieValue);
    const runsBefore = await all(
      kit.env.DB,
      'SELECT instance_id FROM workflow_runs WHERE target_id = ? ORDER BY instance_id',
      [id],
    );
    const workflowCount = kit.workflow.created.length;
    const response = await atReservation(
      async (db) => {
        await run(db, 'UPDATE sessions SET revoked_at = ? WHERE id_hash = ?', [
          kit.clock.now(),
          sessionId,
        ]);
      },
      () => postReissue({ templateId: id }, 'live', session.headers),
    );
    expect(response.status).toBe(403);
    expect(
      await all(
        kit.env.DB,
        'SELECT instance_id FROM workflow_runs WHERE target_id = ? ORDER BY instance_id',
        [id],
      ),
    ).toEqual(runsBefore);
    expect(kit.workflow.created).toHaveLength(workflowCount);
    expect(await effects(pass.id)).toEqual(before);
    const retry = await enqueue({ templateId: id });
    expect(await snapshots(retry.id)).toEqual([expectedSnapshot(target, kit.org.id)]);
  }, 60_000);

  it('rolls back scoped reservation and the scheduler claim if the reviewed head changes at commit', async () => {
    const id = newTemplateId();
    await addVersion(id, 'v1', { note: 'Initial' });
    await addVersion(id, 'v2', { note: 'Target' });
    const initial = await approve(id, 'v1');
    const pass = await issue(initial, kit.org.id);
    await kit.settle();
    const before = await effects(pass.id);
    const claim = async () =>
      first<{ release_id: string }>(
        kit.env.DB,
        `SELECT release_id FROM template_release_reissues
       WHERE template_id = ? AND org_id = ? AND mode = 'live' AND provider = 'apple'`,
        [id, kit.org.id],
      );
    kit.clock.advance(STALE_QUIET_MS + 1);
    await reissueStaleTemplates(kit.ctx);
    expect(await claim()).toEqual({ release_id: initial.id });
    const runs = () =>
      all(
        kit.env.DB,
        'SELECT instance_id FROM workflow_runs WHERE target_id = ? ORDER BY instance_id',
        [id],
      );
    const snapshotRows = () =>
      all(
        kit.env.DB,
        `SELECT s.instance_id, s.release_id, s.generation FROM workflow_release_snapshots s
       JOIN workflow_runs w ON w.instance_id = s.instance_id WHERE w.target_id = ?`,
        [id],
      );
    const markerRows = () =>
      all(
        kit.env.DB,
        `SELECT s.instance_id FROM workflow_release_snapshot_sets s
       JOIN workflow_runs w ON w.instance_id = s.instance_id WHERE w.target_id = ?`,
        [id],
      );
    const runsBefore = await runs();
    const markersBefore = await markerRows();
    const snapshotsBefore = await snapshotRows();
    const workflowCount = kit.workflow.created.length;
    const target = await approve(id, 'v2');
    const firstReplacement: TemplateRelease[] = [];
    const response = await atReservation(
      async (db) => {
        firstReplacement.push(await approve(id, 'v2', kit.org.id, 'live', db));
      },
      () => postReissue({ templateId: id, orgId: kit.org.id }),
    );
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ code: 'TEMPLATE_RELEASE_CONFLICT' });
    expect(firstReplacement).toHaveLength(1);
    expect(firstReplacement[0]).toMatchObject({ version: 'v2', generation: target.generation + 1 });
    expect(await runs()).toEqual(runsBefore);
    expect(await snapshotRows()).toEqual(snapshotsBefore);
    expect(await markerRows()).toEqual(markersBefore);
    expect(kit.workflow.created).toHaveLength(workflowCount);
    expect(await claim()).toEqual({ release_id: initial.id });

    kit.clock.advance(STALE_QUIET_MS + 1);
    const secondReplacement: TemplateRelease[] = [];
    await atReservation(
      async (db) => {
        secondReplacement.push(await approve(id, 'v2', kit.org.id, 'live', db));
      },
      () => reissueStaleTemplates(kit.ctx),
    );
    expect(secondReplacement).toHaveLength(1);
    expect(secondReplacement[0]?.generation).toBe((firstReplacement[0]?.generation ?? 0) + 1);
    expect((await requireApprovedRelease(kit.ctx, id, kit.org.id, 'live', 'apple')).id).toBe(
      secondReplacement[0]?.id,
    );
    expect(await runs()).toEqual(runsBefore);
    expect(await snapshotRows()).toEqual(snapshotsBefore);
    expect(await markerRows()).toEqual(markersBefore);
    expect(kit.workflow.created).toHaveLength(workflowCount);
    expect(await claim()).toEqual({ release_id: initial.id });
    expect(await effects(pass.id)).toEqual(before);
  }, 120_000);

  it('does not rebuild display-only versions with equal build keys in a snapshotted workflow', async () => {
    const id = newTemplateId();
    await addVersion(id, 'v1', { note: 'Same wallet content', subtitle: 'Before' });
    await addVersion(id, 'v2', { note: 'Same wallet content', subtitle: 'After' });
    const keys = await all<{ build_key: string }>(
      kit.env.DB,
      'SELECT build_key FROM template_versions WHERE template_id = ? ORDER BY version',
      [id],
    );
    expect(keys).toHaveLength(2);
    expect(keys[0]?.build_key).toBe(keys[1]?.build_key);
    const initial = await approve(id, 'v1');
    const pass = await issue(initial, kit.org.id);
    const target = await approve(id, 'v2');
    const workflow = await enqueue({ templateId: id });
    expect(await snapshots(workflow.id)).toEqual([expectedSnapshot(target, kit.org.id)]);
    await kit.settle();
    const before = await effects(pass.id);
    expect(await execute(workflow)).toEqual({ changed: 0, unchanged: 0, failed: 0 });
    expect(await effects(pass.id)).toEqual(before);
    expect(await snapshots(workflow.id)).toEqual([expectedSnapshot(target, kit.org.id)]);
  }, 60_000);
});
