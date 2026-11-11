import { describe, expect, it } from 'vitest';
import { persistTemplate } from '../../../../test/helpers/index.ts';
import { run } from '../../platform/db.ts';
import { getConnection } from '../connections/repo.ts';
import { create as createConnection, update as updateConnection } from '../connections/service.ts';
import { jobCtxOf } from '../delivery/delivery-test-fixtures.ts';
import { approveAppleRelease } from '../passes/apple-release-test-fixtures.ts';
import { putMemberPhoto } from '../passes/member-photo.ts';
import { ICON_PNG } from '../passes/pass-test-fixtures.ts';
import { getPass } from '../passes/repo-read-pass.ts';
import { setBinding } from '../passes/repo-write.ts';
import { updatePass } from '../passes/service.ts';
import { makePng } from '../templates/package/fixtures.ts';
import { rollbackRelease } from '../templates/releases.ts';
import { openLiveSourceProof } from './live-provenance.ts';
import { candidateById } from './repo-lookup.ts';
import {
  beginCredentialTransfer,
  hub,
  kit,
  photoFixture,
  publish,
  row,
  screen,
  template,
} from './scan-hub-test-fixtures.ts';

const system = { type: 'system' as const, id: null };

describe('live connection lineage', () => {
  it('does not revive a retained grant across same-clock credential transfer generations', async () => {
    const fixture = await photoFixture();
    const before = await candidateById(kit.env.DB, kit.org.id, fixture.pass.id);
    const sealed = await hub().sourceProof(fixture.event.id);
    if (!before || !sealed) throw new Error('Missing original credential lineage.');
    expect((await openLiveSourceProof(kit.env, sealed))?.passSnapshot?.credentialGeneration).toBe(
      before.pass.credentialGeneration,
    );
    expect((await kit.get(fixture.monitor.headers, fixture.path)).status).toBe(200);
    const now = kit.clock.now();
    const finishFirst = await beginCredentialTransfer(
      fixture.pass.id,
      'first-transfer@example.test',
    );
    try {
      expect((await kit.get(fixture.monitor.headers, fixture.path)).status).toBe(404);
    } finally {
      await finishFirst();
    }
    const first = await candidateById(kit.env.DB, kit.org.id, fixture.pass.id);
    if (!first) throw new Error('Missing first transferred pass.');
    expect(first.pass.credentialGeneration).toBe(before.pass.credentialGeneration + 1);
    expect((await kit.get(fixture.monitor.headers, fixture.path)).status).toBe(404);
    const finishSecond = await beginCredentialTransfer(
      fixture.pass.id,
      'second-transfer@example.test',
    );
    try {
      expect((await kit.get(fixture.monitor.headers, fixture.path)).status).toBe(404);
    } finally {
      await finishSecond();
    }
    const restored = await candidateById(kit.env.DB, kit.org.id, fixture.pass.id);
    if (!restored) throw new Error('Missing second transferred pass.');
    expect(kit.clock.now()).toBe(now);
    expect(restored.pass.credentialGeneration).toBe(first.pass.credentialGeneration + 1);
    expect((await kit.get(fixture.monitor.headers, fixture.path)).status).toBe(404);
    const stale = (await hub().snapshot(fixture.monitor.attachment)).rows.find(
      (entry) => entry.id === fixture.event.id,
    );
    expect(stale).toMatchObject({ passId: null, holder: null, photoUrl: null });
    const event = row(fixture.source.id, { passId: fixture.pass.id });
    await publish(event);
    const fresh = (await hub().snapshot(fixture.monitor.attachment)).rows.find(
      (entry) => entry.id === event.id,
    );
    if (!fresh?.photoUrl) throw new Error('Missing fresh credential-authorized photo.');
    expect(
      (await kit.get(fixture.monitor.headers, fresh.photoUrl.replace('/api/v1/scan', ''))).status,
    ).toBe(200);
  });

  it('does not revive a retained photo after same-version release supersession and rollback', async () => {
    const id = await kit.scanTemplate('Release lineage ABA', {
      actions: [{ id: 'check_in', label: 'Check in', kind: 'check_in' }],
    });
    const original = await approveAppleRelease(kit, { templateId: id });
    const source = await kit.scanner({ templateIds: [id] });
    const monitor = await screen('monitor', [source.id]);
    const pass = await kit.scanPass(id);
    const png = btoa(String.fromCharCode(...makePng(270, 270)));
    await putMemberPhoto(kit.ctx, system, pass.id, { png, includeInPass: false }, null);
    const event = row(source.id, { passId: pass.id });
    await publish(event);
    const projection = (await hub().snapshot(monitor.attachment)).rows.find(
      (item) => item.id === event.id,
    );
    if (!projection?.photoUrl) throw new Error('Missing original release photo.');
    const fixture = {
      source,
      monitor,
      pass,
      event,
      path: projection.photoUrl.replace('/api/v1/scan', ''),
    };
    const before = await candidateById(kit.env.DB, kit.org.id, fixture.pass.id);
    const sealed = await hub().sourceProof(fixture.event.id);
    if (!before || before.templateRevision === null || !sealed)
      throw new Error('Missing original release lineage.');
    expect(before.activeReleaseId).toBe(original.id);
    expect((await openLiveSourceProof(kit.env, sealed))?.passSnapshot).toMatchObject({
      activeReleaseId: original.id,
      activeReleaseGeneration: original.generation,
      activeReleaseVersion: original.version,
      activeReleaseCandidateHash: original.candidateHash,
      passReleaseId: before.pass.releaseId,
    });
    expect((await kit.get(fixture.monitor.headers, fixture.path)).status).toBe(200);
    const now = kit.clock.now();
    const newer = await approveAppleRelease(kit, { templateId: id, version: original.version });
    expect(newer.generation).toBeGreaterThan(original.generation);
    expect((await kit.get(fixture.monitor.headers, fixture.path)).status).toBe(404);
    const restored = await rollbackRelease(kit.ctx, newer.publisherAuth, id, {
      orgId: kit.org.id,
      mode: 'live',
      provider: 'apple',
      releaseId: original.id,
      candidateHash: original.candidateHash,
      expectedGeneration: newer.generation,
      reason: 'Restore the approved release for lineage testing.',
    });
    expect(kit.clock.now()).toBe(now);
    expect(restored.version).toBe(original.version);
    expect(restored.candidateHash).toBe(original.candidateHash);
    expect(restored.id).not.toBe(original.id);
    expect(restored.generation).toBeGreaterThan(newer.generation);
    // Isolate the immutable release fence even if a timestamp-based template revision repeats.
    await run(kit.env.DB, 'UPDATE templates SET updated_at = ? WHERE id = ?', [
      before.templateRevision,
      id,
    ]);
    const after = await candidateById(kit.env.DB, kit.org.id, fixture.pass.id);
    if (!after) throw new Error('Missing restored release lineage.');
    expect(after.templateRevision).toBe(before.templateRevision);
    expect(after.orgRevision).toBe(before.orgRevision);
    expect(after.activeTemplateVersion).toBe(before.activeTemplateVersion);
    expect(after.pass.version).toBe(before.pass.version);
    expect(after.pass.releaseId).toBe(before.pass.releaseId);
    expect(after.activeReleaseId).toBe(restored.id);
    expect(after.activeReleaseGeneration).toBe(restored.generation);
    expect((await kit.get(fixture.monitor.headers, fixture.path)).status).toBe(404);
    const stale = (await hub().snapshot(fixture.monitor.attachment)).rows.find(
      (entry) => entry.id === fixture.event.id,
    );
    expect(stale).toMatchObject({ passId: null, holder: null, photoUrl: null });
    const freshEvent = row(fixture.source.id, { passId: fixture.pass.id });
    await publish(freshEvent);
    const fresh = (await hub().snapshot(fixture.monitor.attachment)).rows.find(
      (entry) => entry.id === freshEvent.id,
    );
    if (!fresh?.photoUrl) throw new Error('Missing freshly evaluated release photo.');
    const freshPath = fresh.photoUrl.replace('/api/v1/scan', '');
    expect((await kit.get(fixture.monitor.headers, freshPath)).status).toBe(200);
    // Change only the binding first to exercise the proof's passReleaseId predicate independently.
    const alternateId = before.pass.releaseId === newer.id ? restored.id : newer.id;
    await run(kit.env.DB, 'UPDATE passes SET release_id = ? WHERE id = ?', [
      alternateId,
      fixture.pass.id,
    ]);
    expect((await kit.get(fixture.monitor.headers, freshPath)).status).toBe(404);
    const rebound = (await hub().snapshot(fixture.monitor.attachment)).rows.find(
      (entry) => entry.id === freshEvent.id,
    );
    expect(rebound).toMatchObject({ passId: null, holder: null, photoUrl: null });
    // Real pass publishing increments version on each binding change, preventing an ABA revival.
    await run(kit.env.DB, 'UPDATE passes SET release_id = ?, version = version + 2 WHERE id = ?', [
      before.pass.releaseId,
      fixture.pass.id,
    ]);
    expect(kit.clock.now()).toBe(now);
    expect((await kit.get(fixture.monitor.headers, freshPath)).status).toBe(404);
    const returned = (await hub().snapshot(fixture.monitor.attachment)).rows.find(
      (entry) => entry.id === freshEvent.id,
    );
    expect(returned).toMatchObject({ passId: null, holder: null, photoUrl: null });
  });

  it('keeps old events redacted when pass publications return to an earlier approved version', async () => {
    const id = await kit.scanTemplate('Pass release ABA', {
      actions: [{ id: 'check_in', label: 'Check in', kind: 'check_in' }],
    });
    const original = await approveAppleRelease(kit, { templateId: id });
    const base = await kit.registry.resolve(id, original.version);
    const source = await kit.scanner({ templateIds: [id] });
    const monitor = await screen('monitor', [source.id]);
    const pass = await kit.scanPass(id);
    const png = btoa(String.fromCharCode(...makePng(270, 270)));
    await putMemberPhoto(kit.ctx, system, pass.id, { png, includeInPass: false }, null);
    const firstEvent = row(source.id, { passId: pass.id });
    await publish(firstEvent);
    const first = (await hub().snapshot(monitor.attachment)).rows.find(
      (item) => item.id === firstEvent.id,
    );
    if (!first?.photoUrl) throw new Error('Missing initial release photo.');
    const firstPath = first.photoUrl.replace('/api/v1/scan', '');
    expect((await kit.get(monitor.headers, firstPath)).status).toBe(200);

    const version = `release-v2-${kit.ctx.ids.token(4)}`;
    const second = kit.registry.add({
      id,
      orgId: base.orgId,
      version,
      manifest: base.manifest,
      passJson: base.passJson,
      assets: { 'icon.png': ICON_PNG },
    });
    await persistTemplate(kit.fx, second, { registry: kit.registry });
    const newer = await approveAppleRelease(kit, { templateId: id, version });
    const now = kit.clock.now();
    await updatePass(kit.ctx, system, pass.id, { templateVersion: version }, { scope: null });
    const changed = await getPass(kit.env.DB, pass.id);
    if (!changed) throw new Error('Missing updated pass.');
    expect(changed.releaseId).toBe(newer.id);
    expect(changed.version).toBeGreaterThan(pass.version);
    expect((await kit.get(monitor.headers, firstPath)).status).toBe(404);

    const restored = await rollbackRelease(kit.ctx, newer.publisherAuth, id, {
      orgId: kit.org.id,
      mode: 'live',
      provider: 'apple',
      releaseId: original.id,
      candidateHash: original.candidateHash,
      expectedGeneration: newer.generation,
      reason: 'Restore the approved version for lineage testing.',
    });
    await updatePass(
      kit.ctx,
      system,
      pass.id,
      { templateVersion: original.version },
      { scope: null },
    );
    const returned = await getPass(kit.env.DB, pass.id);
    if (!returned) throw new Error('Missing restored pass.');
    expect(kit.clock.now()).toBe(now);
    expect(returned.templateVersion).toBe(pass.templateVersion);
    expect(returned.releaseId).toBe(restored.id);
    expect(returned.version).toBeGreaterThan(changed.version);
    expect((await kit.get(monitor.headers, firstPath)).status).toBe(404);
    const stale = (await hub().snapshot(monitor.attachment)).rows.find(
      (item) => item.id === firstEvent.id,
    );
    expect(stale).toMatchObject({ passId: null, holder: null, photoUrl: null });
    const freshEvent = row(source.id, { passId: pass.id });
    await publish(freshEvent);
    const fresh = (await hub().snapshot(monitor.attachment)).rows.find(
      (item) => item.id === freshEvent.id,
    );
    if (!fresh?.photoUrl) throw new Error('Missing restored-version photo.');
    expect(
      (await kit.get(monitor.headers, fresh.photoUrl.replace('/api/v1/scan', ''))).status,
    ).toBe(200);
  });

  it.each(['organization', 'template'] as const)(
    'does not remint a retained event after its evaluated %s revision changes',
    async (changed) => {
      const fixture = await photoFixture();
      expect((await kit.get(fixture.monitor.headers, fixture.path)).status).toBe(200);
      if (changed === 'organization') {
        await run(kit.env.DB, 'UPDATE orgs SET updated_at = updated_at + 1 WHERE id = ?', [
          kit.org.id,
        ]);
      } else {
        await run(kit.env.DB, 'UPDATE templates SET updated_at = updated_at + 1 WHERE id = ?', [
          template,
        ]);
      }
      expect((await kit.get(fixture.monitor.headers, fixture.path)).status).toBe(404);
      const stale = (await hub().snapshot(fixture.monitor.attachment)).rows.find(
        (entry) => entry.id === fixture.event.id,
      );
      expect(stale).toMatchObject({ passId: null, holder: null, photoUrl: null });

      const freshEvent = row(fixture.source.id, { passId: fixture.pass.id });
      await publish(freshEvent);
      const fresh = (await hub().snapshot(fixture.monitor.attachment)).rows.find(
        (entry) => entry.id === freshEvent.id,
      );
      if (!fresh?.photoUrl) throw new Error('Missing newly evaluated photo.');
      expect(
        (await kit.get(fixture.monitor.headers, fresh.photoUrl.replace('/api/v1/scan', ''))).status,
      ).toBe(200);
    },
  );
  it('does not revive a retained event or grant across connection and binding ABA', async () => {
    const fixture = await photoFixture();
    const connection = await createConnection(jobCtxOf(kit), system, {
      orgId: kit.org.id,
      connectorType: 'demo',
      name: 'Live lineage connection',
      config: { count: 1 },
      mode: 'manual',
    });
    const bind = async (connectionId: string | null, generation: number | null) => {
      const pass = await getPass(kit.env.DB, fixture.pass.id);
      if (!pass) throw new Error('Missing live pass.');
      expect(
        await setBinding(jobCtxOf(kit), pass, {
          connectionId,
          generation,
          connectionMode: connectionId ? connection.mode : null,
          externalRef: connectionId ? 'member-1' : null,
          fieldSources: pass.fieldSources,
        }),
      ).toBe(true);
    };
    await bind(connection.id, 1);
    const connectedEvent = row(fixture.source.id, { passId: fixture.pass.id });
    await publish(connectedEvent);
    const connected = (await hub().snapshot(fixture.monitor.attachment)).rows.find(
      (item) => item.id === connectedEvent.id,
    );
    if (!connected?.photoUrl) throw new Error('Missing connected photo.');
    const path = connected.photoUrl.replace('/api/v1/scan', '');
    expect((await kit.get(fixture.monitor.headers, path)).status).toBe(200);
    const now = kit.clock.now();
    await updateConnection(jobCtxOf(kit), system, connection.id, { enabled: false });
    expect((await kit.get(fixture.monitor.headers, path)).status).toBe(404);
    await updateConnection(jobCtxOf(kit), system, connection.id, { enabled: true });
    expect((await getConnection(kit.env.DB, connection.id))?.generation).toBe(3);
    expect((await kit.get(fixture.monitor.headers, path)).status).toBe(404);
    const stale = (await hub().snapshot(fixture.monitor.attachment)).rows.find(
      (item) => item.id === connectedEvent.id,
    );
    expect(stale).toMatchObject({ passId: null, holder: null, photoUrl: null });
    const refreshedEvent = row(fixture.source.id, { passId: fixture.pass.id });
    await publish(refreshedEvent);
    const refreshed = (await hub().snapshot(fixture.monitor.attachment)).rows.find(
      (item) => item.id === refreshedEvent.id,
    );
    if (!refreshed?.photoUrl) throw new Error('Missing refreshed photo.');
    const refreshedPath = refreshed.photoUrl.replace('/api/v1/scan', '');
    expect((await kit.get(fixture.monitor.headers, refreshedPath)).status).toBe(200);
    await bind(null, null);
    await bind(connection.id, 3);
    expect(kit.clock.now()).toBe(now);
    expect((await kit.get(fixture.monitor.headers, refreshedPath)).status).toBe(404);
    const rebound = (await hub().snapshot(fixture.monitor.attachment)).rows.find(
      (item) => item.id === refreshedEvent.id,
    );
    expect(rebound).toMatchObject({ passId: null, holder: null, photoUrl: null });
  });

  it('does not revive an event or photo grant after the pass changes away and back', async () => {
    const fixture = await photoFixture();
    const before = await getPass(kit.env.DB, fixture.pass.id);
    const originalName = before?.personalization.memberName;
    if (!before || typeof originalName !== 'string') throw new Error('Missing pass fixture.');
    expect((await kit.get(fixture.monitor.headers, fixture.path)).status).toBe(200);
    const now = kit.clock.now();
    await updatePass(
      kit.ctx,
      system,
      before.id,
      { input: { memberName: 'Different member' } },
      { scope: null },
    );
    await updatePass(
      kit.ctx,
      system,
      before.id,
      { input: { memberName: originalName } },
      { scope: null },
    );
    const restored = await getPass(kit.env.DB, before.id);
    if (!restored) throw new Error('Missing restored pass.');
    expect(restored.personalization.memberName).toBe(originalName);
    expect(restored.version).toBeGreaterThan(before.version);
    expect(kit.clock.now()).toBe(now);
    expect((await kit.get(fixture.monitor.headers, fixture.path)).status).toBe(404);
    const stale = (await hub().snapshot(fixture.monitor.attachment)).rows.find(
      (item) => item.id === fixture.event.id,
    );
    expect(stale).toMatchObject({ passId: null, holder: null, photoUrl: null });
    const freshEvent = row(fixture.source.id, { passId: before.id });
    await publish(freshEvent);
    const fresh = (await hub().snapshot(fixture.monitor.attachment)).rows.find(
      (item) => item.id === freshEvent.id,
    );
    if (!fresh?.photoUrl) throw new Error('Missing fresh pass photo.');
    expect(
      (await kit.get(fixture.monitor.headers, fresh.photoUrl.replace('/api/v1/scan', ''))).status,
    ).toBe(200);
  });
});
