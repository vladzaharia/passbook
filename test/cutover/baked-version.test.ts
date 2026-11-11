// The new build ships different baked content, so every pre-cutover baked pass is on an older version.
// Such a pass keeps working at its own version until the minute cron upgrades it.
import { beforeAll, describe, expect, it } from 'vitest';
import { jobCtxOf } from '../../src/worker/modules/delivery/delivery-test-fixtures.ts';
import { overrideDeps } from '../../src/worker/modules/passes/deps.ts';
import { withKitDatabase } from '../../src/worker/modules/passes/pass-test-fixtures.ts';
import { publishPass } from '../../src/worker/modules/passes/publish.ts';
import { reissueStaleTemplates } from '../../src/worker/modules/passes/stale-reissue.ts';
import { key, type ScanKit, setupScanKit } from '../../src/worker/modules/scan/test-kit.ts';
import { createTemplateRegistry } from '../../src/worker/modules/templates/registry.ts';
import { type Cutover, effective, runCutover } from './setup.ts';

let c: Cutover;
let kit: ScanKit;
const pass1 = () => c.legacy.passes.find((p) => p.id === 'pass-baked-unassigned-1')!;

beforeAll(async () => {
  c = await runCutover(28, { bumpStarter: true });
  kit = await withKitDatabase(c.legacy.db, () => setupScanKit());
  overrideDeps(kit.env, { registry: createTemplateRegistry(kit.env) });
}, 180_000);

const scan = async (code = pass1().barcode) => {
  const res = await kit.post(c.legacy.scanners['baked-unassigned']!.headers, '/actions', {
    idempotencyKey: key(),
    input: { code, method: 'camera' },
    clientTs: kit.clock.now(),
    actionId: 'enter',
  });
  return (await res.json()) as { kind: string; reason: string | null };
};

describe('cutover: baked content changed in the new build', () => {
  it('moves the platform head to the new version while the pass stays on the old one', async () => {
    const head = await c.legacy.db
      .prepare(
        `SELECT version FROM template_releases WHERE template_id = 'baked:starter' AND org_id IS NULL AND mode = 'live'
         ORDER BY generation DESC LIMIT 1`,
      )
      .first<{ version: string }>();
    expect(head?.version).toBe(c.legacy.bumpedVersion);
    expect(pass1().id).toBeTruthy();
    const row = await c.legacy.db
      .prepare('SELECT template_version FROM passes WHERE id = ?')
      .bind(pass1().id)
      .first<{ template_version: string }>();
    expect(row?.template_version).not.toBe(c.legacy.bumpedVersion);
    expect((await effective(c.legacy.db, pass1().id))?.id).toBeTruthy();
  });

  it('still scans and refreshes an old-version pass at its own version', async () => {
    expect(await scan()).toMatchObject({ kind: 'ok' });
    const refreshed = await publishPass(jobCtxOf(kit), {
      passId: pass1().id,
      actor: { type: 'system', id: null },
      cause: 'admin',
      force: true,
    });
    expect(refreshed.pass.templateVersion).not.toBe(c.legacy.bumpedVersion);
  });

  it('scans an old-version uploaded pass the same way', async () => {
    const res = await kit.post(c.legacy.scanners['uploaded-active']!.headers, '/actions', {
      idempotencyKey: key(),
      input: {
        code: c.legacy.passes.find((p) => p.id === 'pass-uploaded-active-1')!.barcode,
        method: 'camera',
      },
      clientTs: kit.clock.now(),
      actionId: 'enter',
    });
    expect(await res.json()).toMatchObject({ kind: 'ok' });
  });

  it('is queued for upgrade by the minute cron once the release is quiet', async () => {
    kit.clock.advance(5 * 60_000);
    await reissueStaleTemplates(jobCtxOf(kit));
    const queued = kit.workflow.created.map(
      (w) =>
        (w.params as { templateId: string; orgId: string }).templateId +
        ':' +
        (w.params as { orgId: string }).orgId,
    );
    expect(queued.sort()).toEqual([
      'baked:starter:org-a',
      'baked:starter:org-b',
      'up-active:org-a',
    ]);
  });

  it('serves the pass on the new version once upgraded', async () => {
    const upgraded = await publishPass(jobCtxOf(kit), {
      passId: pass1().id,
      actor: { type: 'system', id: null },
      cause: 'template_upgrade',
      force: true,
      mutate: () => ({ templateVersion: c.legacy.bumpedVersion! }),
    });
    expect(upgraded.pass.templateVersion).toBe(c.legacy.bumpedVersion);
    // The fixture template binds no barcode, so the rebuilt pass is found by its new scan code.
    expect(await scan(upgraded.pass.scanCode ?? '')).toMatchObject({ kind: 'ok' });
  });
});
