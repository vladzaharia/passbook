import { describe, expect, it } from 'vitest';
import { makeOrg, makeSession, makeUser } from '../../../../test/helpers/index.ts';
import { type ScanOutcome, ScanOutcomeSchema } from '../../../shared/contracts/scan.ts';
import { normalizeLookup } from '../../../shared/scan-lookup.ts';
import { first, run } from '../../platform/db.ts';
import { sha256Hex } from '../../platform/ids.ts';
import {
  app,
  exportPath,
  fake,
  get,
  kit,
  lastExportCount,
  page,
  seedScan,
  setupPrivacyKit,
  templateId,
} from './console-privacy-test-fixtures.ts';
import { grantScanMembership, key, ORIGIN } from './test-kit.ts';

setupPrivacyKit();

describe('scan console and feed privacy', () => {
  it('shows passState on a redacted row, as it shows reason (OC4)', async () => {
    const scanner = await kit.scanner({ templateIds: [templateId] });
    const row = await seedScan({ scanner, passId: null });
    await run(kit.env.DB, "UPDATE scans SET pass_state = 'voided' WHERE id = ?", [row.id]);
    const history = await page(`?orgId=${kit.org.id}`);
    expect(history.items.find((i) => i.id === row.id)).toMatchObject({
      passId: null,
      passState: 'voided',
    });
  });

  it('retains a strictly passless unsigned legacy no-event no-match only as a minimal row', async () => {
    const scanner = await kit.scanner({ templateIds: [templateId] });
    const legacy = await seedScan({ scanner, passId: null });
    const own = (path: string) =>
      app.request(`${ORIGIN}/api/v1/scan${path}`, { headers: scanner.headers }, kit.env);
    // The device's own history is fenced to rows naming the device.
    expect(await (await own('/scans?limit=10')).json()).toMatchObject({
      items: [{ scanId: legacy.id, outcome: 'refused', reason: 'not_found', title: null }],
    });
    await run(kit.env.DB, 'UPDATE scans SET scanner_id = NULL WHERE id = ?', [legacy.id]);
    const history = await page(`?orgId=${kit.org.id}`);
    expect(history.items).toHaveLength(1);
    const minimal = {
      id: legacy.id,
      passId: null,
      templateId: null,
      eventId: null,
      passTitle: null,
      actionId: null,
      kind: null,
      reason: 'not_found',
      scannerId: null,
      staffId: null,
      scannerName: null,
      staffName: null,
      actor: { type: 'scanner', id: scanner.id },
    };
    expect(history.items[0]).toMatchObject(minimal);
    const detail = await get(`/${legacy.id}`);
    expect(detail.status).toBe(200);
    expect(await detail.json()).toMatchObject(minimal);
    const apiKey = fake.apiKey({ orgId: kit.org.id, scopes: ['scans:read'] });
    const feed = await page('', apiKey);
    expect(feed.items).toHaveLength(1);
    expect(feed.items[0]).toMatchObject({
      id: legacy.id,
      passId: null,
      eventId: null,
      scannerId: null,
    });
    expect(feed.items[0]).not.toHaveProperty('staffId');
    const exported = await get(exportPath());
    expect(exported.status).toBe(200);
    expect(
      (await exported.text())
        .replace(/^\uFEFF/, '')
        .trimEnd()
        .split('\r\n'),
    ).toHaveLength(2);
    expect(await lastExportCount()).toBe(1);
    // Without its scanner reference the row stays console history but leaves the device's own.
    const recent = await own('/scans?limit=10');
    expect(recent.status).toBe(200);
    expect(await recent.json()).toMatchObject({ items: [] });
    const summary = await own('/summary');
    expect(summary.status).toBe(200);
    expect(await summary.json()).toMatchObject({ total: 0, refused: 0, byAction: [] });
  });

  it('shows scanner and staff names on a passless refusal only to members who can read the log', async () => {
    const staff = await kit.staff('manager');
    const scanner = await kit.scanner({
      templateIds: [templateId],
      staffId: staff.id,
      settings: { staffSignIn: true },
    });
    const response = await kit.post(scanner.headers, '/actions', {
      idempotencyKey: key(),
      input: { code: 'NO-SUCH-PASS-NAMES', method: 'camera' },
      clientTs: kit.clock.now(),
      actionId: 'check_in',
    });
    const outcome: ScanOutcome = await response.json();
    if (!outcome.scanId) throw new Error('A stored refusal must have a scan id.');
    const scannerName = (
      await first<{ name: string }>(kit.env.DB, 'SELECT name FROM scanners WHERE id = ?', [
        scanner.id,
      ])
    )?.name;
    const viewer = async (orgId: string, roles: Parameters<typeof grantScanMembership>[3]) => {
      const user = await makeUser(kit.fx);
      await grantScanMembership(kit.fx, orgId, user.id, roles);
      return {
        ...(await makeSession(kit.fx, { userId: user.id, roles: ['user'] })).headers,
        origin: ORIGIN,
      };
    };
    const names = JSON.stringify([scannerName, staff.name]);
    // A log reader of the same organization (read_only holds scanning:read and passes:read) sees
    // what the Devices and Staff tabs already show them.
    const reader = await viewer(kit.org.id, ['read_only']);
    const read = await page(`?orgId=${kit.org.id}`, reader);
    expect(read.items[0]).toMatchObject({ id: outcome.scanId, scannerName, staffName: staff.name });
    expect(names).toContain(staff.name);
    // No passes:read: the log is refused, with no names in the body.
    const author = await viewer(kit.org.id, ['template_author']);
    const refused = await get(`?orgId=${kit.org.id}`, author);
    expect(refused.status).toBe(403);
    const refusedText = await refused.text();
    expect(refusedText).not.toContain(staff.name);
    expect(refusedText).not.toContain(scannerName ?? 'unreachable');
    // Another organization's member cannot reach the rows at all.
    const other = await makeOrg(kit.fx);
    const foreign = await viewer(other.id, ['org_admin']);
    for (const path of [`?orgId=${kit.org.id}`, `/${outcome.scanId}`]) {
      const denied = await get(path, foreign);
      const text = await denied.text();
      // A foreign tenant sees an empty page or a not-found, never the row.
      expect(text).not.toContain(outcome.scanId);
      expect(text).not.toContain(staff.name);
      expect(text).not.toContain(scannerName ?? 'unreachable');
    }
    const exported = await get(exportPath(), foreign);
    expect(await exported.text()).not.toContain(staff.name);
  });

  it('retains event-scoped no-match and ambiguous refusals after archival and deletion', async () => {
    const event = await kit.event({ templateIds: [templateId] });
    const staff = await kit.staff('manager');
    const scanner = await kit.scanner({
      eventId: event.id,
      templateIds: [templateId],
      staffId: staff.id,
      settings: { staffSignIn: true },
    });
    const input = 'EVENT-NO-MATCH-SENTINEL-7182';
    const response = await kit.post(scanner.headers, '/actions', {
      idempotencyKey: key(),
      input: { code: input, method: 'camera' },
      clientTs: kit.clock.now(),
      actionId: 'check_in',
    });
    expect(response.status).toBe(200);
    const outcome: ScanOutcome = await response.json();
    ScanOutcomeSchema.parse(outcome);
    expect(outcome).toMatchObject({ kind: 'refused', reason: 'not_found', replay: false });
    if (!outcome.scanId) throw new Error('A stored refusal must have a scan id.');
    const matching = [
      await kit.scanPass(templateId, { memberName: 'First ambiguous guest' }),
      await kit.scanPass(templateId, { memberName: 'Second ambiguous guest' }),
    ];
    const ambiguousInput = 'EVENT-AMBIGUOUS-7193';
    const lookupHash = await sha256Hex(normalizeLookup(ambiguousInput));
    for (const candidate of matching)
      await run(kit.env.DB, 'UPDATE passes SET lookup_hash = ? WHERE id = ?', [
        lookupHash,
        candidate.id,
      ]);
    kit.clock.advance(1000);
    const ambiguousResponse = await kit.post(scanner.headers, '/actions', {
      idempotencyKey: key(),
      input: { code: ambiguousInput, method: 'wedge' },
      clientTs: kit.clock.now(),
      actionId: 'check_in',
    });
    expect(ambiguousResponse.status).toBe(200);
    const ambiguous: ScanOutcome = await ambiguousResponse.json();
    ScanOutcomeSchema.parse(ambiguous);
    expect(ambiguous).toMatchObject({ kind: 'refused', reason: 'ambiguous', replay: false });
    if (!ambiguous.scanId) throw new Error('An ambiguous refusal must have a scan id.');
    for (const candidate of matching) expect(JSON.stringify(ambiguous)).not.toContain(candidate.id);
    const apiKey = fake.apiKey({ orgId: kit.org.id, scopes: ['scans:read'] });

    for (const state of ['active', 'archived', 'deleted'] as const) {
      if (state === 'archived')
        await run(kit.env.DB, 'UPDATE scan_events SET archived_at = ? WHERE id = ?', [
          kit.clock.now(),
          event.id,
        ]);
      if (state === 'deleted')
        await run(kit.env.DB, 'DELETE FROM scan_events WHERE id = ?', [event.id]);
      const history = await page(`?orgId=${kit.org.id}`);
      expect(history.items.map((item) => item.id)).toEqual([ambiguous.scanId, outcome.scanId]);
      expect(history.items[0]).toMatchObject({
        passId: null,
        passTitle: null,
        kind: null,
        reason: 'ambiguous',
      });
      expect(history.items[1]).toMatchObject({
        passId: null,
        passTitle: null,
        kind: null,
        reason: 'not_found',
      });
      const detail = await get(`/${outcome.scanId}`);
      expect(detail.status).toBe(200);
      const detailData = await detail.json();
      expect(detailData).toMatchObject({ passId: null, passTitle: null, reason: 'not_found' });
      const ambiguousDetail = await get(`/${ambiguous.scanId}`);
      expect(ambiguousDetail.status).toBe(200);
      const ambiguousDetailData = await ambiguousDetail.json();
      expect(ambiguousDetailData).toMatchObject({
        passId: null,
        passTitle: null,
        reason: 'ambiguous',
      });
      const keyFeed = await page('', apiKey);
      expect(keyFeed.items.map((item) => item.id)).toEqual([ambiguous.scanId, outcome.scanId]);
      const eventId = state === 'active' ? event.id : null;
      const scannerName = (
        await first<{ name: string }>(kit.env.DB, 'SELECT name FROM scanners WHERE id = ?', [
          scanner.id,
        ])
      )?.name;
      for (const item of history.items)
        expect(item).toMatchObject({
          eventId,
          actor: { type: 'scanner', id: scanner.id },
          scannerId: scanner.id,
          scannerName: scannerName,
          staffId: staff.id,
          staffName: staff.name,
        });
      for (const item of keyFeed.items) {
        expect(item).toMatchObject({ eventId, scannerId: scanner.id, scannerName: null });
        expect(item).not.toHaveProperty('staffId');
      }
      for (const item of [detailData, ambiguousDetailData])
        expect(item).toMatchObject({
          eventId,
          actor: { type: 'scanner', id: scanner.id },
          scannerId: scanner.id,
          scannerName: scannerName,
          staffId: staff.id,
          staffName: staff.name,
        });
      const filteredIds = state === 'active' ? [ambiguous.scanId, outcome.scanId] : [];
      expect(
        (await page(`?orgId=${kit.org.id}&eventId=${event.id}`)).items.map((item) => item.id),
      ).toEqual(filteredIds);
      expect((await page(`?eventId=${event.id}`, apiKey)).items.map((item) => item.id)).toEqual(
        filteredIds,
      );
      expect(
        (await page(`?orgId=${kit.org.id}&scannerId=${scanner.id}`)).items.map((item) => item.id),
      ).toEqual([ambiguous.scanId, outcome.scanId]);
      expect(
        (await page(`?orgId=${kit.org.id}&staffId=${staff.id}`)).items.map((item) => item.id),
      ).toEqual([ambiguous.scanId, outcome.scanId]);
      const exported = await get(exportPath());
      expect(exported.status).toBe(200);
      const csv = await exported.text();
      expect(
        csv
          .replace(/^\uFEFF/, '')
          .trimEnd()
          .split('\r\n'),
      ).toHaveLength(3);
      for (const value of [input, ambiguousInput, ...matching.map((candidate) => candidate.id)])
        expect(csv).not.toContain(value);
      expect(await lastExportCount()).toBe(2);
      if (state !== 'active') {
        const filtered = await get(exportPath(`&eventId=${event.id}`));
        expect(filtered.status).toBe(200);
        expect(
          (await filtered.text())
            .replace(/^\uFEFF/, '')
            .trimEnd()
            .split('\r\n'),
        ).toHaveLength(1);
        expect(await lastExportCount()).toBe(0);
      }
    }
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
    expect(await summary.json()).toMatchObject({ total: 0, refused: 0, byAction: [] });

    await run(kit.env.DB, 'DELETE FROM scan_staff WHERE id = ?', [staff.id]);
    const withoutStaff = await page(`?orgId=${kit.org.id}`);
    expect(withoutStaff.items).toHaveLength(2);
    for (const item of withoutStaff.items)
      expect(item).toMatchObject({
        actor: { type: 'scanner', id: scanner.id },
        scannerId: scanner.id,
        staffId: null,
      });
    await run(kit.env.DB, 'DELETE FROM scanners WHERE id = ?', [scanner.id]);
    const withoutScanner = await page(`?orgId=${kit.org.id}`);
    expect(withoutScanner.items).toHaveLength(2);
    for (const item of withoutScanner.items)
      expect(item).toMatchObject({
        actor: { type: 'scanner', id: scanner.id },
        scannerId: null,
        staffId: null,
      });
    for (const item of (await page('', apiKey)).items) {
      expect(item).toMatchObject({ scannerId: null });
      expect(item).not.toHaveProperty('staffId');
    }
  });
});
