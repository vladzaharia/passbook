// The shipped starters across the cutover: migration 0056 and the baked sync flag only platform-owned
// rows as blueprints; a starter the old Worker assigned to an org stays that org's template.
import { beforeAll, describe, expect, it } from 'vitest';
import { jobCtxOf } from '../../src/worker/modules/delivery/delivery-test-fixtures.ts';
import { createPassRow } from '../../src/worker/modules/passes/create.ts';
import { overrideDeps } from '../../src/worker/modules/passes/deps.ts';
import { withKitDatabase } from '../../src/worker/modules/passes/pass-test-fixtures.ts';
import { publishPass } from '../../src/worker/modules/passes/publish.ts';
import { reissueStaleTemplates } from '../../src/worker/modules/passes/stale-reissue.ts';
import { type ScanKit, setupScanKit } from '../../src/worker/modules/scan/test-kit.ts';
import { createTemplateRegistry } from '../../src/worker/modules/templates/registry.ts';
import { activeRelease } from '../../src/worker/modules/templates/releases.ts';
import { type Cutover, effective, runCutover } from './setup.ts';

let c: Cutover;
let kit: ScanKit;

beforeAll(async () => {
  c = await runCutover(31, { bumpStarters: true });
  kit = await withKitDatabase(c.legacy.db, () => setupScanKit());
  overrideDeps(kit.env, { registry: createTemplateRegistry(kit.env) });
}, 180_000);

const flag = async (id: string) =>
  (
    await c.legacy.db
      .prepare('SELECT blueprint FROM templates WHERE id = ?')
      .bind(id)
      .first<{ blueprint: number }>()
  )?.blueprint;
const pass1 = (shape: string) => c.legacy.passes.find((p) => p.id === `pass-${shape}-1`)!;

const issue = async (shape: 'baked-blueprint' | 'baked-starter-org') => {
  const templateId = c.legacy.templateIds[shape];
  const orgId = pass1(shape).orgId;
  const ctx = jobCtxOf(kit);
  const release = await activeRelease(ctx, templateId, orgId, 'live', 'apple');
  if (!release) throw new Error(`No release for ${templateId} in ${orgId}`);
  return createPassRow(ctx, {
    orgId,
    templateId,
    templateVersion: release.version,
    releaseId: release.id,
    releaseGeneration: release.generation,
    input: { name: 'Alex' },
    holderEmail: null,
    source: 'manual',
    mode: 'live',
    execution: { kind: 'system' },
    actor: { type: 'system', id: null },
  });
};

describe('cutover: the shipped starters', () => {
  it('flags the platform-owned starter a blueprint and leaves the org-assigned one a template', async () => {
    expect(await flag('baked:starter-generic')).toBe(1);
    expect(await flag('baked:starter-coupon')).toBe(0);
    // The unflagged fixtures stay templates.
    expect(await flag('baked:starter')).toBe(0);
  });

  it('refuses issuance from the blueprint only; the assigned starter issues', async () => {
    await expect(issue('baked-blueprint')).rejects.toMatchObject({
      code: 'TEMPLATE_IS_BLUEPRINT',
    });
    expect((await issue('baked-starter-org')).templateId).toBe('baked:starter-coupon');
  });

  it('keeps the existing passes of both serving', async () => {
    for (const shape of ['baked-blueprint', 'baked-starter-org'] as const)
      expect((await effective(c.legacy.db, pass1(shape).id))?.id, shape).toBeTruthy();
  });

  it('refreshes the existing passes of both: publish and the stale-reissue queue', async () => {
    const [genericVersion, couponVersion] = c.legacy.bumpedStarters ?? [];
    for (const [shape, version] of [
      ['baked-blueprint', genericVersion],
      ['baked-starter-org', couponVersion],
    ] as const) {
      const refreshed = await publishPass(jobCtxOf(kit), {
        passId: pass1(shape).id,
        actor: { type: 'system', id: null },
        cause: 'template_upgrade',
        force: true,
        mutate: () => ({ templateVersion: version! }),
      });
      expect(refreshed.pass.templateVersion, shape).toBe(version);
    }
    kit.clock.advance(5 * 60_000);
    await reissueStaleTemplates(jobCtxOf(kit));
    const queued = kit.workflow.created.map(
      (w) =>
        `${(w.params as { templateId: string }).templateId}:${(w.params as { orgId: string }).orgId}`,
    );
    expect(queued).toContain('baked:starter-generic:org-a');
    expect(queued).toContain('baked:starter-coupon:org-b');
  });
});
