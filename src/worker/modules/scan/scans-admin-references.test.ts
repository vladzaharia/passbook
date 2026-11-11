import { describe, expect, it } from 'vitest';
import {
  makeOrg,
  makeScanEvent,
  makeScanner,
  makeScanStaff,
} from '../../../../test/helpers/index.ts';
import { first, run } from '../../platform/db.ts';
import {
  clock,
  codeOf,
  DAY,
  env,
  eventId,
  f,
  fake,
  get,
  items,
  orgId,
  passId,
  type Rec,
  recordedAction,
  scannerFixture,
  scannerId,
  seed,
  staffId,
} from './repo-scans-split-test-fixtures.ts';

describe('GET /scans (admin)', () => {
  it('excludes foreign references and retains safe history with deleted or unresolved links redacted', async () => {
    const other = await makeOrg(f);
    const foreignScanner = await makeScanner(f, { orgId: other.id });
    const foreignEvent = await makeScanEvent(f, { orgId: other.id });
    const foreignStaff = await makeScanStaff(f, { orgId: other.id, name: 'Foreign staff' });
    const foreignScan = await seed({
      org_id: other.id,
      pass_id: null,
      template_id: null,
      scanner_id: null,
      event_id: null,
      staff_id: null,
    });
    const testScanner = await makeScanner(f, { orgId, mode: 'test' });
    const testEvent = await makeScanEvent(f, { orgId, mode: 'test' });
    const testScan = await seed({
      mode: 'test',
      pass_id: null,
      template_id: null,
      scanner_id: null,
      event_id: null,
      staff_id: null,
    });
    const foreign = await seed({
      scanner_id: foreignScanner.id,
      event_id: foreignEvent.id,
      staff_id: foreignStaff.id,
      approved_by: foreignStaff.id,
      action_kind: 'undo',
      action_id: null,
      undoes: foreignScan.id,
    });
    const wrongMode = await seed({
      scanner_id: testScanner.id,
      event_id: testEvent.id,
      action_kind: 'undo',
      action_id: null,
      undoes: testScan.id,
    });
    const foreignOverride = await seed({ override_of: foreignScan.id });
    const wrongModeOverride = await seed({ override_of: testScan.id });
    const missing = await seed({
      scanner_id: 'scanner-missing',
      event_id: 'event-missing',
      staff_id: 'staff-missing',
      actor_id: 'scanner-actor-missing',
      actor_key: 's:scanner-actor-missing',
      action_kind: 'undo',
      action_id: null,
      undoes: 'scan-missing',
    });
    const deletedScanner = await makeScanner(f, { orgId });
    const deletedEvent = await makeScanEvent(f, { orgId });
    const deletedStaff = await makeScanStaff(f, { orgId, name: 'Deleted staff' });
    const deletedTarget = await seed({
      pass_id: null,
      template_id: null,
      scanner_id: null,
      event_id: null,
      staff_id: null,
    });
    const deleted = await seed({
      scanner_id: deletedScanner.id,
      event_id: deletedEvent.id,
      staff_id: deletedStaff.id,
      actor_id: deletedScanner.id,
      actor_key: `s:${deletedScanner.id}`,
      action_kind: 'undo',
      action_id: null,
      undoes: deletedTarget.id,
    });
    await run(env.DB, 'DELETE FROM scanners WHERE id = ?', [deletedScanner.id]);
    await run(env.DB, 'DELETE FROM scan_events WHERE id = ?', [deletedEvent.id]);
    await run(env.DB, 'DELETE FROM scan_staff WHERE id = ?', [deletedStaff.id]);
    await run(env.DB, 'DELETE FROM scans WHERE id = ?', [deletedTarget.id]);
    expect(
      await first(env.DB, 'SELECT scanner_id, event_id, staff_id, undoes FROM scans WHERE id = ?', [
        deleted.id,
      ]),
    ).toEqual({
      scanner_id: deletedScanner.id,
      event_id: deletedEvent.id,
      staff_id: deletedStaff.id,
      undoes: deletedTarget.id,
    });
    const own = await recordedAction(scannerFixture, passId);
    const foreignActor = await seed({
      actor_id: foreignScanner.id,
      actor_key: `s:${foreignScanner.id}`,
    });
    const wrongModeActor = await seed({
      actor_id: testScanner.id,
      actor_key: `s:${testScanner.id}`,
    });

    const response = await get(`?orgId=${orgId}`);
    expect(response.status).toBe(200);
    const rows = await items(response);
    expect(rows.map((row) => row.id)).toEqual([own.id, deleted.id, missing.id]);
    const firstPage = (await (await get(`?orgId=${orgId}&limit=1`)).json()) as {
      items: Rec[];
      nextCursor: string | null;
    };
    expect(firstPage.items.map((row) => row.id)).toEqual([own.id]);
    expect(firstPage.nextCursor).toEqual(expect.any(String));
    expect(firstPage.nextCursor).not.toContain(own.id);
    for (const bad of [
      foreign,
      wrongMode,
      foreignActor,
      wrongModeActor,
      foreignOverride,
      wrongModeOverride,
    ]) {
      expect((await get(`/${bad.id}`)).status).toBe(404);
      const invalid = await get(`?orgId=${orgId}&cursor=${bad.id}`);
      expect(invalid.status).toBe(422);
      expect(await codeOf(invalid)).toBe('INVALID_CURSOR');
    }
    expect(rows.find((row) => row.id === missing.id)).toMatchObject({
      scannerId: null,
      eventId: null,
      staffId: null,
      undoes: null,
    });
    expect(rows.find((row) => row.id === missing.id)?.actor).toEqual({
      type: 'scanner',
      id: 'scanner-actor-missing',
    });
    expect(rows.find((row) => row.id === deleted.id)).toMatchObject({
      scannerId: null,
      eventId: null,
      staffId: null,
      undoes: null,
    });
    expect(rows.find((row) => row.id === deleted.id)?.actor).toEqual({
      type: 'scanner',
      id: deletedScanner.id,
    });
    const detail = await get(`/${missing.id}`);
    expect(detail.status).toBe(200);
    expect(await detail.json()).toMatchObject({
      scannerId: null,
      eventId: null,
      staffId: null,
      undoes: null,
      actor: { type: 'scanner', id: 'scanner-actor-missing' },
    });
    const apiKey = fake.apiKey({ orgId, scopes: ['scans:read'] });
    const feed = await items(await get('', apiKey));
    expect(feed.map((row) => row.id)).toEqual([own.id, deleted.id, missing.id]);
    expect(feed.find((row) => row.id === deleted.id)).toMatchObject({
      scannerId: null,
      eventId: null,
    });
    expect(feed.find((row) => row.id === missing.id)).toMatchObject({
      scannerId: null,
      eventId: null,
    });
    const window = `?orgId=${orgId}&from=${clock.now() - DAY}&to=${clock.now() + DAY}`;
    const exported = await get(`/export${window}`);
    expect(exported.status).toBe(200);
    const csv = await exported.text();
    expect(
      csv
        .replace(/^\uFEFF/, '')
        .trimEnd()
        .split('\r\n'),
    ).toHaveLength(4);
    expect(csv).not.toContain(new Date(foreignActor.at).toISOString());
    expect(csv).not.toContain(new Date(wrongModeActor.at).toISOString());
    expect(csv).not.toContain(new Date(foreign.at).toISOString());
    expect(csv).not.toContain(new Date(wrongMode.at).toISOString());
    expect(csv).not.toContain(new Date(foreignOverride.at).toISOString());
    expect(csv).not.toContain(new Date(wrongModeOverride.at).toISOString());
    const exportAudit = await first<{ detail: string }>(
      env.DB,
      "SELECT detail FROM audit_log WHERE action = 'scan.export'",
    );
    expect(JSON.parse(exportAudit?.detail ?? '{}')).toMatchObject({ rows: 3 });
    for (const value of [
      foreignScanner.id,
      foreignEvent.id,
      foreignStaff.id,
      foreignScan.id,
      'Foreign staff',
    ])
      expect(csv).not.toContain(value);
    const filters = [
      {
        name: 'scannerId',
        valid: scannerId,
        missing: 'scanner-missing',
        deleted: deletedScanner.id,
      },
      { name: 'eventId', valid: eventId, missing: 'event-missing', deleted: deletedEvent.id },
      { name: 'staffId', valid: staffId, missing: 'staff-missing', deleted: deletedStaff.id },
    ] as const;
    async function checkedExport(query: string, count: number) {
      const response = await get(`/export${window}&${query}`);
      expect(response.status).toBe(200);
      expect(
        (await response.text())
          .replace(/^\uFEFF/, '')
          .trimEnd()
          .split('\r\n'),
      ).toHaveLength(count + 1);
      const audit = await first<{ detail: string }>(
        env.DB,
        "SELECT detail FROM audit_log WHERE action = 'scan.export' ORDER BY id DESC LIMIT 1",
      );
      expect(JSON.parse(audit?.detail ?? '{}')).toMatchObject({ rows: count });
    }
    for (const filter of filters) {
      const validQuery = `${filter.name}=${filter.valid}`;
      const valid = (await (await get(`?orgId=${orgId}&${validQuery}&limit=1`)).json()) as {
        items: Rec[];
        nextCursor: string | null;
      };
      expect(valid.items.map((row) => row.id)).toEqual([own.id]);
      expect(valid.nextCursor).toBeNull();
      const keyRows = await items(await get(`?${validQuery}&limit=1`, apiKey));
      expect(keyRows.map((row) => row.id)).toEqual(filter.name === 'staffId' ? [] : [own.id]);
      await checkedExport(validQuery, 1);
      for (const reference of [filter.missing, filter.deleted]) {
        const query = `${filter.name}=${reference}`;
        const cursor = reference === filter.missing ? missing.id : deleted.id;
        expect(await items(await get(`?orgId=${orgId}&${query}&limit=1`))).toEqual([]);
        const sessionCursor = await get(`?orgId=${orgId}&${query}&cursor=${cursor}`);
        expect(sessionCursor.status).toBe(422);
        expect(await codeOf(sessionCursor)).toBe('INVALID_CURSOR');
        expect(await items(await get(`?${query}&limit=1`, apiKey))).toEqual([]);
        const keyCursor = await get(`?${query}&cursor=${cursor}`, apiKey);
        expect(keyCursor.status).toBe(422);
        expect(await codeOf(keyCursor)).toBe('INVALID_CURSOR');
        await checkedExport(query, 0);
      }
    }
    expect((await get(`?orgId=${other.id}&staffId=${staffId}`, apiKey)).status).toBe(403);
  });
});
