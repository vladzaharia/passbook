import { beforeAll, describe, expect, it } from 'vitest';
import { makeTemplate, persistTemplate } from '../../../test/helpers/index.ts';
import { jobCtxOf } from '../modules/delivery/delivery-test-fixtures.ts';
import { approveAppleRelease } from '../modules/passes/apple-release-test-fixtures.ts';
import { createPassRow } from '../modules/passes/create.ts';
import { type Kit, setupKit, TINY_PNG } from '../modules/passes/pass-test-fixtures.ts';
import { passesForReissue } from '../modules/passes/repo.ts';
import { reserveWorkflowReleases } from '../modules/passes/repo-workflow-releases.ts';
import { activeRelease, requireApprovedRelease } from '../modules/templates/releases.ts';
import { all, first } from '../platform/db.ts';
import { runBulkReissue } from './bulk-reissue.ts';

let kit: Kit;
beforeAll(async () => {
  kit = await setupKit();
});

type Fn = () => Promise<unknown>;
const call = (a: unknown, b: unknown) => ((typeof a === 'function' ? a : b) as Fn)();
const step = {
  do: async (_name: string, a: unknown, b?: unknown) => call(a, b),
} as unknown as Parameters<typeof runBulkReissue>[3];

const actor = { type: 'system', id: null } as const;

/** A fresh template id so counts are exact, with a v2 whose pass.json differs. */
async function twoVersions(options: { requireTier?: boolean } = {}) {
  const { resolved } = makeTemplate({ id: `tpl-bulk-${kit.fx.ids.token(4)}` });
  const v2Manifest = options.requireTier
    ? {
        ...resolved.manifest,
        inputs: {
          ...resolved.manifest.inputs,
          required: ['memberName', 'tier'],
          properties: { ...resolved.manifest.inputs.properties, tier: { type: 'string' } },
        },
      }
    : resolved.manifest;
  const v1 = kit.registry.add({
    id: resolved.id,
    version: 'v1',
    manifest: resolved.manifest,
    passJson: resolved.passJson,
    assets: { 'icon.png': TINY_PNG },
  });
  await persistTemplate(kit.fx, v1, { registry: kit.registry });
  const v2 = kit.registry.add({
    id: resolved.id,
    version: 'v2',
    manifest: v2Manifest,
    passJson: { ...resolved.passJson, description: 'Updated description' },
    assets: { 'icon.png': TINY_PNG },
  });
  await persistTemplate(kit.fx, v2, { registry: kit.registry });
  await approveAppleRelease(kit, { templateId: resolved.id, version: 'v1' });
  return resolved.id;
}

async function pass(templateId: string, version: string, input: Record<string, string> = {}) {
  const release = await requireApprovedRelease(kit.ctx, templateId, kit.org.id, 'live', 'apple');
  if (release.version !== version)
    throw new Error('Pass fixture release does not match the requested version');
  return createPassRow(jobCtxOf(kit), {
    orgId: kit.org.id,
    templateId,
    templateVersion: version,
    releaseId: release.id,
    releaseGeneration: release.generation,
    input: { memberName: 'Bulk', ...input },
    source: 'manual',
    mode: 'live',
    execution: { kind: 'system' },
    actor,
  });
}

async function prepare(templateId: string, version = 'v2') {
  let release = await activeRelease(kit.ctx, templateId, kit.org.id, 'live', 'apple');
  if (!release || release.version !== version)
    release = await approveAppleRelease(kit, { templateId, version });
  const instanceId = `bulk-${kit.fx.ids.token(6)}`;
  const reservation = await reserveWorkflowReleases(kit.env.DB, {
    instanceId,
    orgId: kit.org.id,
    mode: 'live',
    templateId,
    targetId: templateId,
    identityId: null,
    version,
    now: kit.clock.now(),
    expectedRelease: { id: release.id, generation: release.generation, version: release.version },
  });
  if (reservation !== 'inserted') throw new Error(`Could not reserve release: ${reservation}`);
  return {
    instanceId,
    params: {
      templateId,
      version,
      orgId: kit.org.id,
      mode: 'live' as const,
      cause: 'template_upgrade' as const,
      workflowInstanceId: instanceId,
      releaseId: release.id,
      releaseGeneration: release.generation,
    },
  };
}

async function start(templateId: string, version = 'v2') {
  const { instanceId, params } = await prepare(templateId, version);
  const totals = await runBulkReissue(kit.env, instanceId, params, step);
  const run = await first<{
    status: string;
    error_code: string | null;
    finished_at: number | null;
  }>(
    kit.env.DB,
    'SELECT status, error_code, finished_at FROM workflow_runs WHERE instance_id = ?',
    [instanceId],
  );
  return { totals, run };
}

