import { describe, expect, it } from 'vitest';
import { makeOrg, makePass, persistTemplate } from '../../../../test/helpers/index.ts';
import { first, run } from '../../platform/db.ts';
import { approveAppleRelease } from '../passes/apple-release-test-fixtures.ts';
import { ICON_PNG } from '../passes/pass-test-fixtures.ts';
import { recordedCheckIn, recordedNoMatch } from './console-privacy-actions-test-fixtures.ts';
import {
  expectInvalidCursor,
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
} from './console-privacy-test-fixtures.ts';
import { recordWalletVersion } from './repo-console-privacy-state-test-fixtures.ts';

setupPrivacyKit();

describe('scan console and feed privacy', () => {
  it('retains legacy and inactive-head history but excludes invalid release lineage before paging and export', async () => {
    const base = await kit.registry.resolve(templateId, 'v1');
    const makeTemplate = async (name: string) => {
      const template = kit.registry.add({
        id: kit.fx.ids.id(),
        orgId: kit.org.id,
        manifest: { ...base.manifest, name },
        passJson: base.passJson,
        assets: { 'icon.png': ICON_PNG },
      });
      await persistTemplate(kit.fx, template, { registry: kit.registry });
      return template;
    };
    const legacyScan = {
      actions: [
        { id: 'check_in', label: 'Check in', kind: 'check_in' as const, repeat: 'always' as const },
      ],
    };
    const donorId = await kit.scanTemplate('Legacy eligible card', legacyScan);
    const legacyPass = await kit.scanPass(donorId, { memberName: 'Legacy eligible card' });
    const missingId = await kit.scanTemplate('Legacy eligible card', legacyScan, {
      releaseModes: [],
    });
    const missing = await kit.registry.resolve(missingId);
    const donor = await kit.registry.resolve(donorId);
    expect(missing.manifest).toEqual(donor.manifest);
    expect(missing.passJson).toEqual(donor.passJson);
    await run(
      kit.env.DB,
      'UPDATE passes SET template_id = ?, template_version = ?, release_id = NULL WHERE id = ?',
      [missing.id, missing.version, legacyPass.id],
    );
    const wrongMode = await makeTemplate('Test-only release card');
    const wrongModeRelease = await approveAppleRelease(kit, {
      orgId: kit.org.id,
      mode: 'test',
      templateId: wrongMode.id,
      version: wrongMode.version,
    });
    const foreignOrg = await makeOrg(kit.fx);
    const foreign = kit.registry.add({
      id: kit.fx.ids.id(),
      orgId: null,
      manifest: { ...base.manifest, name: 'Foreign-only release card' },
      passJson: base.passJson,
      assets: { 'icon.png': ICON_PNG },
    });
    await persistTemplate(kit.fx, foreign, { registry: kit.registry });
    const foreignRelease = await approveAppleRelease(kit, {
      orgId: foreignOrg.id,
      mode: 'live',
      templateId: foreign.id,
      version: foreign.version,
    });
    const mismatchId = await kit.scanTemplate('Other same-org card', {
      actions: [{ id: 'check_in', label: 'Check in', kind: 'check_in' }],
    });
    const archivedId = await kit.scanTemplate('Archived release card', {
      actions: [{ id: 'check_in', label: 'Check in', kind: 'check_in' }],
    });
    const scanner = await kit.scanner({ templateIds: [templateId] });
    const archivedScanner = await kit.scanner({ templateIds: [archivedId] });
    const legacyScanner = await kit.scanner({ templateIds: [missing.id] });
    const pass = await privatePass();
    const old = await recordedCheckIn(scanner, pass.id);
    const approvedTampered = await recordedCheckIn(scanner, pass.id);
    expect(
      await run(
        kit.env.DB,
        "UPDATE pass_events SET data = json_set(data, '$.authority.eventProof.mac', ?) WHERE pass_id = ? AND json_extract(data, '$.scanId') = ?",
        ['0'.repeat(64), pass.id, approvedTampered.id],
      ),
    ).toEqual({ changes: 1 });
    const approvedMissingMac = await recordedCheckIn(scanner, pass.id);
    expect(
      await run(
        kit.env.DB,
        "UPDATE pass_events SET data = json_remove(data, '$.authority.eventProof.mac') WHERE pass_id = ? AND json_extract(data, '$.scanId') = ?",
        [pass.id, approvedMissingMac.id],
      ),
    ).toEqual({ changes: 1 });
    const approvedUnproven = await seedScan({
      scanner,
      passId: pass.id,
      passVersion: pass.version,
    });
    const passless = await recordedNoMatch(scanner);
    // The staged legacy pass keeps its genuinely issued Wallet snapshot while no scoped head exists.
    const legacy = await recordedCheckIn(legacyScanner, legacyPass.id);
    const legacyTampered = await recordedCheckIn(legacyScanner, legacyPass.id);
    expect(
      await run(
        kit.env.DB,
        "UPDATE pass_events SET data = json_set(data, '$.authority.eventProof.mac', ?) WHERE pass_id = ? AND json_extract(data, '$.scanId') = ?",
        ['0'.repeat(64), legacyPass.id, legacyTampered.id],
      ),
    ).toEqual({ changes: 1 });
    const legacyMissingMac = await recordedCheckIn(legacyScanner, legacyPass.id);
    expect(
      await run(
        kit.env.DB,
        "UPDATE pass_events SET data = json_remove(data, '$.authority.eventProof.mac') WHERE pass_id = ? AND json_extract(data, '$.scanId') = ?",
        [legacyPass.id, legacyMissingMac.id],
      ),
    ).toEqual({ changes: 1 });
    const legacyUnproven = await seedScan({
      scanner: legacyScanner,
      passId: legacyPass.id,
      templateId: missing.id,
      passVersion: 1,
    });
    const archivedPass = await kit.scanPass(archivedId, { memberName: 'Archived Issued Sentinel' });
    const archivedLegacyPass = await kit.scanPass(archivedId, {
      memberName: 'Archived Legacy Sentinel',
    });
    await run(kit.env.DB, 'UPDATE passes SET release_id = NULL WHERE id = ?', [
      archivedLegacyPass.id,
    ]);
    const archived = await recordedCheckIn(archivedScanner, archivedPass.id);
    const archivedLegacy = await recordedCheckIn(archivedScanner, archivedLegacyPass.id);
    await run(kit.env.DB, "UPDATE templates SET status = 'archived' WHERE id = ?", [archivedId]);
    const issued = await first<{ release_id: string | null }>(
      kit.env.DB,
      'SELECT release_id FROM passes WHERE id = ?',
      [pass.id],
    );
    if (!issued?.release_id)
      throw new Error('The issued pass must be pinned to its approved release.');
    const invalid: { id: string; at: number }[] = [];
    for (const [template, releaseId] of [
      [missing, issued.release_id],
      [wrongMode, wrongModeRelease.id],
      [foreign, foreignRelease.id],
    ] as const) {
      const unavailable = await makePass(kit.fx, {
        orgId: kit.org.id,
        template,
        personalization: { memberName: `Unavailable ${template.manifest.name}` },
      });
      await run(kit.env.DB, 'UPDATE passes SET release_id = ? WHERE id = ?', [
        releaseId,
        unavailable.id,
      ]);
      await recordWalletVersion(unavailable.id);
      invalid.push(await seedScan({ scanner, passId: unavailable.id, templateId: template.id }));
    }
    // This valid pass belongs to the org, but its scan falsely names another same-org template.
    const mismatch = await seedScan({ scanner, passId: pass.id, templateId: mismatchId });
    invalid.push(mismatch);

    const opaque = [
      archivedLegacy,
      archived,
      legacyUnproven,
      legacyMissingMac,
      legacyTampered,
      approvedUnproven,
      approvedMissingMac,
      approvedTampered,
    ];
    const expected = [
      archivedLegacy.id,
      archived.id,
      legacyUnproven.id,
      legacyMissingMac.id,
      legacyTampered.id,
      legacy.id,
      passless.id,
      approvedUnproven.id,
      approvedMissingMac.id,
      approvedTampered.id,
      old.id,
    ];
    let cursor: string | null = null;
    for (const [index, id] of expected.entries()) {
      const suffix = cursor ? `&cursor=${encodeURIComponent(cursor)}` : '';
      const result = await page(`?orgId=${kit.org.id}&limit=1${suffix}`);
      expect(result.items.map((item) => item.id)).toEqual([id]);
      if (opaque.some((row) => row.id === id)) {
        expect(result.items[0]).toMatchObject({
          passId: null,
          templateId: null,
          passTitle: null,
          kind: null,
          actionId: null,
          actionLabel: null,
          amount: null,
          passVersion: null,
          before: null,
          after: null,
          outcome: 'ok',
          reason: null,
        });
      }
      if (index < expected.length - 1) {
        expect(result.nextCursor).toEqual(expect.any(String));
        expect(result.nextCursor).not.toContain(id);
      } else expect(result.nextCursor).toBeNull();
      cursor = result.nextCursor;
    }
    const legacyDetail = await get(`/${legacy.id}`);
    expect(legacyDetail.status).toBe(200);
    expect(await legacyDetail.json()).toMatchObject({
      id: legacy.id,
      passTitle: 'Legacy eligible card',
    });
    for (const row of opaque) {
      const detail = await get(`/${row.id}`);
      expect(detail.status).toBe(200);
      expect(await detail.json()).toMatchObject({
        id: row.id,
        passId: null,
        templateId: null,
        passTitle: null,
        kind: null,
        actionId: null,
        actionLabel: null,
        amount: null,
        passVersion: null,
        before: null,
        after: null,
        outcome: 'ok',
        reason: null,
      });
    }
    const apiKey = fake.apiKey({ orgId: kit.org.id, scopes: ['scans:read'] });
    const feed = await page('', apiKey);
    expect(feed.items.map((item) => item.id)).toEqual(expected);
    for (const row of opaque) {
      expect(feed.items.find((item) => item.id === row.id)).toMatchObject({
        passId: null,
        templateId: null,
        kind: null,
        actionId: null,
        amount: null,
        before: null,
        after: null,
        outcome: 'ok',
        reason: null,
      });
    }
    for (const row of invalid) expect((await get(`/${row.id}`)).status).toBe(404);
    const response = await get(exportPath());
    expect(response.status).toBe(200);
    const csv = await response.text();
    expect(
      csv
        .replace(/^\uFEFF/, '')
        .trimEnd()
        .split('\r\n'),
    ).toHaveLength(expected.length + 1);
    expect(csv).toContain(new Date(old.at).toISOString());
    expect(csv).toContain(new Date(passless.at).toISOString());
    expect(csv).toContain(new Date(approvedTampered.at).toISOString());
    expect(csv).toContain(new Date(approvedUnproven.at).toISOString());
    expect(csv).toContain(new Date(approvedMissingMac.at).toISOString());
    expect(csv).toContain(new Date(legacy.at).toISOString());
    expect(csv).toContain(new Date(legacyTampered.at).toISOString());
    expect(csv).toContain(new Date(legacyMissingMac.at).toISOString());
    expect(csv).toContain(new Date(legacyUnproven.at).toISOString());
    expect(csv).toContain(new Date(archived.at).toISOString());
    expect(csv).toContain(new Date(archivedLegacy.at).toISOString());
    expect(csv).not.toContain(new Date(mismatch.at).toISOString());
    for (const row of [
      archived,
      archivedLegacy,
      legacyTampered,
      legacyMissingMac,
      legacyUnproven,
      approvedTampered,
      approvedMissingMac,
      approvedUnproven,
    ]) {
      const line = csv.split('\r\n').find((item) => item.includes(new Date(row.at).toISOString()));
      expect(line).toBeDefined();
      expect(line).not.toContain('Check in');
      expect(line).not.toContain('Archived');
      expect(line).not.toContain('Legacy eligible card');
      expect(line).not.toContain(PUBLIC);
    }
    for (const row of invalid) expect(csv).not.toContain(new Date(row.at).toISOString());
    expect(csv).not.toContain('Unavailable');
    expect(csv).not.toContain('Archived Issued Sentinel');
    expect(csv).not.toContain('Archived Legacy Sentinel');
    expectNoSecrets(csv, pass);
    expect(await lastExportCount()).toBe(expected.length);
    const filtered = await page(`?orgId=${kit.org.id}&passId=${pass.id}&limit=1`);
    expect(filtered.items.map((item) => item.id)).toEqual([old.id]);
    expect(filtered.nextCursor).toBeNull();
    const keyFiltered = await page(`?passId=${pass.id}&limit=1`, apiKey);
    expect(keyFiltered.items.map((item) => item.id)).toEqual([old.id]);
    expect(keyFiltered.nextCursor).toBeNull();
    for (const hidden of [mismatch, approvedTampered, approvedMissingMac, approvedUnproven]) {
      await expectInvalidCursor(`?orgId=${kit.org.id}&passId=${pass.id}&cursor=${hidden.id}`);
      await expectInvalidCursor(`?passId=${pass.id}&cursor=${hidden.id}`, apiKey);
    }
    const filteredExport = await get(exportPath(`&passId=${pass.id}`));
    expect(filteredExport.status).toBe(200);
    const filteredCsv = await filteredExport.text();
    expect(
      filteredCsv
        .replace(/^\uFEFF/, '')
        .trimEnd()
        .split('\r\n'),
    ).toHaveLength(2);
    expect(filteredCsv).toContain(new Date(old.at).toISOString());
    expect(filteredCsv).not.toContain(new Date(mismatch.at).toISOString());
    expect(filteredCsv).not.toContain(new Date(approvedTampered.at).toISOString());
    expect(filteredCsv).not.toContain(new Date(approvedUnproven.at).toISOString());
    expect(filteredCsv).not.toContain(new Date(approvedMissingMac.at).toISOString());
    expect(await lastExportCount()).toBe(1);
    const legacyFiltered = await page(`?orgId=${kit.org.id}&passId=${legacyPass.id}&limit=1`);
    expect(legacyFiltered.items.map((item) => item.id)).toEqual([legacy.id]);
    expect(legacyFiltered.nextCursor).toBeNull();
    const legacyKeyFiltered = await page(`?passId=${legacyPass.id}&limit=1`, apiKey);
    expect(legacyKeyFiltered.items.map((item) => item.id)).toEqual([legacy.id]);
    expect(legacyKeyFiltered.nextCursor).toBeNull();
    for (const hidden of [legacyTampered, legacyMissingMac, legacyUnproven]) {
      await expectInvalidCursor(`?orgId=${kit.org.id}&passId=${legacyPass.id}&cursor=${hidden.id}`);
      await expectInvalidCursor(`?passId=${legacyPass.id}&cursor=${hidden.id}`, apiKey);
    }
    const legacyExport = await get(exportPath(`&passId=${legacyPass.id}`));
    expect(legacyExport.status).toBe(200);
    const legacyCsv = await legacyExport.text();
    expect(
      legacyCsv
        .replace(/^\uFEFF/, '')
        .trimEnd()
        .split('\r\n'),
    ).toHaveLength(2);
    expect(legacyCsv).toContain(new Date(legacy.at).toISOString());
    expect(await lastExportCount()).toBe(1);
    for (const value of ['Archived Issued Sentinel', 'Archived Legacy Sentinel']) {
      const query = encodeURIComponent(value);
      expect((await page(`?orgId=${kit.org.id}&q=${query}`)).items).toEqual([]);
      const searched = await get(exportPath(`&q=${query}`));
      expect(searched.status).toBe(200);
      expect(
        (await searched.text())
          .replace(/^\uFEFF/, '')
          .trimEnd()
          .split('\r\n'),
      ).toHaveLength(1);
      expect(await lastExportCount()).toBe(0);
    }
  });
});
