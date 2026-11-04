import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { makeOrg } from '../../../../test/helpers/index.ts';
import { all, first } from '../../platform/db.ts';
import { runBulkReissue } from '../../workflows/bulk-reissue.ts';
import { deleteBrandingImage, putBrandingImage } from '../orgs/branding.ts';
import { updateOrg } from '../orgs/service.ts';
import { makePng } from '../templates/package/fixtures.ts';
import { publishPass } from './publish.ts';
import { getPass } from './repo.ts';
import { BRANDING_QUIET_MS, reissueStaleBranding } from './stale-reissue.ts';
import { type Kit, setupKit } from './test-kit.ts';

let kit: Kit;
beforeAll(async () => {
  kit = await setupKit();
});

beforeEach(async () => {
  await kit.env.DB.prepare('UPDATE orgs SET branding_dirty_at = NULL').run();
});

const admin = { type: 'user', id: 'admin-1' } as const;
const b64 = (png: Uint8Array) => btoa(String.fromCharCode(...png));
const logo = () => ({ x3: b64(makePng(480, 150)) });
const icon = { x3: b64(makePng(114, 114)) };
const colors = {
  background: '#112233',
  foreground: '#ffffff',
  label: '#cccccc',
};
type Fn = () => Promise<unknown>;
const call = (a: unknown, b: unknown) => ((typeof a === 'function' ? a : b) as Fn)();
const step = {
  do: async (_name: string, a: unknown, b?: unknown) => call(a, b),
} as unknown as Parameters<typeof runBulkReissue>[3];

/** A fresh org with one live pass. */
async function orgWithPass() {
  const org = await makeOrg(kit.fx, { name: 'Brand Co' });
  const pass = await kit.pass({ orgId: org.id });
  await kit.settle();
  return { org, pass };
}

const dirtyAt = async (orgId: string) =>
  (
    await first<{ at: number | null }>(
      kit.env.DB,
      'SELECT branding_dirty_at AS at FROM orgs WHERE id = ?',
      [orgId],
    )
  )?.at ?? null;

const clean = (orgId: string) =>
  kit.env.DB.prepare('UPDATE orgs SET branding_dirty_at = NULL WHERE id = ?').bind(orgId).run();

describe('branding reissue trigger', () => {
  it('flags the org for each pass-affecting change', async () => {
    const { org } = await orgWithPass();
    const changes: [string, () => Promise<{ passesToUpdate?: number | undefined }>][] = [
      ['logo upload', () => putBrandingImage(kit.ctx, admin, org.id, 'logo', logo())],
      ['icon upload', () => putBrandingImage(kit.ctx, admin, org.id, 'icon', icon)],
      ['colours', () => updateOrg(kit.ctx, admin, org.id, { branding: { passColors: colors } })],
      [
        'logoHasName',
        () =>
          updateOrg(kit.ctx, admin, org.id, {
            branding: { passColors: colors, logoHasName: true },
          }),
      ],
      ['org name', () => updateOrg(kit.ctx, admin, org.id, { name: 'Brand Company' })],
      ['logo delete', () => deleteBrandingImage(kit.ctx, admin, org.id, 'logo')],
      ['icon delete', () => deleteBrandingImage(kit.ctx, admin, org.id, 'icon')],
    ];
    for (const [label, change] of changes) {
      await clean(org.id);
      const dto = await change();
      expect(dto.passesToUpdate, label).toBe(1);
      expect(await dirtyAt(org.id), label).not.toBeNull();
    }
  });

  it('ignores a save that leaves the pass look alone', async () => {
    const { org } = await orgWithPass();
    const dto = await updateOrg(kit.ctx, admin, org.id, {
      branding: { supportEmail: 'help@example.com', accent: '#ff0000' },
    });
    await updateOrg(kit.ctx, admin, org.id, { name: 'Brand Co' });
    expect(dto.passesToUpdate).toBeUndefined();
    expect(await dirtyAt(org.id)).toBeNull();
    kit.workflow.created.length = 0;
    kit.clock.set(kit.clock.now() + BRANDING_QUIET_MS * 2);
    await reissueStaleBranding(kit.ctx);
    expect(kit.workflow.created).toHaveLength(0);
  });

  it('does not flag an org with no live passes', async () => {
    const org = await makeOrg(kit.fx, { name: 'Empty Co' });
    const dto = await putBrandingImage(kit.ctx, admin, org.id, 'icon', icon);
    expect(dto.passesToUpdate).toBeUndefined();
    expect(await dirtyAt(org.id)).toBeNull();
  });
});