describe('BulkReissue', () => {
  it('skips equivalent build keys but selects legacy and different versions', async () => {
    const templateId = await twoVersions();
    for (const [version, key] of [
      ['v3', 'same'],
      ['v4', 'same'],
      ['v5', 'different'],
    ]) {
      await kit.env.DB.prepare(
        `INSERT INTO template_versions
           (template_id, version, manifest, pass_json, assets, report, created_by, created_at, build_key)
         SELECT template_id, ?, manifest, pass_json, assets, report, created_by, created_at, ?
         FROM template_versions WHERE template_id = ? AND version = 'v1'`,
      )
        .bind(version, key, templateId)
        .run();
    }
    const legacy = await pass(templateId, 'v1');
    const otherLegacy = await pass(templateId, 'v1');
    const equivalent = await pass(templateId, 'v1');
    const different = await pass(templateId, 'v1');
    const exact = await pass(templateId, 'v1');
    for (const [id, version] of [
      [otherLegacy.id, 'v2'],
      [equivalent.id, 'v4'],
      [different.id, 'v5'],
      [exact.id, 'v3'],
    ]) {
      await kit.env.DB.prepare('UPDATE passes SET template_version = ? WHERE id = ?')
        .bind(version, id)
        .run();
    }
    const query = {
      templateId,
      orgId: kit.org.id,
      afterId: null,
      limit: 100,
      skipVersion: 'v3',
      activeOnly: true,
    };
    const selected = async (skipVersion: string | null) =>
      (await passesForReissue(kit.env.DB, { ...query, skipVersion })).map((row) => row.id).sort();
    expect(await selected('v3')).toEqual([legacy.id, otherLegacy.id, different.id].sort());
    expect(await selected('v1')).toEqual(
      [otherLegacy.id, equivalent.id, different.id, exact.id].sort(),
    );
    expect(await selected(null)).toEqual(
      [legacy.id, otherLegacy.id, equivalent.id, different.id, exact.id].sort(),
    );
    expect(await passesForReissue(kit.env.DB, { ...query, orgId: 'another-org' })).toEqual([]);
  });

  it('moves every pass to the new version with one coalesced push each', async () => {
    const templateId = await twoVersions();
    const passes = [
      await pass(templateId, 'v1'),
      await pass(templateId, 'v1'),
      await pass(templateId, 'v1'),
    ];
    await kit.settle();
    kit.queue.sent.length = 0;

    const { totals, run } = await start(templateId);
    await kit.settle();

    expect(totals).toEqual({ changed: 3, unchanged: 0, failed: 0 });
    expect(run).toMatchObject({ status: 'complete', error_code: null });
    expect(run?.finished_at).not.toBeNull();
    for (const p of passes) {
      const row = await first<{ template_version: string; version: number }>(
        kit.env.DB,
        'SELECT template_version, version FROM passes WHERE id = ?',
        [p.id],
      );
      expect(row).toEqual({ template_version: 'v2', version: 2 });
      const causes = await all<{ cause: string }>(
        kit.env.DB,
        'SELECT cause FROM pass_versions WHERE pass_id = ? ORDER BY version',
        [p.id],
      );
      expect(causes.map((c) => c.cause)).toEqual(['create', 'template_upgrade']);
      const pushes = await all(
        kit.env.DB,
        "SELECT 1 FROM outbox WHERE pass_id = ? AND kind = 'push'",
        [p.id],
      );
      expect(pushes).toHaveLength(1);
    }
    const pushMessages = kit.queue.sent.filter(
      (m) => (m as { kind: string }).kind === 'push.deliver',
    );
    expect(pushMessages).toHaveLength(3);
  });

  it('is a no-op the second time', async () => {
    const templateId = await twoVersions();
    await pass(templateId, 'v1');
    await start(templateId);
    const again = await start(templateId);
    expect(again.totals).toEqual({ changed: 0, unchanged: 0, failed: 0 });
    expect(again.run?.status).toBe('complete');
  });

  it('skips passes whose input no longer fits and reports a partial failure', async () => {
    const templateId = await twoVersions({ requireTier: true });
    const ok = await pass(templateId, 'v1', { tier: 'gold' });
    const bad = await pass(templateId, 'v1');
    const { totals, run } = await start(templateId);
    expect(totals).toEqual({ changed: 1, unchanged: 0, failed: 1 });
    expect(run).toMatchObject({ status: 'complete', error_code: 'PARTIAL_FAILURE' });
    const versions = async (id: string) =>
      (
        await first<{ template_version: string }>(
          kit.env.DB,
          'SELECT template_version FROM passes WHERE id = ?',
          [id],
        )
      )?.template_version;
    expect(await versions(ok.id)).toBe('v2');
    expect(await versions(bad.id)).toBe('v1');
    const syncError = await first<{ sync_error_code: string | null }>(
      kit.env.DB,
      'SELECT sync_error_code FROM passes WHERE id = ?',
      [bad.id],
    );
    expect(syncError?.sync_error_code).toBeNull();
  });

  it('pages through more than one chunk', async () => {
    const templateId = await twoVersions();
    for (let i = 0; i < 105; i += 15)
      await Promise.all(Array.from({ length: 15 }, () => pass(templateId, 'v1')));
    const { totals } = await start(templateId);
    expect(totals.changed).toBe(105);
    const left = await first<{ n: number }>(
      kit.env.DB,
      "SELECT count(*) AS n FROM passes WHERE template_id = ? AND template_version != 'v2'",
      [templateId],
    );
    expect(left?.n).toBe(0);
  }, 60_000);

  it('marks the run errored when the workflow itself fails', async () => {
    const templateId = await twoVersions();
    await pass(templateId, 'v1');
    const { instanceId, params } = await prepare(templateId);
    const exploding = {
      do: async (name: string, a: unknown, b?: unknown) => {
        if (name === 'page-0') throw new Error('d1 down');
        return call(a, b);
      },
    } as unknown as Parameters<typeof runBulkReissue>[3];
    await expect(runBulkReissue(kit.env, instanceId, params, exploding)).rejects.toThrow('d1 down');
    const run = await first<{ status: string; error_code: string }>(
      kit.env.DB,
      'SELECT status, error_code FROM workflow_runs WHERE instance_id = ?',
      [instanceId],
    );
    expect(run).toEqual({ status: 'errored', error_code: 'BULK_REISSUE_FAILED' });
  });
});
