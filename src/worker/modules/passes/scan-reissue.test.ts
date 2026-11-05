import { beforeAll, describe, expect, it } from 'vitest';
import { persistTemplate } from '../../../../test/helpers/index.ts';
import type { PassJson, TemplateManifest } from '../../../passkit/types.ts';
import { first } from '../../platform/db.ts';
import { runBulkReissue } from '../../workflows/bulk-reissue.ts';
import { createPassRow } from './create.ts';
import { getPass } from './repo.ts';
import { reissueStalePasses, STALE_QUIET_MS } from './stale-reissue.ts';
import { type Kit, setupKit, TINY_PNG } from './test-kit.ts';

let kit: Kit;
beforeAll(async () => {
  kit = await setupKit();
});

type Fn = () => Promise<unknown>;
const call = (a: unknown, b: unknown) => ((typeof a === 'function' ? a : b) as Fn)();
const step = {
  do: async (_name: string, a: unknown, b?: unknown) => call(a, b),
} as unknown as Parameters<typeof runBulkReissue>[3];

async function addVersion(id: string, version: string, manifest: TemplateManifest) {
  const resolved = kit.registry.add({
    id,
    version,
    orgId: null,
    manifest,
    passJson: structuredClone(kit.template.passJson) as PassJson,
    assets: { 'icon.png': TINY_PNG },
  });
  await persistTemplate(kit.fx, resolved);
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
  it('stale-reissues passes as metadata only: no new pass, no push', async () => {
    const id = 'tpl-scan-edit';
    const v1 = kit.template.manifest;
    await addVersion(id, 'v1', v1);
    await kit.env.DB.prepare('UPDATE templates SET active_version = ? WHERE id = ?')
      .bind('v1', id)
      .run();
    const pass = await createPassRow(kit.ctx, {
      orgId: kit.org.id,
      templateId: id,
      input: { memberName: 'Alex Morgan' },
      holderEmail: null,
      source: 'manual',
      actor: { type: 'system', id: null },
    });
    await kit.settle();
    const pushesBefore = await pushEvents(pass.id);

    await addVersion(id, 'v2', {
      ...v1,
      scan: { actions: [{ id: 'check_in', label: 'Let in', kind: 'check_in', repeat: 'daily' }] },
    });
    await kit.env.DB.prepare('UPDATE templates SET active_version = ?, updated_at = ? WHERE id = ?')
      .bind('v2', kit.clock.now(), id)
      .run();
    kit.clock.set(kit.clock.now() + STALE_QUIET_MS + 1);
    await reissueStalePasses(kit.ctx);
    await reissueStalePasses(kit.ctx);
    const [workflow] = kit.workflow.created.filter(
      (w) => (w.params as { templateId?: string }).templateId === id,
    );
    expect(workflow?.params).toMatchObject({ version: 'v2' });
    const result = await runBulkReissue(
      kit.env,
      workflow?.id ?? '',
      workflow?.params as Parameters<typeof runBulkReissue>[2],
      step,
    );
    await kit.settle();
    expect(result).toEqual({ changed: 0, unchanged: 1, failed: 0 });
    const after = await getPass(kit.env.DB, pass.id);
    expect(after?.templateVersion).toBe('v2');
    expect(after?.objectKey).toBe(pass.objectKey);
    expect(await pushEvents(pass.id)).toBe(pushesBefore);
  });
});