describe('branding reissue coalescing', () => {
  it('turns a run of saves into one reissue after the org goes quiet', async () => {
    const { org } = await orgWithPass();
    await clean(org.id);
    kit.workflow.created.length = 0;
    await putBrandingImage(kit.ctx, admin, org.id, 'logo', logo());
    kit.clock.set(kit.clock.now() + 30_000);
    await putBrandingImage(kit.ctx, admin, org.id, 'icon', icon);
    kit.clock.set(kit.clock.now() + 30_000);
    await updateOrg(kit.ctx, admin, org.id, { branding: { passColors: colors } });

    // 60 s after the first save, but only moments after the last.
    kit.clock.set(kit.clock.now() + 30_000);
    await reissueStaleBranding(kit.ctx);
    expect(kit.workflow.created).toHaveLength(0);

    kit.clock.set(kit.clock.now() + BRANDING_QUIET_MS);
    await reissueStaleBranding(kit.ctx);
    await reissueStaleBranding(kit.ctx);
    expect(kit.workflow.created).toHaveLength(1);
    expect(kit.workflow.created[0]?.params).toMatchObject({ orgId: org.id, cause: 'branding' });
    expect(await dirtyAt(org.id)).toBeNull();

    const audit = await first<{ target_type: string; target_id: string }>(
      kit.env.DB,
      "SELECT target_type, target_id FROM audit_log WHERE action = 'pass.bulk_reissue' AND org_id = ?",
      [org.id],
    );
    expect(audit).toEqual({ target_type: 'org', target_id: org.id });
  });

  it('keeps the mark when the workflow cannot start', async () => {
    const { org } = await orgWithPass();
    await putBrandingImage(kit.ctx, admin, org.id, 'icon', icon);
    const at = await dirtyAt(org.id);
    const create = kit.workflow.create;
    kit.workflow.create = async () => {
      throw new Error('down');
    };
    kit.clock.set(kit.clock.now() + BRANDING_QUIET_MS * 2);
    await reissueStaleBranding(kit.ctx);
    kit.workflow.create = create;
    expect(await dirtyAt(org.id)).toBe(at);
  });
});

describe('branding reissue run', () => {
  it('rebuilds live passes with the new logo and colour and pushes them; skips voided ones', async () => {
    const { org, pass } = await orgWithPass();
    const voided = await kit.pass({ orgId: org.id });
    await publishPass(kit.ctx, {
      passId: voided.id,
      cause: 'admin',
      actor: admin,
      mutate: () => ({ status: 'voided' }),
    });
    await kit.settle();
    kit.queue.sent.length = 0;
    kit.workflow.created.length = 0;
    await clean(org.id);

    await putBrandingImage(kit.ctx, admin, org.id, 'logo', logo());
    await updateOrg(kit.ctx, admin, org.id, { branding: { passColors: colors } });
    kit.clock.set(kit.clock.now() + BRANDING_QUIET_MS * 2);
    await reissueStaleBranding(kit.ctx);
    const started = kit.workflow.created[0];
    expect(started).toBeDefined();
    const before = await getPass(kit.env.DB, pass.id);
    const voidedBefore = await getPass(kit.env.DB, voided.id);

    const totals = await runBulkReissue(
      kit.env,
      started?.id ?? '',
      started?.params as Parameters<typeof runBulkReissue>[2],
      step,
    );
    await kit.settle();

    expect(totals).toEqual({ changed: 1, unchanged: 0, failed: 0 });
    const after = await getPass(kit.env.DB, pass.id);
    expect(after?.version).toBe((before?.version ?? 0) + 1);
    expect(after?.objectKey).not.toBe(before?.objectKey);
    const passJson = await first<{ pass_json: string }>(
      kit.env.DB,
      'SELECT pass_json FROM pass_versions WHERE pass_id = ? ORDER BY version DESC LIMIT 1',
      [pass.id],
    );
    expect(JSON.parse(passJson?.pass_json ?? '{}')).toMatchObject({
      backgroundColor: 'rgb(17, 34, 51)',
    });
    const bytes = await kit.env.BUCKET.get(after?.objectKey ?? '');
    expect(bytes).not.toBeNull();
    expect(
      await all(kit.env.DB, "SELECT 1 FROM outbox WHERE pass_id = ? AND kind = 'push'", [pass.id]),
    ).toHaveLength(1);

    const voidedAfter = await getPass(kit.env.DB, voided.id);
    expect(voidedAfter?.version).toBe(voidedBefore?.version);
  });
});
