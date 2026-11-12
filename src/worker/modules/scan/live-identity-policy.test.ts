import { describe, expect, it } from 'vitest';
import { materializeTemplateAssets } from '../../../../test/helpers/index.ts';
import { run } from '../../platform/db.ts';
import { approveAppleRelease } from '../passes/apple-release-test-fixtures.ts';
import { putMemberPhoto } from '../passes/member-photo.ts';
import { ICON_PNG } from '../passes/pass-test-fixtures.ts';
import { makePng } from '../templates/package/fixtures.ts';
import { scannerActor, withRole } from './actor.ts';
import { knownPhotoUrl } from './member-photo.ts';
import { scanPhotoUrl } from './member-photo-url.ts';
import { getScanner } from './repo-device.ts';
import { candidateById } from './repo-lookup.ts';
import { hub, kit, publish, row, screen, template } from './scan-hub-test-fixtures.ts';
import { proofedScanActor } from './test-kit.ts';

const system = { type: 'system' as const, id: null };

describe('live identity template policy', () => {
  it('uses the actual active policy for identity and photo even across different build keys', async () => {
    const id = await kit.scanTemplate('Live current policy', {
      actions: [{ id: 'check_in', label: 'Check in', kind: 'check_in' }],
    });
    const pinned = await kit.registry.resolve(id);
    const source = await kit.scanner({ templateIds: [id] });
    const monitor = await screen('monitor', [source.id]);
    const pass = await kit.scanPass(id, { memberName: 'Active Policy Member' });
    const png = btoa(String.fromCharCode(...makePng(270, 270)));
    await putMemberPhoto(kit.ctx, system, pass.id, { png, includeInPass: false }, null);
    const prior = row(source.id, { passId: pass.id });
    await publish(prior);
    const before = (await hub().snapshot(monitor.attachment)).rows.find(
      (entry) => entry.id === prior.id,
    );
    expect(before).toMatchObject({ passId: pass.id, holder: 'Active Policy Member' });
    if (!before?.photoUrl) throw new Error('Missing pre-policy photo.');
    const oldPath = before.photoUrl.replace('/api/v1/scan', '');
    expect((await kit.get(monitor.headers, oldPath)).status).toBe(200);
    const manifest = structuredClone(pinned.manifest);
    manifest.inputs.properties!.memberName = { type: 'string', 'x-scan': 'hidden' };
    manifest.scan!.display = { v: 1, header: {}, photo: { minRole: 'desk' } };
    const active = kit.registry.add({
      id,
      orgId: pinned.orgId,
      version: 'incompatible-v2',
      manifest,
      passJson: pinned.passJson,
      assets: { 'icon.png': ICON_PNG },
    });
    const activeAssets = await materializeTemplateAssets(kit.fx, active, kit.registry);
    await run(
      kit.env.DB,
      `INSERT INTO template_versions
      (template_id, version, manifest, pass_json, assets, created_at, build_key)
      VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [
        id,
        active.version,
        JSON.stringify(manifest),
        JSON.stringify(active.passJson),
        JSON.stringify(activeAssets),
        kit.clock.now(),
        'different-build',
      ],
    );
    await approveAppleRelease(kit, { templateId: id, version: active.version });
    expect((await kit.get(monitor.headers, oldPath)).status).toBe(404);
    const stale = (await hub().snapshot(monitor.attachment)).rows.find(
      (entry) => entry.id === prior.id,
    );
    expect(stale).toMatchObject({ passId: null, holder: null, photoUrl: null });
    const candidate = await candidateById(kit.env.DB, kit.org.id, pass.id);
    const device = await getScanner(kit.env.DB, source.id);
    if (!candidate || !device) throw new Error('Missing policy fixture.');
    const actor = await proofedScanActor(
      kit.ctx,
      withRole(
        scannerActor(kit.ctx, device, 'live', 'cookie', { event: null, templateIds: [id] }),
        null,
      ),
    );
    expect(candidate.activeTemplateVersion).toBe(active.version);
    expect(candidate.displayTemplateVersion).not.toBe(active.version);
    expect(await knownPhotoUrl(kit.ctx, actor, candidate, pinned, active)).toBeNull();
    expect(await scanPhotoUrl(kit.ctx, actor, pass.id)).toBeNull();
    const event = row(source.id, { passId: pass.id, holder: 'Active Policy Member' });
    await publish(event);
    const projection = (await hub().snapshot(monitor.attachment)).rows.find(
      (entry) => entry.id === event.id,
    );
    // The pass stays on its own build and is shown as the card shows it: the head's policy hides
    // the name and the desk-only photo.
    expect(projection).toMatchObject({ passId: pass.id, holder: null, photoUrl: null });
    expect(JSON.stringify(projection)).not.toContain('Active Policy Member');
  });

  it('keeps a stricter pinned photo and identity policy after an active policy loosens', async () => {
    const base = await kit.registry.resolve(template);
    const id = kit.ctx.ids.id();
    const strict = structuredClone(base.manifest);
    strict.inputs.properties!.memberName = { type: 'string', 'x-scan': 'desk' };
    strict.scan!.display = { v: 1, header: {}, photo: { minRole: 'desk' } };
    const pinned = kit.registry.add({
      id,
      orgId: base.orgId,
      version: 'strict-v1',
      manifest: strict,
      passJson: base.passJson,
      assets: { 'icon.png': ICON_PNG },
    });
    await run(
      kit.env.DB,
      `INSERT INTO templates
      (id, org_id, slug, name, origin, active_version, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id,
        pinned.orgId,
        id,
        pinned.manifest.name,
        pinned.origin,
        pinned.version,
        kit.clock.now(),
        kit.clock.now(),
      ],
    );
    const pinnedAssets = await materializeTemplateAssets(kit.fx, pinned, kit.registry);
    await run(
      kit.env.DB,
      `INSERT INTO template_versions
      (template_id, version, manifest, pass_json, assets, created_at, build_key)
      VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [
        id,
        pinned.version,
        JSON.stringify(strict),
        JSON.stringify(pinned.passJson),
        JSON.stringify(pinnedAssets),
        kit.clock.now(),
        'same-policy-build',
      ],
    );
    await approveAppleRelease(kit, { templateId: id, version: pinned.version });
    const source = await kit.scanner({ templateIds: [id] });
    const monitor = await screen('monitor', [source.id]);
    const pass = await kit.scanPass(id, { memberName: 'Pinned Private Member' });
    const png = btoa(String.fromCharCode(...makePng(270, 270)));
    await putMemberPhoto(kit.ctx, system, pass.id, { png, includeInPass: false }, null);
    const active = kit.registry.add({
      id,
      orgId: base.orgId,
      version: 'loose-v2',
      manifest: base.manifest,
      passJson: base.passJson,
      assets: { 'icon.png': ICON_PNG },
    });
    const activeAssets = await materializeTemplateAssets(kit.fx, active, kit.registry);
    await run(
      kit.env.DB,
      `INSERT INTO template_versions
      (template_id, version, manifest, pass_json, assets, created_at, build_key)
      VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [
        id,
        active.version,
        JSON.stringify(active.manifest),
        JSON.stringify(active.passJson),
        JSON.stringify(activeAssets),
        kit.clock.now(),
        'same-policy-build',
      ],
    );
    await approveAppleRelease(kit, { templateId: id, version: active.version });
    const candidate = await candidateById(kit.env.DB, kit.org.id, pass.id);
    const device = await getScanner(kit.env.DB, source.id);
    if (!candidate || !device) throw new Error('Missing pinned policy fixture.');
    const actor = await proofedScanActor(
      kit.ctx,
      withRole(
        scannerActor(kit.ctx, device, 'live', 'cookie', { event: null, templateIds: [id] }),
        null,
      ),
    );
    expect(await knownPhotoUrl(kit.ctx, actor, candidate, pinned, active)).toBeNull();
    expect(await scanPhotoUrl(kit.ctx, actor, pass.id)).toBeNull();
    const event = row(source.id, { passId: pass.id });
    await publish(event);
    const projection = (await hub().snapshot(monitor.attachment)).rows.find(
      (entry) => entry.id === event.id,
    );
    expect(projection).toMatchObject({ passId: pass.id, holder: null, photoUrl: null });
    expect(JSON.stringify(projection)).not.toContain('Pinned Private Member');

    const deskSource = await kit.scanner({
      templateIds: [id],
      settings: { roleWithoutSignIn: 'desk' },
    });
    const deskMonitor = await screen('monitor', [deskSource.id], false, {
      roleWithoutSignIn: 'desk',
    });
    const deskEvent = row(deskSource.id, { passId: pass.id });
    await publish(deskEvent);
    const deskRow = (await hub().snapshot(deskMonitor.attachment)).rows.find(
      (entry) => entry.id === deskEvent.id,
    );
    expect(deskRow).toMatchObject({ passId: pass.id, holder: 'Pinned Private Member' });
    if (!deskRow?.photoUrl) throw new Error('Missing permitted pinned photo.');
    expect(
      (await kit.get(deskMonitor.headers, deskRow.photoUrl.replace('/api/v1/scan', ''))).status,
    ).toBe(200);
  });
});
