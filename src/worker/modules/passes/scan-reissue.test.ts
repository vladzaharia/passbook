import { beforeAll, describe, expect, it } from 'vitest';
import { materializeTemplateAssets, persistTemplate } from '../../../../test/helpers/index.ts';
import type { PassJson, TemplateManifest } from '../../../passkit/types.ts';
import { first, run } from '../../platform/db.ts';
import { runBulkReissue } from '../../workflows/bulk-reissue.ts';
import { jobCtxOf } from '../delivery/delivery-test-fixtures.ts';
import { candidateById } from '../scan/repo-lookup.ts';
import { foundOf } from '../scan/resolve.ts';
import { buildKey } from '../templates/package/hash.ts';
import { approveAppleRelease } from './apple-release-test-fixtures.ts';
import { createPassRow } from './create.ts';
import { type Kit, setupKit, TINY_PNG } from './pass-test-fixtures.ts';
import { getPass } from './repo-read-pass.ts';
import { reissueStalePasses, STALE_QUIET_MS } from './stale-reissue.ts';

let kit: Kit;
beforeAll(async () => {
  kit = await setupKit();
});

type Fn = () => Promise<unknown>;
const call = (a: unknown, b: unknown) => ((typeof a === 'function' ? a : b) as Fn)();
const step = {
  do: async (_name: string, a: unknown, b?: unknown) => call(a, b),
} as unknown as Parameters<typeof runBulkReissue>[3];

