import { runInDurableObject } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { expectProblem } from '../../../../test/helpers/denial.ts';
import { run } from '../../platform/db.ts';
import { deleteMemberPhoto, putMemberPhoto } from '../passes/member-photo.ts';
import { makePng } from '../templates/package/fixtures.ts';
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

describe('live photo lineage', () => {
  it('serves a permitted member photo to a watching monitor only', async () => {
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
    const unwatching = await screen('monitor', []);
    await expectProblem(
      await kit.get(unwatching.headers, url.replace('/api/v1/scan', '')),
      404,
      'ASSET_NOT_FOUND',
    );
  });

  it('binds a live photo to its retained event, its pass and a watched source', async () => {
    const fixture = await photoFixture();
    const otherSource = await kit.scanner({ templateIds: [template] });
    const otherPass = await kit.scanPass(template);
    const projection = (await hub().snapshot(fixture.monitor.attachment)).rows.find(
      (item) => item.id === fixture.event.id,
    );
    if (!projection?.photoUrl) throw new Error('Missing current live photo.');
    const url = new URL(projection.photoUrl, 'https://wallet.test');
    expect([...url.searchParams.keys()]).toEqual(['event']);
    const path = () => `${url.pathname.replace('/api/v1/scan', '')}${url.search}`;
    expect((await kit.get(fixture.monitor.headers, path())).status).toBe(200);
    // An event nobody retained, and an event of another pass, never open this pass's photo.
    url.searchParams.set('event', 'no-such-event');
    await expectProblem(await kit.get(fixture.monitor.headers, path()), 404, 'ASSET_NOT_FOUND');
    const otherEvent = row(otherSource.id, { passId: otherPass.id });
    await publish(otherEvent);
    url.searchParams.set('event', otherEvent.id);
    await expectProblem(await kit.get(fixture.monitor.headers, path()), 404, 'ASSET_NOT_FOUND');
    // A source the monitor does not watch is out of scope until the watch lists it.
    const sameFromOther = row(otherSource.id, { passId: fixture.pass.id });
    await publish(sameFromOther);
    url.searchParams.set('event', sameFromOther.id);
    await expectProblem(await kit.get(fixture.monitor.headers, path()), 404, 'ASSET_NOT_FOUND');
    await setSetupWatchStmt(kit.env.DB, kit.org.id, fixture.monitor.id, {
      scannerIds: [fixture.source.id, otherSource.id],
      allOrg: false,
    }).run();
    expect((await kit.get(fixture.monitor.headers, path())).status).toBe(200);
  });

  it('renders ring entries written before plain rows as redacted', async () => {
    const fixture = await photoFixture();
    const old = {
      ...fixture.event,
      id: kit.ctx.ids.token(16),
      holder: 'Private Member',
      sourceProof: 'sealed-by-an-earlier-deploy',
    };
    await runInDurableObject(hub(), async (_object, state) => {
      const ring = (await state.storage.get<unknown[]>('recent')) ?? [];
      await state.storage.put('recent', [...ring, old]);
    });
    const rows = (await hub().snapshot(fixture.monitor.attachment)).rows;
    expect(rows.find((item) => item.id === fixture.event.id)).toMatchObject({
      passId: fixture.pass.id,
    });
    const legacy = rows.find((item) => item.id === old.id);
    expect(legacy).toMatchObject({ passId: null, holder: null, photoUrl: null });
    expect(JSON.stringify(legacy)).not.toMatch(/Private Member|sourceProof|sealed/);
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
    await expectProblem(
      await kit.get(fixture.monitor.headers, fixture.path),
      404,
      'ASSET_NOT_FOUND',
    );
    const stale = (await hub().snapshot(fixture.monitor.attachment)).rows.find(
      (item) => item.id === fixture.event.id,
    );
    expect(stale).toMatchObject({ passId: fixture.pass.id, photoUrl: null });
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

  it('withholds the pass of a disabled connection', async () => {
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
    // Attaching an enabled connection changes content, not authority.
    expect((await kit.get(fixture.monitor.headers, fixture.path)).status).toBe(200);
    await run(kit.env.DB, 'UPDATE connections SET enabled = 0 WHERE id = ?', [connectionId]);
    await expectProblem(
      await kit.get(fixture.monitor.headers, fixture.path),
      404,
      'ASSET_NOT_FOUND',
    );
    const disabled = (await hub().snapshot(fixture.monitor.attachment)).rows.find(
      (item) => item.id === fixture.event.id,
    );
    expect(disabled).toMatchObject({ passId: null, holder: null, photoUrl: null });
  });

  it('does not re-check the source event filter after the scan', async () => {
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
    expect((await kit.get(monitor.headers, path)).status).toBe(200);
    const current = (await hub().snapshot(monitor.attachment)).rows.find(
      (item) => item.id === entry.id,
    );
    expect(current).toMatchObject({ passId: pass.id });
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
    // The source is not re-checked: the scan was made under the role it had.
    expect(
      (await kit.get(desk.headers, deskResult.photoUrl.replace('/api/v1/scan', ''))).status,
    ).toBe(200);
  });

  it('keeps the row after the source loses template access', async () => {
    const fixture = await photoFixture();
    await run(
      kit.env.DB,
      'DELETE FROM scanner_templates WHERE scanner_id = ? AND template_id = ?',
      [fixture.source.id, template],
    );
    expect((await kit.get(fixture.monitor.headers, fixture.path)).status).toBe(200);
    const projection = (await hub().snapshot(fixture.monitor.attachment)).rows.find(
      (item) => item.id === fixture.event.id,
    );
    expect(projection).toMatchObject({ passId: fixture.pass.id });
  });

  it.each([
    ['voided', "status = 'voided'"],
    ['removed', 'removed_at = 1'],
    ['quarantined', 'test_data_quarantined = 1'],
  ])('does not project or serve a %s pass photo', async (_state, change) => {
    const fixture = await photoFixture();
    await run(kit.env.DB, `UPDATE passes SET ${change} WHERE id = ?`, [fixture.pass.id]);
    await expectProblem(
      await kit.get(fixture.monitor.headers, fixture.path),
      404,
      'ASSET_NOT_FOUND',
    );
    const projection = (await hub().snapshot(fixture.monitor.attachment)).rows.find(
      (item) => item.id === fixture.event.id,
    );
    expect(projection?.photoUrl).toBeNull();
  });

  it('honors the source setting at the scan and the monitor setting at every read', async () => {
    const fixture = await photoFixture();
    await run(
      kit.env.DB,
      "UPDATE scanners SET settings = json_set(settings, '$.showPhoto', json('false')), updated_at = updated_at + 1 WHERE id = ?",
      [fixture.source.id],
    );
    // The scan was made while photos were on: the retained row keeps its photo.
    expect((await kit.get(fixture.monitor.headers, fixture.path)).status).toBe(200);
    const next = row(fixture.source.id, { passId: fixture.pass.id });
    await publish(next);
    expect(
      (await hub().snapshot(fixture.monitor.attachment)).rows.find((item) => item.id === next.id)
        ?.photoUrl,
    ).toBeNull();

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
