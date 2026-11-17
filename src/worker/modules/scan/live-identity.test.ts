import { describe, expect, it } from 'vitest';
import { expectProblem } from '../../../../test/helpers/denial.ts';
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
import { photoPolicyAllowed, scannerCandidateAllowed } from './member-photo.ts';
import { candidateById } from './repo-lookup.ts';
import {
  hub,
  kit,
  photoFixture,
  publish,
  row,
  screen,
  template,
} from './scan-hub-test-fixtures.ts';

const system = { type: 'system' as const, id: null };

describe('live identity authority', () => {
  it('evaluates the holder at publish rather than replaying a cached title', async () => {
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
    // Content is not authority (F8): the row still shows what the source screen showed.
    const after = (await hub().snapshot(monitor.attachment)).rows.find(
      (entry) => entry.id === event.id,
    );
    expect(after).toMatchObject({ passId: pass.id, holder: 'Visible Member' });
    expect(JSON.stringify(after)).not.toContain('STALE PRIVATE');
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
    expect(await photoPolicyAllowed(kit.ctx, standalone, candidate)).toBe(true);

    const unassigned = {
      ...standalone,
      scanningSession: {
        id: kit.ctx.ids.id(),
        status: 'active' as const,
        updatedAt: kit.clock.now(),
      },
    };
    expect(scannerCandidateAllowed(unassigned, candidate, passJson, kit.clock.now())).toBe(false);
    expect(await photoPolicyAllowed(kit.ctx, unassigned, candidate)).toBe(false);
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
    expect(await hub().ringRow(event.id)).toMatchObject({ sourceRole: 'desk' });
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

    // The source is not re-checked, except for the role a staffless monitor borrows from it: once
    // that staff member is disabled the borrowed rights end (the row stays, without name or photo).
    await run(
      kit.env.DB,
      'UPDATE scan_staff SET disabled_at = ?, updated_at = updated_at + 1 WHERE id = ?',
      [kit.clock.now(), staff.id],
    );
    await expectProblem(await kit.get(monitor.headers, path), 404, 'ASSET_NOT_FOUND');
    expect(
      (await hub().snapshot(monitor.attachment)).rows.find((item) => item.id === event.id),
    ).toMatchObject({ passId: pass.id, holder: null, photoUrl: null });
  });
});
