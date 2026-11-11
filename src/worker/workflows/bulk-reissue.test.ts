import { beforeAll, describe, expect, it } from 'vitest';
import { makeTemplate, persistTemplate } from '../../../test/helpers/index.ts';
import { createPassRow } from '../modules/passes/create.ts';
import { insertWorkflowRun } from '../modules/passes/repo.ts';
import { type Kit, setupKit, TINY_PNG } from '../modules/passes/test-kit.ts';
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
  kit.registry.add({
    id: resolved.id,
    version: 'v1',
    manifest: resolved.manifest,
    passJson: resolved.passJson,
    assets: { 'icon.png': TINY_PNG },
  });
  await persistTemplate(kit.fx, resolved);
  const v2 = kit.registry.add({
    id: resolved.id,
    version: 'v2',
    manifest: v2Manifest,
    passJson: { ...resolved.passJson, description: 'Updated description' },
    assets: { 'icon.png': TINY_PNG },
  });
  await persistTemplate(kit.fx, v2);
  return resolved.id;
}

async function pass(templateId: string, version: string, input: Record<string, string> = {}) {
  return createPassRow(kit.ctx, {
    orgId: kit.org.id,
    templateId,
    templateVersion: version,
    input: { memberName: 'Bulk', ...input },
    source: 'manual',
    mode: 'live',
    actor,
  });
}

async function start(templateId: string, version = 'v2') {
  const instanceId = `bulk-${kit.fx.ids.token(6)}`;
  await insertWorkflowRun(kit.env.DB, {
    instanceId,
    kind: 'bulk_reissue',
    orgId: null,
    targetId: templateId,
    now: kit.clock.now(),
  });
  const totals = await runBulkReissue(
    kit.env,
    instanceId,
    { templateId, version, orgId: null, cause: 'template_upgrade' },
    step,
  );
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
    const instanceId = `bulk-${kit.fx.ids.token(6)}`;
    await insertWorkflowRun(kit.env.DB, {
      instanceId,
      kind: 'bulk_reissue',
      orgId: null,
      targetId: templateId,
      now: kit.clock.now(),
    });
    const exploding = {
      do: async (name: string, a: unknown, b?: unknown) => {
        if (name === 'page-0') throw new Error('d1 down');
        return call(a, b);
      },
    } as unknown as Parameters<typeof runBulkReissue>[3];
    await expect(
      runBulkReissue(
        kit.env,
        instanceId,
        { templateId, version: 'v2', orgId: null, cause: 'template_upgrade' },
        exploding,
      ),
    ).rejects.toThrow('d1 down');
    const run = await first<{ status: string; error_code: string }>(
      kit.env.DB,
      'SELECT status, error_code FROM workflow_runs WHERE instance_id = ?',
      [instanceId],
    );
    expect(run).toEqual({ status: 'errored', error_code: 'BULK_REISSUE_FAILED' });
  });
});
