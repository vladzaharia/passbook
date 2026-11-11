import { describe, expect, it } from 'vitest';
import { persistTemplate } from '../../../../test/helpers/index.ts';
import type { PassJson } from '../../../passkit/types.ts';
import { run } from '../../platform/db.ts';
import { jobCtxOf } from '../delivery/delivery-test-fixtures.ts';
import { approveAppleRelease } from '../passes/apple-release-test-fixtures.ts';
import { putMemberPhoto } from '../passes/member-photo.ts';
import { ICON_PNG } from '../passes/pass-test-fixtures.ts';
import { updatePass } from '../passes/service.ts';
import { makePng } from '../templates/package/fixtures.ts';
import { liveRecipient } from './live-auth.ts';
import { openLiveSourceProof, sealLiveSourceProof } from './live-provenance.ts';
import { liveRowFor } from './live-render.ts';
import { canShowPhotoForCandidate, scannerCandidateAllowed } from './member-photo.ts';
import { candidateById } from './repo-lookup.ts';
import {
  hub,
  kit,
  photoFixture,
  proven,
  publish,
  row,
  screen,
  template,
} from './scan-hub-test-fixtures.ts';

const system = { type: 'system' as const, id: null };

describe('live identity authority', () => {
  it('never projects cached details when a proof is missing, swapped or bound to another row', async () => {
    const fixture = await photoFixture();
    const recipient = await liveRecipient(kit.ctx, fixture.monitor.attachment);
    const proof = await hub().sourceProof(fixture.event.id);
    if (!recipient || !proof) throw new Error('Missing proof fixture.');
    const another = await proven(row(fixture.source.id, { passId: fixture.pass.id }));
    const decoded = await openLiveSourceProof(kit.env, another.sourceProof);
    if (!decoded?.passSnapshot) throw new Error('Missing pass snapshot fixture.');
    const noOrgRevision = await sealLiveSourceProof(kit.env, {
      ...decoded,
      passSnapshot: { ...decoded.passSnapshot, orgRevision: null },
    });
    const noTemplateRevision = await sealLiveSourceProof(kit.env, {
      ...decoded,
      passSnapshot: { ...decoded.passSnapshot, templateRevision: null },
    });
    const missingRelease = await Promise.all(
      [
        'activeReleaseId',
        'activeReleaseGeneration',
        'activeReleaseVersion',
        'activeReleaseCandidateHash',
      ].map((field) =>
        sealLiveSourceProof(kit.env, {
          ...decoded,
          passSnapshot: { ...decoded.passSnapshot!, [field]: null },
        }),
      ),
    );
    const otherPass = await kit.scanPass(template);
    for (const entry of [
      { ...another, sourceProof: '' },
      { ...another, sourceProof: 'invalid' },
      { ...another, sourceProof: proof },
      { ...another, sourceProof: noOrgRevision },
      { ...another, sourceProof: noTemplateRevision },
      ...missingRelease.map((sourceProof) => ({ ...another, sourceProof })),
      { ...another, at: another.at + 1 },
      { ...another, passId: otherPass.id },
      { ...another, scannerId: fixture.monitor.id },
    ]) {
      const result = await liveRowFor(kit.ctx, recipient, entry);
      if (entry.scannerId === fixture.monitor.id) expect(result).toBeNull();
      else {
        expect(result).toMatchObject({ passId: null, holder: null, photoUrl: null });
        expect(JSON.stringify(result)).not.toContain('Private Member');
        expect(result).not.toHaveProperty('sourceProof');
      }
    }
  });

  it('reconstructs identity rather than replaying a cached title, and rejects pass ABA', async () => {
    const source = await kit.scanner({ templateIds: [template] });
    const monitor = await screen('monitor', [source.id]);
    const pass = await kit.scanPass(template, { memberName: 'Visible Member' });
    const event = row(source.id, { passId: pass.id, holder: 'STALE PRIVATE CACHED TITLE' });
    await publish(event);
    const initial = (await hub().snapshot(monitor.attachment)).rows.find(
      (entry) => entry.id === event.id,
    );
    expect(initial).toMatchObject({ passId: pass.id, holder: 'Visible Member', photoUrl: null });
    expect(JSON.stringify(initial)).not.toContain('STALE PRIVATE');
    await updatePass(
      jobCtxOf(kit),
      system,
      pass.id,
      { input: { memberName: 'Other Member' } },
      { scope: null },
    );
    await updatePass(
      jobCtxOf(kit),
      system,
      pass.id,
      { input: { memberName: 'Visible Member' } },
      { scope: null },
    );
    const stale = (await hub().snapshot(monitor.attachment)).rows.find(
      (entry) => entry.id === event.id,
    );
    expect(stale).toMatchObject({ passId: null, holder: null, photoUrl: null });
    expect(JSON.stringify(stale)).not.toContain('Visible Member');
  });

  it('intersects source and recipient identity roles and never trusts the stored holder', async () => {
    const base = await kit.registry.resolve(template);
    const manifest = structuredClone(base.manifest);
    manifest.inputs.properties!.memberName = { type: 'string', 'x-scan': 'desk' };
    const id = kit.ctx.ids.id();
    const pinned = kit.registry.add({
      id,
      orgId: base.orgId,
      version: 'v1',
      manifest,
      passJson: base.passJson,
      assets: { 'icon.png': ICON_PNG },
    });
    await persistTemplate(kit.fx, pinned, { registry: kit.registry });
    await approveAppleRelease(kit, { templateId: id, version: pinned.version });
    const source = await kit.scanner({
      templateIds: [id],
      settings: { roleWithoutSignIn: 'desk' },
    });
    const door = await screen('monitor', [source.id]);
    const desk = await screen('monitor', [source.id], false, { roleWithoutSignIn: 'desk' });
    const pass = await kit.scanPass(id, { memberName: 'Desk Member' });
    const event = row(source.id, { passId: pass.id, holder: 'SHOULD NOT LEAK' });
    await publish(event);
    const doorRow = (await hub().snapshot(door.attachment)).rows.find(
      (entry) => entry.id === event.id,
    );
    const deskRow = (await hub().snapshot(desk.attachment)).rows.find(
      (entry) => entry.id === event.id,
    );
    expect(doorRow).toMatchObject({ passId: pass.id, holder: null });
    expect(deskRow).toMatchObject({ passId: pass.id, holder: 'Desk Member' });
    expect(JSON.stringify([doorRow, deskRow])).not.toContain('SHOULD NOT LEAK');
    const lower = await kit.scanner({ templateIds: [id] });
    const watching = await screen('monitor', [lower.id], false, { roleWithoutSignIn: 'desk' });
    const other = row(lower.id, { passId: pass.id });
    await publish(other);
    const lowerRow = (await hub().snapshot(watching.attachment)).rows.find(
      (entry) => entry.id === other.id,
    );
    expect(lowerRow).toMatchObject({ passId: pass.id, holder: null });
  });

  it('distinguishes standalone monitors from unassigned session-backed monitors', async () => {
    const fixture = await photoFixture();
    const recipient = await liveRecipient(kit.ctx, fixture.monitor.attachment);
    const candidate = await candidateById(kit.env.DB, kit.org.id, fixture.pass.id);
    if (!recipient || !candidate?.passJsonSnapshot)
      throw new Error('Missing monitor scope fixture.');
    const passJson = JSON.parse(candidate.passJsonSnapshot) as PassJson;
    const standalone = {
      ...recipient.actor,
      event: null,
      templateIds: [],
      settings: { ...recipient.actor.settings, acceptAllTemplates: false },
    };
    expect(scannerCandidateAllowed(standalone, candidate, passJson, kit.clock.now())).toBe(true);
    expect(await canShowPhotoForCandidate(kit.ctx, standalone, candidate)).toBe(true);

    const unassigned = {
      ...standalone,
      scanningSession: {
        id: kit.ctx.ids.id(),
        status: 'active' as const,
        updatedAt: kit.clock.now(),
      },
    };
    expect(scannerCandidateAllowed(unassigned, candidate, passJson, kit.clock.now())).toBe(false);
    expect(await canShowPhotoForCandidate(kit.ctx, unassigned, candidate)).toBe(false);
    const proof = await hub().sourceProof(fixture.event.id);
    if (!proof) throw new Error('Missing monitor source proof.');
    const entry = { ...fixture.event, sourceProof: proof };
    const projection = await liveRowFor(kit.ctx, { ...recipient, actor: unassigned }, entry);
    expect(projection).toMatchObject({ passId: null, holder: null, photoUrl: null });
  });

  it('derives staffless monitor visibility from a real signed-in source without changing its authority', async () => {
    const base = await kit.registry.resolve(template);
    const manifest = structuredClone(base.manifest);
    manifest.inputs.properties!.memberName = { type: 'string', 'x-scan': 'desk' };
    manifest.scan!.display = { v: 1, header: {}, photo: { minRole: 'desk' } };
    const id = kit.ctx.ids.id();
    const restricted = kit.registry.add({
      id,
      orgId: base.orgId,
      version: 'staff-v1',
      manifest,
      passJson: base.passJson,
      assets: { 'icon.png': ICON_PNG },
    });
    await persistTemplate(kit.fx, restricted, { registry: kit.registry });
    await approveAppleRelease(kit, { templateId: id, version: restricted.version });
    const staff = await kit.staff('desk', 'Live desk');
    const source = await kit.scanner({
      templateIds: [id],
      settings: { staffSignIn: true },
      staffId: staff.id,
    });
    const monitor = await screen('monitor', [source.id], false, { staffSignIn: true });
    const recipient = await liveRecipient(kit.ctx, monitor.attachment);
    if (!recipient) throw new Error('Missing staffless monitor.');
    expect(recipient.actor.role).toBeNull();
    const pass = await kit.scanPass(id, { memberName: 'Desk Only Member' });
    const png = btoa(String.fromCharCode(...makePng(270, 270)));
    await putMemberPhoto(kit.ctx, system, pass.id, { png, includeInPass: false }, null);
    const event = row(source.id, { passId: pass.id });
    await publish(event);
    const sealed = await hub().sourceProof(event.id);
    if (!sealed) throw new Error('Missing staff source proof.');
    const proof = await openLiveSourceProof(kit.env, sealed);
    expect(proof?.actor.staff).toMatchObject({
      id: staff.id,
      name: staff.name,
      role: 'desk',
      updatedAt: kit.clock.now(),
    });
    const visible = (await hub().snapshot(monitor.attachment)).rows.find(
      (item) => item.id === event.id,
    );
    expect(visible).toMatchObject({ passId: pass.id, holder: 'Desk Only Member' });
    if (!visible?.photoUrl) throw new Error('Missing staffless monitor photo.');
    const path = visible.photoUrl.replace('/api/v1/scan', '');
    expect((await kit.get(monitor.headers, path)).status).toBe(200);
    expect(recipient.actor.role).toBeNull();
    expect((await liveRecipient(kit.ctx, monitor.attachment))?.actor.role).toBeNull();

    const door = await kit.scanner({ templateIds: [id] });
    const doorMonitor = await screen('monitor', [door.id], false, { staffSignIn: true });
    const doorEvent = row(door.id, { passId: pass.id });
    await publish(doorEvent);
    const denied = (await hub().snapshot(doorMonitor.attachment)).rows.find(
      (item) => item.id === doorEvent.id,
    );
    expect(denied).toMatchObject({ passId: pass.id, holder: null, photoUrl: null });

    await run(
      kit.env.DB,
      'UPDATE scan_staff SET disabled_at = ?, updated_at = updated_at + 1 WHERE id = ?',
      [kit.clock.now(), staff.id],
    );
    expect((await kit.get(monitor.headers, path)).status).toBe(404);
    const revoked = (await hub().snapshot(monitor.attachment)).rows.find(
      (item) => item.id === event.id,
    );
    expect(revoked).toMatchObject({ passId: null, holder: null, photoUrl: null });
    await run(
      kit.env.DB,
      'UPDATE scan_staff SET disabled_at = NULL, updated_at = updated_at + 1 WHERE id = ?',
      [staff.id],
    );
    expect((await kit.get(monitor.headers, path)).status).toBe(404);
    const stale = (await hub().snapshot(monitor.attachment)).rows.find(
      (item) => item.id === event.id,
    );
    expect(stale).toMatchObject({ passId: null, holder: null, photoUrl: null });
    const freshEvent = row(source.id, { passId: pass.id });
    await publish(freshEvent);
    const freshProof = await hub().sourceProof(freshEvent.id);
    if (!freshProof) throw new Error('Missing renewed staff source proof.');
    expect((await openLiveSourceProof(kit.env, freshProof))?.actor.staff).toMatchObject({
      id: staff.id,
      updatedAt: kit.clock.now() + 2,
    });
    const fresh = (await hub().snapshot(monitor.attachment)).rows.find(
      (item) => item.id === freshEvent.id,
    );
    expect(fresh).toMatchObject({ passId: pass.id, holder: 'Desk Only Member' });
    if (!fresh?.photoUrl) throw new Error('Missing fresh staff-authorized photo.');
    expect(
      (await kit.get(monitor.headers, fresh.photoUrl.replace('/api/v1/scan', ''))).status,
    ).toBe(200);
  });
});