async function addVersion(id: string, version: string, manifest: TemplateManifest, keyed = false) {
  const resolved = kit.registry.add({
    id,
    version,
    orgId: kit.org.id,
    manifest,
    passJson: structuredClone(kit.template.passJson) as PassJson,
    assets: { 'icon.png': TINY_PNG },
  });
  if (keyed) {
    const now = kit.clock.now();
    await run(
      kit.env.DB,
      `INSERT OR IGNORE INTO templates
       (id, org_id, slug, name, origin, active_version, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'uploaded', ?, ?, ?)`,
      [id, kit.org.id, id, manifest.name, version, now, now],
    );
    const assets = await materializeTemplateAssets(kit.fx, resolved, kit.registry);
    const key = await buildKey({ manifest, passJson: resolved.passJson, assets });
    await run(
      kit.env.DB,
      `INSERT INTO template_versions
       (template_id, version, manifest, pass_json, assets, build_key, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [
        id,
        version,
        JSON.stringify(manifest),
        JSON.stringify(resolved.passJson),
        JSON.stringify(assets),
        key,
        now,
      ],
    );
  } else {
    await persistTemplate(kit.fx, resolved, { registry: kit.registry });
  }
  return resolved;
}

const pushEvents = async (passId: string) =>
  (
    await first<{ n: number }>(
      kit.env.DB,
      "SELECT COUNT(*) AS n FROM pass_events WHERE pass_id = ? AND kind = 'push.queued'",
      [passId],
    )
  )?.n;

describe('a scan edit', () => {
  it('stale-reissues a scan action edit as metadata only: no new pass, no push', async () => {
    const id = 'tpl-scan-edit';
    const v1 = kit.template.manifest;
    const firstVersion = await addVersion(id, 'v1', v1);
    const initialRelease = await approveAppleRelease(kit, {
      orgId: kit.org.id,
      mode: 'live',
      templateId: id,
      version: firstVersion.version,
    });
    const pass = await createPassRow(jobCtxOf(kit), {
      orgId: kit.org.id,
      templateId: id,
      templateVersion: initialRelease.version,
      releaseId: initialRelease.id,
      releaseGeneration: initialRelease.generation,
      input: { memberName: 'Alex Morgan' },
      holderEmail: null,
      source: 'manual',
      mode: 'live',
      execution: { kind: 'system' },
      actor: { type: 'system', id: null },
    });
    await kit.settle();
    const pushesBefore = await pushEvents(pass.id);
    const versionsBefore = await first(
      kit.env.DB,
      'SELECT COUNT(*) AS n FROM pass_versions WHERE pass_id = ?',
      [pass.id],
    );

    const secondVersion = await addVersion(id, 'v2', {
      ...v1,
      scan: { actions: [{ id: 'check_in', label: 'Let in', kind: 'check_in', repeat: 'daily' }] },
    });
    const nextRelease = await approveAppleRelease(kit, {
      orgId: kit.org.id,
      mode: 'live',
      templateId: id,
      version: secondVersion.version,
    });
    expect(
      await first(kit.env.DB, 'SELECT active_version FROM templates WHERE id = ?', [id]),
    ).toEqual({ active_version: 'v2' });
    kit.clock.set(kit.clock.now() + STALE_QUIET_MS + 1);
    await reissueStalePasses(kit.ctx);
    await reissueStalePasses(kit.ctx);
    const workflows = kit.workflow.created.filter(
      (w) =>
        w.params !== null &&
        typeof w.params === 'object' &&
        'templateId' in w.params &&
        w.params.templateId === id,
    );
    expect(workflows).toHaveLength(1);
    const workflow = workflows[0];
    if (!workflow) throw new Error('Missing scan reissue workflow.');
    expect(workflow.params).toMatchObject({
      orgId: kit.org.id,
      mode: 'live',
      templateId: id,
      version: nextRelease.version,
      releaseId: nextRelease.id,
      releaseGeneration: nextRelease.generation,
      workflowInstanceId: workflow.id,
    });
    expect(
      await first(
        kit.env.DB,
        `SELECT org_id, mode, template_id, release_id, generation, version
         FROM workflow_release_snapshots WHERE instance_id = ? AND org_id = ? AND mode = ? AND template_id = ?`,
        [workflow.id, kit.org.id, 'live', id],
      ),
    ).toEqual({
      org_id: kit.org.id,
      mode: 'live',
      template_id: id,
      release_id: nextRelease.id,
      generation: nextRelease.generation,
      version: nextRelease.version,
    });
    const result = await runBulkReissue(
      kit.env,
      workflow.id,
      workflow.params as Parameters<typeof runBulkReissue>[2],
      step,
    );
    await kit.settle();
    expect(result).toEqual({ changed: 0, unchanged: 1, failed: 0 });
    const after = await getPass(kit.env.DB, pass.id);
    expect(after?.templateVersion).toBe('v2');
    expect(after?.releaseId).toBe(nextRelease.id);
    expect(after?.scanCode).toBe(pass.scanCode);
    expect(after?.objectKey).toBe(pass.objectKey);
    expect(
      await first(kit.env.DB, 'SELECT COUNT(*) AS n FROM pass_versions WHERE pass_id = ?', [
        pass.id,
      ]),
    ).toEqual(versionsBefore);
    expect(await pushEvents(pass.id)).toBe(pushesBefore);
  });

  it('serves an approved display-only edit without upgrading or rebuilding the pass', async () => {
    const id = 'tpl-scan-display-edit';
    const action = { id: 'check_in', label: 'Let in', kind: 'check_in', repeat: 'daily' } as const;
    const v1: TemplateManifest = {
      ...kit.template.manifest,
      scan: { actions: [action], display: { v: 1, header: { subtitle: 'Before' } } },
    };
    const v2: TemplateManifest = {
      ...v1,
      scan: { actions: [action], display: { v: 1, header: { subtitle: 'After' } } },
    };
    await addVersion(id, 'v1', v1, true);
    const initialRelease = await approveAppleRelease(kit, {
      orgId: kit.org.id,
      mode: 'live',
      templateId: id,
      version: 'v1',
    });
    const pass = await createPassRow(jobCtxOf(kit), {
      orgId: kit.org.id,
      templateId: id,
      templateVersion: initialRelease.version,
      releaseId: initialRelease.id,
      releaseGeneration: initialRelease.generation,
      input: { memberName: 'Alex Morgan' },
      holderEmail: null,
      source: 'manual',
      mode: 'live',
      execution: { kind: 'system' },
      actor: { type: 'system', id: null },
    });
    await kit.settle();
    const pushesBefore = await pushEvents(pass.id);
    const versionsBefore = await first(
      kit.env.DB,
      'SELECT COUNT(*) AS n FROM pass_versions WHERE pass_id = ?',
      [pass.id],
    );
    const objectsBefore = (await kit.env.BUCKET.list({ prefix: `passes/${pass.id}/` })).objects
      .map((object) => object.key)
      .sort();
    const initialCandidate = await candidateById(kit.env.DB, kit.org.id, pass.id);
    if (!initialCandidate) throw new Error('Missing issued pass for scanner lookup.');
    const initiallyFound = await foundOf(kit.ctx, initialCandidate);
    expect(initiallyFound?.activeVersion).toBe(initialRelease.version);
    expect(initiallyFound?.scan.display?.header.subtitle).toBe('Before');

    await addVersion(id, 'v2', v2, true);
    const nextRelease = await approveAppleRelease(kit, {
      orgId: kit.org.id,
      mode: 'live',
      templateId: id,
      version: 'v2',
    });
    const firstKey = await first<{ build_key: string }>(
      kit.env.DB,
      'SELECT build_key FROM template_versions WHERE template_id = ? AND version = ?',
      [id, 'v1'],
    );
    const secondKey = await first<{ build_key: string }>(
      kit.env.DB,
      'SELECT build_key FROM template_versions WHERE template_id = ? AND version = ?',
      [id, 'v2'],
    );
    expect(firstKey?.build_key).toMatch(/^[a-f0-9]{64}$/);
    expect(secondKey).toEqual(firstKey);
    expect(
      await first(kit.env.DB, 'SELECT active_version FROM templates WHERE id = ?', [id]),
    ).toEqual({ active_version: 'v2' });

    kit.clock.set(kit.clock.now() + STALE_QUIET_MS + 1);
    await reissueStalePasses(kit.ctx);
    await reissueStalePasses(kit.ctx);
    await kit.settle();
    expect(
      kit.workflow.created.filter(
        (w) =>
          w.params !== null &&
          typeof w.params === 'object' &&
          'templateId' in w.params &&
          w.params.templateId === id,
      ),
    ).toHaveLength(0);
    expect(await getPass(kit.env.DB, pass.id)).toMatchObject({
      templateVersion: initialRelease.version,
      releaseId: initialRelease.id,
      version: pass.version,
      objectKey: pass.objectKey,
      scanCode: pass.scanCode,
    });
    expect(
      await first(kit.env.DB, 'SELECT COUNT(*) AS n FROM pass_versions WHERE pass_id = ?', [
        pass.id,
      ]),
    ).toEqual(versionsBefore);
    expect(
      (await kit.env.BUCKET.list({ prefix: `passes/${pass.id}/` })).objects
        .map((object) => object.key)
        .sort(),
    ).toEqual(objectsBefore);
    expect(await pushEvents(pass.id)).toBe(pushesBefore);

    const candidate = await candidateById(kit.env.DB, kit.org.id, pass.id);
    if (!candidate) throw new Error('Missing issued pass for scanner lookup.');
    const found = await foundOf(kit.ctx, candidate);
    expect(found?.template.version).toBe(initialRelease.version);
    expect(found?.activeVersion).toBe(nextRelease.version);
    expect(found?.activeTemplate.version).toBe(nextRelease.version);
    expect(found?.scan.display?.header.subtitle).toBe('After');
  });
});
