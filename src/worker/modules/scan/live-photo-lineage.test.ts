import { describe, expect, it } from 'vitest';
import { run } from '../../platform/db.ts';
import { deleteMemberPhoto, putMemberPhoto } from '../passes/member-photo.ts';
import { makePng } from '../templates/package/fixtures.ts';
import { scannerActor, withRole } from './actor.ts';
import { assetGrantValid, mintAssetGrant } from './assets.ts';
import { liveRecipient } from './live-auth.ts';
import { liveRowFor } from './live-render.ts';
import { getScanner } from './repo-device.ts';
import { candidateById } from './repo-lookup.ts';
import { setSetupWatchStmt } from './repo-setups-test-support.ts';
import {
  hub,
  kit,
  photoFixture,
  publish,
  row,
  screen,
  template,
} from './scan-hub-test-fixtures.ts';
import { proofedScanActor } from './test-kit.ts';

describe('live photo lineage', () => {
  it('renders a permitted member photo with a monitor-bound grant', async () => {
    const source = await kit.scanner({ templateIds: [template] });
    const monitor = await screen('monitor', [source.id]);
    const pass = await kit.scanPass(template);
    const png = btoa(String.fromCharCode(...makePng(270, 270)));
    await putMemberPhoto(
      kit.ctx,
      { type: 'system', id: null },
      pass.id,
      { png, includeInPass: false },
      null,
    );
    const entry = row(source.id, { passId: pass.id });
    await publish(entry);
    const snapshot = await hub().snapshot(monitor.attachment);
    const url = snapshot.rows.find((item) => item.id === entry.id)?.photoUrl ?? '';
    expect(url).toContain('/scan/live/passes/');
    const image = await kit.get(monitor.headers, url.replace('/api/v1/scan', ''));
    expect(image.status).toBe(200);
    const other = await screen('monitor', [source.id]);
    expect((await kit.get(other.headers, url.replace('/api/v1/scan', ''))).status).toBe(404);
  });

  it('separates ordinary grants from live grants and binds a live grant to its watched source', async () => {
    const fixture = await photoFixture();
    const otherSource = await kit.scanner({ templateIds: [template] });
    await setSetupWatchStmt(kit.env.DB, kit.org.id, fixture.monitor.id, {
      scannerIds: [fixture.source.id, otherSource.id],
      allOrg: false,
    }).run();
    const snapshot = await hub().snapshot(fixture.monitor.attachment);
    const projection = snapshot.rows.find((item) => item.id === fixture.event.id);
    if (!projection?.photoUrl) throw new Error('Missing current live photo.');
    expect(projection).not.toHaveProperty('sourceProof');
    const url = new URL(projection.photoUrl, 'https://wallet.test');
    expect(url.searchParams.has('sourceProof')).toBe(false);
    expect(url.searchParams.has('source')).toBe(false);
    const liveGrant = url.searchParams.get('g');
    const recipient = await liveRecipient(kit.ctx, fixture.monitor.attachment);
    const candidate = await candidateById(kit.env.DB, kit.org.id, fixture.pass.id);
    if (!liveGrant || !recipient || !candidate?.activeTemplateVersion)
      throw new Error('Missing grant authority fixture.');
    const sourceRow = await getScanner(kit.env.DB, fixture.source.id);
    if (!sourceRow) throw new Error('Missing source scanner.');
    const sourceActor = await proofedScanActor(
      kit.ctx,
      withRole(
        scannerActor(kit.ctx, sourceRow, 'live', 'cookie', {
          event: null,
          templateIds: [template],
        }),
        null,
      ),
    );
    const ordinary = await mintAssetGrant(
      kit.ctx,
      sourceActor,
      candidate,
      candidate.connectionGeneration,
      candidate.activeTemplateVersion,
      undefined,
      true,
      'commit',
    );
    expect(
      await assetGrantValid(
        kit.ctx,
        sourceActor,
        candidate,
        candidate.connectionGeneration,
        ordinary,
        undefined,
        'commit',
        true,
      ),
    ).toBe(true);
    expect(
      await assetGrantValid(
        kit.ctx,
        recipient.actor,
        candidate,
        candidate.connectionGeneration,
        liveGrant,
        { sourceId: fixture.source.id, eventId: fixture.event.id, actor: sourceActor },
        'commit',
        true,
      ),
    ).toBe(true);
    expect(
      await assetGrantValid(
        kit.ctx,
        sourceActor,
        candidate,
        candidate.connectionGeneration,
        liveGrant,
        undefined,
        'commit',
        true,
      ),
    ).toBe(false);
    expect(
      await assetGrantValid(
        kit.ctx,
        recipient.actor,
        candidate,
        candidate.connectionGeneration,
        ordinary,
        { sourceId: fixture.source.id, eventId: fixture.event.id, actor: sourceActor },
        'commit',
        true,
      ),
    ).toBe(false);
    const path = () => `${url.pathname.replace('/api/v1/scan', '')}${url.search}`;
    expect((await kit.get(fixture.monitor.headers, path())).status).toBe(200);
    const otherSourceEvent = row(otherSource.id, { passId: fixture.pass.id });
    await publish(otherSourceEvent);
    url.searchParams.set('event', otherSourceEvent.id);
    expect((await kit.get(fixture.monitor.headers, path())).status).toBe(404);
    const anotherEvent = row(fixture.source.id, { passId: fixture.pass.id });
    await publish(anotherEvent);
    url.searchParams.set('event', anotherEvent.id);
    expect((await kit.get(fixture.monitor.headers, path())).status).toBe(404);
    url.searchParams.set('event', fixture.event.id);
    expect(url.searchParams.has('source')).toBe(false);
    url.searchParams.set('g', ordinary);
    expect((await kit.get(fixture.monitor.headers, path())).status).toBe(404);
  });

  it('omits retained rows without valid source proof', async () => {
    const fixture = await photoFixture();
    const recipient = await liveRecipient(kit.ctx, fixture.monitor.attachment);
    if (!recipient) throw new Error('Missing monitor recipient.');
    for (const entry of [
      row(fixture.source.id, { passId: fixture.pass.id }),
      { ...row(fixture.source.id, { passId: fixture.pass.id }), sourceProof: 'invalid' },
    ]) {
      const projection = await liveRowFor(kit.ctx, recipient, entry);
      expect(projection).toBeNull();
      expect(JSON.stringify(projection)).not.toContain('Private Member');
      expect(JSON.stringify(projection)).not.toContain('sourceProof');
    }
  });

  it('revokes an old live photo after deletion and recreation with identical bytes', async () => {
    const fixture = await photoFixture();
    expect((await kit.get(fixture.monitor.headers, fixture.path)).status).toBe(200);
    await deleteMemberPhoto(kit.ctx, { type: 'system', id: null }, fixture.pass.id, null);
    await putMemberPhoto(
      kit.ctx,
      { type: 'system', id: null },
      fixture.pass.id,
      { png: fixture.png, includeInPass: false },
      null,
    );
    expect((await kit.get(fixture.monitor.headers, fixture.path)).status).toBe(404);
    const stale = (await hub().snapshot(fixture.monitor.attachment)).rows.find(
      (item) => item.id === fixture.event.id,
    );
    expect(stale).toMatchObject({ passId: null, holder: null, photoUrl: null });
    const event = row(fixture.source.id, { passId: fixture.pass.id });
    await publish(event);
    const fresh = (await hub().snapshot(fixture.monitor.attachment)).rows.find(
      (item) => item.id === event.id,
    );
    expect(fresh?.photoUrl).toBeTruthy();
    expect(
      (await kit.get(fixture.monitor.headers, fresh!.photoUrl!.replace('/api/v1/scan', ''))).status,
    ).toBe(200);
  });

  it('binds live photos to the current connection generation and denies a disabled connection', async () => {
    const fixture = await photoFixture();
    const connectionId = kit.ctx.ids.id();
    await run(
      kit.env.DB,
      `INSERT INTO connections (id, org_id, connector_type, name, generation, created_at, updated_at)
       VALUES (?, ?, 'demo', 'Live photo', 1, 1, 1)`,
      [connectionId, kit.org.id],
    );
    await run(
      kit.env.DB,
      "UPDATE passes SET connection_id = ?, external_ref = 'live-photo' WHERE id = ?",
      [connectionId, fixture.pass.id],
    );
    expect((await kit.get(fixture.monitor.headers, fixture.path)).status).toBe(404);
    const stale = (await hub().snapshot(fixture.monitor.attachment)).rows.find(
      (item) => item.id === fixture.event.id,
    );
    expect(stale?.photoUrl).toBeNull();
    const connectedEvent = row(fixture.source.id, { passId: fixture.pass.id });
    await publish(connectedEvent);
    const connected = (await hub().snapshot(fixture.monitor.attachment)).rows.find(
      (item) => item.id === connectedEvent.id,
    );
    if (!connected?.photoUrl) throw new Error('Missing connected live photo.');
    const path = connected.photoUrl.replace('/api/v1/scan', '');
    expect((await kit.get(fixture.monitor.headers, path)).status).toBe(200);
    await run(kit.env.DB, 'UPDATE connections SET generation = generation + 1 WHERE id = ?', [
      connectionId,
    ]);
    expect((await kit.get(fixture.monitor.headers, path)).status).toBe(404);
    await run(kit.env.DB, 'UPDATE connections SET enabled = 0 WHERE id = ?', [connectionId]);
    const disabled = (await hub().snapshot(fixture.monitor.attachment)).rows.find(
      (item) => item.id === connectedEvent.id,
    );
    expect(disabled?.photoUrl).toBeNull();
  });

  it('enforces the current source event filter on both projection and redemption', async () => {
    const event = await kit.event({ templateIds: [template] });
    await run(kit.env.DB, 'UPDATE scan_events SET match_input = ?, match_values = ? WHERE id = ?', [
      'tier',
      '["gold"]',
      event.id,
    ]);
    const source = await kit.scanner({ eventId: event.id });
    const monitor = await screen('monitor', [source.id]);
    const pass = await kit.scanPass(template, { tier: 'gold' });
    const png = btoa(String.fromCharCode(...makePng(270, 270)));
    await putMemberPhoto(
      kit.ctx,
      { type: 'system', id: null },
      pass.id,
      { png, includeInPass: false },
      null,
    );
    const entry = row(source.id, { passId: pass.id });
    await publish(entry);
    const initial = (await hub().snapshot(monitor.attachment)).rows.find(
      (item) => item.id === entry.id,
    );
    if (!initial?.photoUrl) throw new Error('Missing event-scoped live photo.');
    const path = initial.photoUrl.replace('/api/v1/scan', '');
    expect((await kit.get(monitor.headers, path)).status).toBe(200);
    await run(
      kit.env.DB,
      'UPDATE scan_events SET match_values = ?, updated_at = updated_at + 1 WHERE id = ?',
      ['["silver"]', event.id],
    );
    expect((await kit.get(monitor.headers, path)).status).toBe(404);
    const current = (await hub().snapshot(monitor.attachment)).rows.find(
      (item) => item.id === entry.id,
    );
    expect(current).toBeUndefined();
  });

  it('requires both source and monitor roles to meet the photo policy', async () => {
    const restricted = await kit.scanTemplate('Desk live photo', {
      actions: [{ id: 'check_in', label: 'Check in', kind: 'check_in' }],
      display: { v: 1, photo: { minRole: 'desk' }, header: {} },
    });
    const source = await kit.scanner({
      templateIds: [restricted],
      settings: { roleWithoutSignIn: 'desk' },
    });
    const door = await screen('monitor', [source.id]);
    const desk = await screen('monitor', [source.id], false, { roleWithoutSignIn: 'desk' });
    const pass = await kit.scanPass(restricted);
    const png = btoa(String.fromCharCode(...makePng(270, 270)));
    await putMemberPhoto(
      kit.ctx,
      { type: 'system', id: null },
      pass.id,
      { png, includeInPass: false },
      null,
    );
    const entry = row(source.id, { passId: pass.id });
    await publish(entry);
    const doorResult = (await hub().snapshot(door.attachment)).rows.find(
      (item) => item.id === entry.id,
    );
    const deskResult = (await hub().snapshot(desk.attachment)).rows.find(
      (item) => item.id === entry.id,
    );
    expect(doorResult?.photoUrl).toBeNull();
    if (!deskResult?.photoUrl) throw new Error('Missing desk photo.');
    expect(
      (await kit.get(desk.headers, deskResult.photoUrl.replace('/api/v1/scan', ''))).status,
    ).toBe(200);
    await run(
      kit.env.DB,
      "UPDATE scanners SET settings = json_set(settings, '$.roleWithoutSignIn', 'door'), updated_at = updated_at + 1 WHERE id = ?",
      [source.id],
    );
    expect(
      (await kit.get(desk.headers, deskResult.photoUrl.replace('/api/v1/scan', ''))).status,
    ).toBe(404);
    const downgraded = (await hub().snapshot(desk.attachment)).rows.find(
      (item) => item.id === entry.id,
    );
    expect(downgraded).toBeUndefined();
  });

  it('omits the row and denies the photo after the source loses template access', async () => {
    const fixture = await photoFixture();
    await run(
      kit.env.DB,
      'DELETE FROM scanner_templates WHERE scanner_id = ? AND template_id = ?',
      [fixture.source.id, template],
    );
    expect((await kit.get(fixture.monitor.headers, fixture.path)).status).toBe(404);
    const projection = (await hub().snapshot(fixture.monitor.attachment)).rows.find(
      (item) => item.id === fixture.event.id,
    );
    expect(projection).toBeUndefined();
  });

  it.each([
    ['voided', "status = 'voided'"],
    ['removed', 'removed_at = 1'],
    ['quarantined', 'test_data_quarantined = 1'],
  ])('does not project or serve a %s pass photo', async (_state, change) => {
    const fixture = await photoFixture();
    await run(kit.env.DB, `UPDATE passes SET ${change} WHERE id = ?`, [fixture.pass.id]);
    expect((await kit.get(fixture.monitor.headers, fixture.path)).status).toBe(404);
    const projection = (await hub().snapshot(fixture.monitor.attachment)).rows.find(
      (item) => item.id === fixture.event.id,
    );
    expect(projection?.photoUrl).toBeNull();
  });

  it('honors the source and monitor photo settings during projection and redemption', async () => {
    const fixture = await photoFixture();
    await run(
      kit.env.DB,
      "UPDATE scanners SET settings = json_set(settings, '$.showPhoto', json('false')), updated_at = updated_at + 1 WHERE id = ?",
      [fixture.source.id],
    );
    expect((await kit.get(fixture.monitor.headers, fixture.path)).status).toBe(404);
    const projection = (await hub().snapshot(fixture.monitor.attachment)).rows.find(
      (item) => item.id === fixture.event.id,
    );
    expect(projection).toBeUndefined();

    const source = await kit.scanner({ templateIds: [template] });
    const monitor = await screen('monitor', [source.id], false, { showPhoto: false });
    const event = row(source.id, { passId: fixture.pass.id });
    await publish(event);
    const hidden = (await hub().snapshot(monitor.attachment)).rows.find(
      (item) => item.id === event.id,
    );
    expect(hidden?.photoUrl).toBeNull();
  });
});
