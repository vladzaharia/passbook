import { describe, expect, it } from 'vitest';
import { first, run } from '../../platform/db.ts';
import { recordedCheckIn } from './console-privacy-actions-test-fixtures.ts';
import {
  app,
  expectNoSecrets,
  exportPath,
  fake,
  get,
  kit,
  lastExportCount,
  PUBLIC,
  page,
  privatePass,
  seedScan,
  setupPrivacyKit,
  templateId,
  testAdmin,
} from './console-privacy-test-fixtures.ts';
import { ORIGIN } from './test-kit.ts';

setupPrivacyKit();

describe('scan console and feed privacy', () => {
  it('does not restore Test history when quarantine races a prepared hard delete', async () => {
    const scanner = await kit.scanner({ templateIds: [templateId], mode: 'test' });
    const pass = await kit.scanPass(templateId, { memberName: PUBLIC }, { mode: 'test' });
    const row = await recordedCheckIn(scanner, pass.id);
    expect(
      await first(kit.env.DB, 'SELECT excluded FROM scan_retention_proofs WHERE scan_id = ?', [
        row.id,
      ]),
    ).toEqual({ excluded: 0 });
    expect((await page(`?orgId=${kit.org.id}`, testAdmin)).items.map((item) => item.id)).toEqual([
      row.id,
    ]);
    const observed = await first<{ test_data_quarantined: number }>(
      kit.env.DB,
      'SELECT test_data_quarantined FROM passes WHERE id = ?',
      [pass.id],
    );
    expect(observed).toEqual({ test_data_quarantined: 0 });
    // D1 counts cascade and trigger writes in meta.changes; RETURNING counts the pass row.
    const deletion = kit.env.DB.prepare('DELETE FROM passes WHERE id = ? RETURNING id').bind(
      pass.id,
    );
    await run(kit.env.DB, 'UPDATE passes SET test_data_quarantined = 1 WHERE id = ?', [pass.id]);
    expect(
      await first(kit.env.DB, 'SELECT excluded FROM scan_retention_proofs WHERE scan_id = ?', [
        row.id,
      ]),
    ).toEqual({ excluded: 1 });
    expect((await page(`?orgId=${kit.org.id}`, testAdmin)).items).toEqual([]);
    expect((await deletion.all()).results).toHaveLength(1);
    expect(await first(kit.env.DB, 'SELECT pass_id FROM scans WHERE id = ?', [row.id])).toEqual({
      pass_id: null,
    });
    expect(
      await first(kit.env.DB, 'SELECT excluded FROM scan_retention_proofs WHERE scan_id = ?', [
        row.id,
      ]),
    ).toEqual({ excluded: 1 });

    expect((await page(`?orgId=${kit.org.id}`, testAdmin)).items).toEqual([]);
    expect((await get(`/${row.id}`, testAdmin)).status).toBe(404);
    const key = fake.apiKey({ orgId: kit.org.id, scopes: ['scans:read'], mode: 'test' });
    expect((await page('', key)).items).toEqual([]);
    const exported = await get(exportPath(), testAdmin);
    expect(exported.status).toBe(200);
    expect(
      (await exported.text())
        .replace(/^\uFEFF/, '')
        .trimEnd()
        .split('\r\n'),
    ).toHaveLength(1);
    expect(await lastExportCount()).toBe(0);

    const recent = await app.request(
      `${ORIGIN}/api/v1/scan/scans?limit=10`,
      { headers: scanner.headers },
      kit.env,
    );
    expect(recent.status).toBe(200);
    expect(await recent.json()).toMatchObject({ items: [] });
    const summary = await app.request(
      `${ORIGIN}/api/v1/scan/summary`,
      { headers: scanner.headers },
      kit.env,
    );
    expect(summary.status).toBe(200);
    expect(await summary.json()).toMatchObject({ total: 0, ok: 0, byAction: [] });
  });

  it('permanently excludes history after quarantine even if the pass is unquarantined and deleted', async () => {
    const scanner = await kit.scanner({ templateIds: [templateId], mode: 'test' });
    const pass = await kit.scanPass(templateId, { memberName: PUBLIC }, { mode: 'test' });
    const row = await recordedCheckIn(scanner, pass.id);
    const proof = () =>
      first(kit.env.DB, 'SELECT excluded FROM scan_retention_proofs WHERE scan_id = ?', [row.id]);
    expect(await proof()).toEqual({ excluded: 0 });
    await run(kit.env.DB, 'UPDATE passes SET test_data_quarantined = 1 WHERE id = ?', [pass.id]);
    expect(await proof()).toEqual({ excluded: 1 });
    await run(kit.env.DB, 'UPDATE passes SET test_data_quarantined = 0 WHERE id = ?', [pass.id]);
    expect(await proof()).toEqual({ excluded: 1 });
    expect((await page(`?orgId=${kit.org.id}`, testAdmin)).items).toEqual([]);
    await run(kit.env.DB, 'DELETE FROM passes WHERE id = ?', [pass.id]);
    expect(await proof()).toEqual({ excluded: 1 });
    expect((await page(`?orgId=${kit.org.id}`, testAdmin)).items).toEqual([]);
    expect((await get(`/${row.id}`, testAdmin)).status).toBe(404);
    const exported = await get(exportPath(), testAdmin);
    expect(exported.status).toBe(200);
    expect(
      (await exported.text())
        .replace(/^\uFEFF/, '')
        .trimEnd()
        .split('\r\n'),
    ).toHaveLength(1);
    expect(await lastExportCount()).toBe(0);
    const summary = await app.request(
      `${ORIGIN}/api/v1/scan/summary`,
      { headers: scanner.headers },
      kit.env,
    );
    expect(summary.status).toBe(200);
    expect(await summary.json()).toMatchObject({ total: 0, ok: 0, byAction: [] });
  });

  it('preserves quarantine exclusion for a pre-index legacy scan after unquarantine', async () => {
    const scanner = await kit.scanner({ templateIds: [templateId], mode: 'test' });
    const pass = await kit.scanPass(templateId, { memberName: PUBLIC }, { mode: 'test' });
    const row = await seedScan({
      scanner,
      passId: pass.id,
      mode: 'test',
      passVersion: pass.version,
    });
    expect(
      await first(kit.env.DB, 'SELECT scan_id FROM scan_retention_proofs WHERE scan_id = ?', [
        row.id,
      ]),
    ).toBeNull();
    expect((await page(`?orgId=${kit.org.id}`, testAdmin)).items).toEqual([
      expect.objectContaining({ id: row.id, passId: null, templateId: null }),
    ]);
    await run(kit.env.DB, 'UPDATE passes SET test_data_quarantined = 1 WHERE id = ?', [pass.id]);
    await run(kit.env.DB, 'UPDATE passes SET test_data_quarantined = 0 WHERE id = ?', [pass.id]);
    expect((await page(`?orgId=${kit.org.id}`, testAdmin)).items).toEqual([]);
    expect((await get(`/${row.id}`, testAdmin)).status).toBe(404);
    const exported = await get(exportPath(), testAdmin);
    expect(exported.status).toBe(200);
    expect(
      (await exported.text())
        .replace(/^\uFEFF/, '')
        .trimEnd()
        .split('\r\n'),
    ).toHaveLength(1);
    expect(await lastExportCount()).toBe(0);
    await run(kit.env.DB, 'DELETE FROM passes WHERE id = ?', [pass.id]);
    expect((await page(`?orgId=${kit.org.id}`, testAdmin)).items).toEqual([]);
  });

  it.each(['scan', 'event'] as const)(
    'retains a live %s-tampered row minimally but never trusts it as deleted-pass history',
    async (target) => {
      const scanner = await kit.scanner({ templateIds: [templateId], mode: 'test' });
      const pass = await kit.scanPass(templateId, { memberName: PUBLIC }, { mode: 'test' });
      const row = await recordedCheckIn(scanner, pass.id);
      const proof = () =>
        first(
          kit.env.DB,
          'SELECT excluded, invalidated FROM scan_retention_proofs WHERE scan_id = ?',
          [row.id],
        );
      expect(await proof()).toEqual({ excluded: 0, invalidated: 0 });
      const event = await first<{ id: string; data: string }>(
        kit.env.DB,
        "SELECT id, data FROM pass_events WHERE pass_id = ? AND json_extract(data, '$.scanId') = ?",
        [pass.id, row.id],
      );
      if (!event) throw new Error('A recorded scan must have its pass event.');
      if (target === 'scan') {
        await run(kit.env.DB, "UPDATE scans SET action_id = 'tampered-action' WHERE id = ?", [
          row.id,
        ]);
      } else {
        // A recorded fact the readers check: without its role projection the event is unusable.
        await run(
          kit.env.DB,
          "UPDATE pass_events SET data = json_remove(data, '$.authority.eventProjection') WHERE id = ?",
          [event.id],
        );
      }
      expect(await proof()).toEqual({ excluded: 0, invalidated: 1 });
      const live = await page(`?orgId=${kit.org.id}`, testAdmin);
      expect(live.items).toHaveLength(1);
      expect(live.items[0]).toMatchObject({
        id: row.id,
        passId: null,
        passTitle: null,
        kind: null,
        actionId: null,
      });
      if (target === 'scan') {
        await run(kit.env.DB, "UPDATE scans SET action_id = 'check_in' WHERE id = ?", [row.id]);
      } else {
        await run(kit.env.DB, 'UPDATE pass_events SET data = ? WHERE id = ?', [
          event.data,
          event.id,
        ]);
      }
      expect(await proof()).toEqual({ excluded: 0, invalidated: 1 });
      await run(kit.env.DB, 'DELETE FROM passes WHERE id = ?', [pass.id]);
      expect(await proof()).toEqual({ excluded: 0, invalidated: 1 });
      expect((await page(`?orgId=${kit.org.id}`, testAdmin)).items).toEqual([]);
      expect((await get(`/${row.id}`, testAdmin)).status).toBe(404);
      const key = fake.apiKey({ orgId: kit.org.id, scopes: ['scans:read'], mode: 'test' });
      expect((await page('', key)).items).toEqual([]);
      const exported = await get(exportPath(), testAdmin);
      expect(exported.status).toBe(200);
      expect(
        (await exported.text())
          .replace(/^\uFEFF/, '')
          .trimEnd()
          .split('\r\n'),
      ).toHaveLength(1);
      expect(await lastExportCount()).toBe(0);
      const summary = await app.request(
        `${ORIGIN}/api/v1/scan/summary`,
        { headers: scanner.headers },
        kit.env,
      );
      expect(summary.status).toBe(200);
      expect(await summary.json()).toMatchObject({ total: 0, ok: 0, byAction: [] });
    },
  );

  it('excludes unfinished and failed claims from history and export counts', async () => {
    const scanner = await kit.scanner({ templateIds: [templateId] });
    const pass = await privatePass();
    const complete = await recordedCheckIn(scanner, pass.id);
    const pending = await seedScan({ scanner, passId: pass.id });
    const failed = await seedScan({ scanner, passId: pass.id });
    await run(kit.env.DB, "UPDATE scans SET state = 'pending', outcome = NULL WHERE id = ?", [
      pending.id,
    ]);
    await run(kit.env.DB, "UPDATE scans SET state = 'failed', outcome = NULL WHERE id = ?", [
      failed.id,
    ]);

    expect((await page(`?orgId=${kit.org.id}`)).items.map((row) => row.id)).toEqual([complete.id]);
    const apiKey = fake.apiKey({ orgId: kit.org.id, scopes: ['scans:read'] });
    expect((await page('', apiKey)).items.map((row) => row.id)).toEqual([complete.id]);
    expect((await get(`/${pending.id}`)).status).toBe(404);
    expect((await get(`/${failed.id}`)).status).toBe(404);
    const exported = await get(exportPath());
    expect(exported.status).toBe(200);
    expect(
      (await exported.text())
        .replace(/^\uFEFF/, '')
        .trimEnd()
        .split('\r\n'),
    ).toHaveLength(2);
    expect(await lastExportCount()).toBe(1);
  });

  it('redacts voided pass history and excludes quarantined history, including filtered counts', async () => {
    const scanner = await kit.scanner({ templateIds: [templateId] });
    const pass = await privatePass();
    const row = await recordedCheckIn(scanner, pass.id);
    const apiKey = fake.apiKey({ orgId: kit.org.id, scopes: ['scans:read'] });
    expect((await page(`?orgId=${kit.org.id}`)).items.map((item) => item.id)).toEqual([row.id]);
    expect((await page('', apiKey)).items.map((item) => item.id)).toEqual([row.id]);
    expect((await get(`/${row.id}`)).status).toBe(200);
    expect(
      (await page(`?orgId=${kit.org.id}&passId=${pass.id}`)).items.map((item) => item.id),
    ).toEqual([row.id]);
    expect((await page(`?passId=${pass.id}`, apiKey)).items.map((item) => item.id)).toEqual([
      row.id,
    ]);
    const visibleExport = await get(exportPath(`&passId=${pass.id}`));
    expect(visibleExport.status).toBe(200);
    expect(
      (await visibleExport.text())
        .replace(/^\uFEFF/, '')
        .trimEnd()
        .split('\r\n'),
    ).toHaveLength(2);
    expect(await lastExportCount()).toBe(1);

    await run(kit.env.DB, "UPDATE passes SET status = 'voided' WHERE id = ?", [pass.id]);
    const list = await page(`?orgId=${kit.org.id}`);
    expect(list.items).toEqual([
      expect.objectContaining({
        id: row.id,
        passId: null,
        templateId: null,
        passTitle: null,
        kind: null,
        actionId: null,
        actionLabel: null,
        before: null,
        after: null,
        outcome: 'ok',
        reason: null,
      }),
    ]);
    const feed = await page('', apiKey);
    expect(feed.items).toEqual([
      expect.objectContaining({
        id: row.id,
        passId: null,
        templateId: null,
        kind: null,
        actionId: null,
        outcome: 'ok',
        reason: null,
      }),
    ]);
    const detail = await get(`/${row.id}`);
    expect(detail.status).toBe(200);
    expect(await detail.json()).toMatchObject({
      id: row.id,
      passId: null,
      templateId: null,
      kind: null,
    });
    expect((await page(`?orgId=${kit.org.id}&q=Public`)).items).toEqual([]);
    const filtered = await page(`?orgId=${kit.org.id}&passId=${pass.id}&limit=1`);
    expect(filtered).toMatchObject({ items: [], nextCursor: null });
    const keyFiltered = await page(`?passId=${pass.id}&limit=1`, apiKey);
    expect(keyFiltered).toMatchObject({ items: [], nextCursor: null });
    const response = await get(exportPath());
    expect(response.status).toBe(200);
    const csv = await response.text();
    expect(
      csv
        .replace(/^\uFEFF/, '')
        .trimEnd()
        .split('\r\n'),
    ).toHaveLength(2);
    expect(csv).toContain(new Date(row.at).toISOString());
    expect(csv).not.toContain(PUBLIC);
    expectNoSecrets(csv, pass);
    expect(await lastExportCount()).toBe(1);
    const hiddenExport = await get(exportPath(`&passId=${pass.id}`));
    expect(hiddenExport.status).toBe(200);
    expect(
      (await hiddenExport.text())
        .replace(/^\uFEFF/, '')
        .trimEnd()
        .split('\r\n'),
    ).toHaveLength(1);
    expect(await lastExportCount()).toBe(0);
    await run(
      kit.env.DB,
      "UPDATE passes SET status = 'active', test_data_quarantined = 1 WHERE id = ?",
      [pass.id],
    );
    expect((await page(`?orgId=${kit.org.id}`)).items).toEqual([]);
    expect((await page('', apiKey)).items).toEqual([]);
    expect((await get(`/${row.id}`)).status).toBe(404);
    const quarantinedExport = await get(exportPath());
    expect(quarantinedExport.status).toBe(200);
    expect(
      (await quarantinedExport.text())
        .replace(/^\uFEFF/, '')
        .trimEnd()
        .split('\r\n'),
    ).toHaveLength(1);
    expect(await lastExportCount()).toBe(0);
  });
});
