import { describe, expect, it } from 'vitest';
import { makeOrg } from '../../../../test/helpers/index.ts';
import { first, run } from '../../platform/db.ts';
import { recordedCheckIn, recordedNoMatch } from './console-privacy-actions-test-fixtures.ts';
import {
  expectInvalidCursor,
  expectNoSecrets,
  exportPath,
  fake,
  get,
  HIDDEN,
  kit,
  lastExportCount,
  page,
  privatePass,
  type Row,
  seedScan,
  setupPrivacyKit,
  templateId,
  testAdmin,
} from './console-privacy-test-fixtures.ts';
import { DAY } from './test-kit.ts';

setupPrivacyKit();

describe('scan console and feed privacy', () => {
  it('retains unavailable-pass history as redacted rows while excluding cross-tenant and cross-mode references', async () => {
    const scanner = await kit.scanner({ templateIds: [templateId] });
    const testScanner = await kit.scanner({ templateIds: [templateId], mode: 'test' });
    const pass = await privatePass();
    const foreignOrg = await makeOrg(kit.fx);
    const foreignTemplate = await kit.scanTemplate(
      'Foreign card',
      { actions: [{ id: 'check_in', label: 'Check in', kind: 'check_in' }] },
      { orgId: foreignOrg.id },
    );
    const foreignScanner = await kit.scanner({
      orgId: foreignOrg.id,
      templateIds: [foreignTemplate],
    });
    const foreignPass = await kit.scanPass(
      foreignTemplate,
      { memberName: 'Foreign Guest' },
      {
        orgId: foreignOrg.id,
      },
    );
    const sandbox = await kit.scanPass(
      templateId,
      { memberName: 'Sandbox Guest' },
      { mode: 'test' },
    );

    const old = await recordedCheckIn(scanner, pass.id);
    const invalid: { id: string; at: number }[] = [];
    const badPass = async (name: string) =>
      kit.scanPass(templateId, { memberName: `Unavailable ${name}` });
    const quarantine = await badPass('quarantine');
    const quarantined = await recordedCheckIn(scanner, quarantine.id);
    await run(kit.env.DB, 'UPDATE passes SET test_data_quarantined = 1 WHERE id = ?', [
      quarantine.id,
    ]);
    const quarantineThenDelete = await badPass('quarantined-then-deleted');
    const quarantinedDeleted = await recordedCheckIn(scanner, quarantineThenDelete.id);
    await run(kit.env.DB, 'UPDATE passes SET test_data_quarantined = 1 WHERE id = ?', [
      quarantineThenDelete.id,
    ]);
    await run(kit.env.DB, 'DELETE FROM passes WHERE id = ?', [quarantineThenDelete.id]);
    const passless = await recordedNoMatch(scanner);
    const deleted = await badPass('deleted');
    const deletedRow = await recordedCheckIn(scanner, deleted.id);
    await run(kit.env.DB, 'UPDATE passes SET deleted_at = ? WHERE id = ?', [
      kit.clock.now(),
      deleted.id,
    ]);
    invalid.push(deletedRow);
    const newest = await recordedCheckIn(scanner, pass.id);

    const removed = await badPass('removed');
    const removedRow = await recordedCheckIn(scanner, removed.id);
    await run(kit.env.DB, 'UPDATE passes SET removed_at = ? WHERE id = ?', [
      kit.clock.now(),
      removed.id,
    ]);
    invalid.push(removedRow);
    const voided = await badPass('voided');
    const voidedRow = await recordedCheckIn(scanner, voided.id);
    await run(kit.env.DB, "UPDATE passes SET status = 'voided' WHERE id = ?", [voided.id]);
    invalid.push(voidedRow);
    const walletVoided = await badPass('wallet-voided');
    const walletVoidedRow = await recordedCheckIn(scanner, walletVoided.id);
    await run(
      kit.env.DB,
      "UPDATE pass_versions SET pass_json = json_set(pass_json, '$.voided', json('true')) WHERE pass_id = ?",
      [walletVoided.id],
    );
    invalid.push(walletVoidedRow);
    const expired = await badPass('expired');
    const expiredRow = await recordedCheckIn(scanner, expired.id);
    await run(
      kit.env.DB,
      "UPDATE pass_versions SET pass_json = json_set(pass_json, '$.expirationDate', ?) WHERE pass_id = ?",
      [new Date(kit.clock.now() - DAY).toISOString(), expired.id],
    );
    invalid.push(expiredRow);
    const invalidExpiry = await badPass('invalid-expiration');
    const invalidExpiryRow = await recordedCheckIn(scanner, invalidExpiry.id);
    await run(
      kit.env.DB,
      "UPDATE pass_versions SET pass_json = json_set(pass_json, '$.expirationDate', ?) WHERE pass_id = ?",
      ['not-a-date', invalidExpiry.id],
    );
    invalid.push(invalidExpiryRow);
    const invalidVoided = await badPass('invalid-voided');
    const invalidVoidedRow = await recordedCheckIn(scanner, invalidVoided.id);
    await run(
      kit.env.DB,
      "UPDATE pass_versions SET pass_json = json_set(pass_json, '$.voided', ?) WHERE pass_id = ?",
      ['true', invalidVoided.id],
    );
    invalid.push(invalidVoidedRow);
    const invalidJson = await badPass('invalid-json');
    const invalidJsonRow = await recordedCheckIn(scanner, invalidJson.id);
    await run(kit.env.DB, 'UPDATE pass_versions SET pass_json = ? WHERE pass_id = ?', [
      '{invalid-json',
      invalidJson.id,
    ]);
    invalid.push(invalidJsonRow);
    const nonObject = await badPass('non-object-json');
    const nonObjectRow = await recordedCheckIn(scanner, nonObject.id);
    await run(kit.env.DB, 'UPDATE pass_versions SET pass_json = ? WHERE pass_id = ?', [
      '[]',
      nonObject.id,
    ]);
    invalid.push(nonObjectRow);
    for (const [name, path, value] of [
      ['serial', '$.serialNumber', 'wrong-serial'],
      ['pass-type', '$.passTypeIdentifier', 'pass.other.example'],
      ['team', '$.teamIdentifier', 'OTHERTEAM'],
    ] as const) {
      const mismatch = await badPass(name);
      const mismatchRow = await recordedCheckIn(scanner, mismatch.id);
      await run(
        kit.env.DB,
        'UPDATE pass_versions SET pass_json = json_set(pass_json, ?, ?) WHERE pass_id = ?',
        [path, value, mismatch.id],
      );
      invalid.push(mismatchRow);
    }
    const nullSnapshot = await badPass('null-wallet');
    const nullSnapshotRow = await recordedCheckIn(scanner, nullSnapshot.id);
    await run(kit.env.DB, 'UPDATE pass_versions SET pass_json = NULL WHERE pass_id = ?', [
      nullSnapshot.id,
    ]);
    invalid.push(nullSnapshotRow);
    const missingSnapshot = await badPass('missing-wallet');
    const missingSnapshotRow = await recordedCheckIn(scanner, missingSnapshot.id);
    await run(kit.env.DB, 'DELETE FROM pass_versions WHERE pass_id = ?', [missingSnapshot.id]);
    invalid.push(missingSnapshotRow);
    const hardDeleted = await badPass('hard-deleted');
    const orphanedScan = await recordedCheckIn(scanner, hardDeleted.id);
    expect(
      await first(
        kit.env.DB,
        'SELECT excluded, invalidated FROM scan_retention_proofs WHERE scan_id = ?',
        [orphanedScan.id],
      ),
    ).toEqual({ excluded: 0, invalidated: 0 });
    await expect(
      run(kit.env.DB, 'UPDATE scan_retention_proofs SET mac = ? WHERE scan_id = ?', [
        '0'.repeat(64),
        orphanedScan.id,
      ]),
    ).rejects.toThrow();
    await expect(
      run(kit.env.DB, 'DELETE FROM scan_retention_proofs WHERE scan_id = ?', [orphanedScan.id]),
    ).rejects.toThrow();
    await run(kit.env.DB, 'DELETE FROM passes WHERE id = ?', [hardDeleted.id]);
    expect(
      await first(kit.env.DB, 'SELECT pass_id, template_id FROM scans WHERE id = ?', [
        orphanedScan.id,
      ]),
    ).toEqual({ pass_id: null, template_id: templateId });
    expect(
      await first(
        kit.env.DB,
        'SELECT excluded, invalidated FROM scan_retention_proofs WHERE scan_id = ?',
        [orphanedScan.id],
      ),
    ).toEqual({ excluded: 0, invalidated: 0 });
    invalid.push(orphanedScan);
    // A pre-migration orphan has no durable signed nonquarantine lineage.
    const unprovenOrphan = await seedScan({
      scanner,
      passId: null,
      templateId,
      actionId: 'check_in',
      actionKind: 'check_in',
      passVersion: 1,
    });
    await run(kit.env.DB, "UPDATE scans SET outcome = 'ok', reason = NULL WHERE id = ?", [
      unprovenOrphan.id,
    ]);
    const ambiguousPassless = await seedScan({ scanner, passId: null });
    await run(kit.env.DB, "UPDATE scans SET reason = 'ambiguous' WHERE id = ?", [
      ambiguousPassless.id,
    ]);
    const successfulPassless = await seedScan({ scanner, passId: null });
    await run(kit.env.DB, "UPDATE scans SET outcome = 'ok', reason = NULL WHERE id = ?", [
      successfulPassless.id,
    ]);
    const linkedPassless = await seedScan({ scanner, passId: null });
    await run(kit.env.DB, 'UPDATE scans SET override_of = ? WHERE id = ?', [
      unprovenOrphan.id,
      linkedPassless.id,
    ]);
    const untrustedPassless = [
      ambiguousPassless,
      successfulPassless,
      linkedPassless,
      await seedScan({ scanner, passId: null, actionId: 'check_in', actionKind: 'check_in' }),
      await seedScan({ scanner, passId: null, before: HIDDEN }),
      await seedScan({ scanner, passId: null, amount: 7 }),
      await seedScan({ scanner, passId: null, passVersion: 1 }),
    ];
    const crossScope = [
      await seedScan({ scanner, passId: sandbox.id }),
      await seedScan({ scanner, passId: foreignPass.id, templateId: foreignTemplate }),
    ];
    // More than the console's internal fetch size, all newer than the other rows.
    const bulkPrefix = kit.fx.ids.id();
    const bulkAt = kit.clock.advance(1000);
    await run(
      kit.env.DB,
      `WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 60)
       INSERT INTO scans
         (id, org_id, mode, pass_id, template_id, scanner_id, actor_type, actor_id, actor_key,
          idempotency_key, request_hash, method, state, outcome, action_id, action_kind, at)
       SELECT ? || '-' || i, ?, 'live', ?, ?, ?, 'scanner', ?, ?, ? || i,
              'seeded', 'camera', 'done', 'ok', 'check_in', 'check_in', ? FROM n`,
      [
        bulkPrefix,
        kit.org.id,
        deleted.id,
        templateId,
        scanner.id,
        scanner.id,
        `s:${scanner.id}`,
        `bulk:${bulkPrefix}:`,
        bulkAt,
      ],
    );
    invalid.push({ id: `${bulkPrefix}-1`, at: bulkAt }, { id: `${bulkPrefix}-60`, at: bulkAt });
    const sandboxRow = await recordedCheckIn(testScanner, sandbox.id);
    const foreignRow = await recordedCheckIn(foreignScanner, foreignPass.id);
    // Even a Test-mode ledger row cannot refer to a Live-mode pass.
    const badSandbox = await seedScan({ scanner: testScanner, passId: pass.id, mode: 'test' });

    const bulk = Array.from({ length: 60 }, (_, index) => ({
      id: `${bulkPrefix}-${index + 1}`,
      at: bulkAt,
    })).sort((a, b) => (a.id < b.id ? 1 : a.id > b.id ? -1 : 0));
    const ordinary = [old, passless, newest, ...invalid.filter((row) => row.at !== bulkAt)].sort(
      (a, b) => b.at - a.at,
    );
    const expected = [...bulk, ...ordinary];
    const expectedIds = expected.map((row) => row.id);
    const collected: Row[] = [];
    let cursor: string | null = null;
    do {
      const suffix = cursor ? `&cursor=${encodeURIComponent(cursor)}` : '';
      const result = await page(`?orgId=${kit.org.id}&limit=20${suffix}`);
      collected.push(...result.items);
      cursor = result.nextCursor;
    } while (cursor);
    expect(collected.map((item) => item.id)).toEqual(expectedIds);
    expectNoSecrets(collected, pass);
    expect((await page(`?orgId=${kit.org.id}`, testAdmin)).items.map((item) => item.id)).toEqual([
      sandboxRow.id,
    ]);
    for (const bad of invalid) {
      const detail = await get(`/${bad.id}`);
      expect(detail.status).toBe(200);
      expect(await detail.json()).toMatchObject({
        id: bad.id,
        passId: null,
        templateId: null,
        passTitle: null,
        kind: null,
        actionId: null,
        actionLabel: null,
        amount: null,
        before: null,
        after: null,
      });
    }
    for (const bad of [
      ...crossScope,
      quarantined,
      quarantinedDeleted,
      unprovenOrphan,
      ...untrustedPassless,
    ])
      expect((await get(`/${bad.id}`)).status).toBe(404);
    expect((await get(`/${badSandbox.id}`, testAdmin)).status).toBe(404);
    expect((await get(`/${sandboxRow.id}`)).status).toBe(404);
    expect((await get(`/${newest.id}`, testAdmin)).status).toBe(404);
    expect((await get(`/${passless.id}`)).status).toBe(200);

    const emptySearch = await page(`?orgId=${kit.org.id}&q=Public&limit=1`);
    expect(emptySearch.items).toEqual([]);
    if (!emptySearch.nextCursor)
      throw new Error('A bounded search must continue past hidden candidates.');
    await expectInvalidCursor(
      `?orgId=${kit.org.id}&q=Other&cursor=${encodeURIComponent(emptySearch.nextCursor)}`,
    );
    const firstSearch = await page(
      `?orgId=${kit.org.id}&q=Public&limit=1&cursor=${encodeURIComponent(emptySearch.nextCursor)}`,
    );
    expect(firstSearch.items.map((item) => item.id)).toEqual([newest.id]);
    if (!firstSearch.nextCursor) throw new Error('A second search page must have a continuation.');
    expect(firstSearch.nextCursor).not.toContain(newest.id);
    await expectInvalidCursor(
      `?orgId=${kit.org.id}&q=Other&cursor=${encodeURIComponent(firstSearch.nextCursor)}`,
    );
    const secondSearch = await page(
      `?orgId=${kit.org.id}&q=Public&limit=1&cursor=${encodeURIComponent(firstSearch.nextCursor)}`,
    );
    expect(secondSearch.items.map((item) => item.id)).toEqual([old.id]);
    expect(secondSearch.nextCursor).toBeNull();

    const liveKey = fake.apiKey({ orgId: kit.org.id, scopes: ['scans:read'] });
    const testKey = fake.apiKey({ orgId: kit.org.id, scopes: ['scans:read'], mode: 'test' });
    const keyFirst = await page('?limit=2', liveKey);
    expect(keyFirst.items.map((item) => item.id)).toEqual(expectedIds.slice(0, 2));
    if (!keyFirst.nextCursor) throw new Error('A second key page must have a continuation.');
    expect(keyFirst.nextCursor).not.toContain(expectedIds[1] ?? '');
    expect(
      (
        await page(`?limit=100&cursor=${encodeURIComponent(keyFirst.nextCursor)}`, liveKey)
      ).items.map((item) => item.id),
    ).toEqual(expectedIds.slice(2));
    expect((await page('', testKey)).items.map((item) => item.id)).toEqual([sandboxRow.id]);
    for (const id of [
      foreignRow.id,
      sandboxRow.id,
      crossScope[0]?.id,
      quarantined.id,
      quarantinedDeleted.id,
      unprovenOrphan.id,
      ...untrustedPassless.map((row) => row.id),
    ])
      await expectInvalidCursor(`?cursor=${id}`, liveKey);
    const badToken = `${keyFirst.nextCursor.slice(0, 4)}${keyFirst.nextCursor[4] === 'A' ? 'B' : 'A'}${keyFirst.nextCursor.slice(5)}`;
    await expectInvalidCursor(`?cursor=${encodeURIComponent(badToken)}`, liveKey);
    await expectInvalidCursor(`?cursor=${encodeURIComponent(keyFirst.nextCursor)}`, testKey);
    await expectInvalidCursor(
      `?passId=${pass.id}&cursor=${encodeURIComponent(keyFirst.nextCursor)}`,
      liveKey,
    );
    const spoofedMode = await page('?limit=100', { ...liveKey, 'x-passbook-mode': 'test' });
    expect(spoofedMode.items.map((item) => item.id)).toEqual(expectedIds);
    expect((await get(`?orgId=${foreignOrg.id}`, liveKey)).status).toBe(403);
    expectNoSecrets(keyFirst, pass);

    const response = await get(exportPath());
    expect(response.status).toBe(200);
    const csv = await response.text();
    expect(
      csv
        .replace(/^\uFEFF/, '')
        .trimEnd()
        .split('\r\n'),
    ).toHaveLength(expected.length + 1);
    for (const visible of expected) expect(csv).toContain(new Date(visible.at).toISOString());
    for (const hidden of [
      ...crossScope,
      quarantined,
      quarantinedDeleted,
      unprovenOrphan,
      ...untrustedPassless,
      sandboxRow,
      foreignRow,
      badSandbox,
    ])
      expect(csv).not.toContain(new Date(hidden.at).toISOString());
    expectNoSecrets(csv, pass);
    expect(await lastExportCount()).toBe(expected.length);

    const searchedExport = await get(exportPath('&q=Public'));
    expect(searchedExport.status).toBe(200);
    const searchedCsv = await searchedExport.text();
    expect(
      searchedCsv
        .replace(/^\uFEFF/, '')
        .trimEnd()
        .split('\r\n'),
    ).toHaveLength(3);
    expect(searchedCsv).toContain(new Date(newest.at).toISOString());
    expect(searchedCsv).toContain(new Date(old.at).toISOString());
    expect(searchedCsv).not.toContain(new Date(passless.at).toISOString());
    expectNoSecrets(searchedCsv, pass);
    expect(await lastExportCount()).toBe(2);
  }, 30_000);
});
