import { beforeAll, describe, expect, it } from 'vitest';
import { makePass, persistTemplate } from '../../../../test/helpers/index.ts';
import { first, run } from '../../platform/db.ts';
import { approveAppleRelease } from '../passes/apple-release-test-fixtures.ts';
import { ICON_PNG } from '../passes/pass-test-fixtures.ts';
import {
  scanningSessionRow,
  scanningSessionStats,
  scanningSessionTodayStmt,
} from './repo-scanning-sessions.ts';
import {
  ACTION,
  SINCE,
  sessionCountScopeFixture,
} from './repo-session-count-scope-test-fixtures.ts';
import { sessionDto } from './scanning-session-dto.ts';

const scope = sessionCountScopeFixture();
beforeAll(scope.setup);

describe('managed scanning session count scope', () => {
  it('counts only current-session, same-org and same-mode successes without inflating device presence', async () => {
    const {
      kit,
      templateId,
      foreignOrgId,
      foreignTemplateId,
      workspace,
      attach,
      record,
      expectCounts,
      countAuthority,
    } = scope;
    const event = await kit.event({ templateIds: [templateId] });
    const online = await kit.scanner({ eventId: event.id });
    const sessionId = await workspace(online, event.id);
    const offline = await kit.scanner({ eventId: event.id, lastSeenAt: kit.clock.now() - 120_001 });
    await attach(offline, sessionId);
    const revoked = await kit.scanner({ eventId: event.id, revoked: true });
    await attach(revoked, sessionId);
    const otherSessionDevice = await kit.scanner({ eventId: event.id });
    await workspace(otherSessionDevice, event.id);
    const wrongModeDevice = await kit.scanner({ mode: 'test' });
    await attach(wrongModeDevice, sessionId);
    const wrongScannerMode = await kit.scanner({ mode: 'test' });
    await attach(wrongScannerMode, sessionId, 'live');
    const wrongDeviceMode = await kit.scanner();
    await attach(wrongDeviceMode, sessionId, 'test');

    const live = await kit.scanPass(templateId);
    const test = await kit.scanPass(templateId, {}, { mode: 'test' });
    const foreign = await kit.scanPass(foreignTemplateId, {}, { orgId: foreignOrgId });
    const foreignEvent = await kit.event({ orgId: foreignOrgId, templateIds: [foreignTemplateId] });
    const foreignScanner = await kit.scanner({ orgId: foreignOrgId, eventId: foreignEvent.id });
    const foreignSession = await workspace(foreignScanner, foreignEvent.id);
    await record(foreignScanner.id, foreign.id, {
      orgId: foreignOrgId,
      templateId: foreignTemplateId,
    });
    const foreignRow = await scanningSessionRow(kit.env.DB, foreignOrgId, foreignSession);
    if (!foreignRow) throw new Error('Missing foreign scanning session');
    const foreignStats = await scanningSessionStats(
      kit.env.DB,
      foreignRow,
      SINCE,
      kit.clock.now() - 120_000,
      await countAuthority(foreignOrgId),
      kit.clock.now(),
    );
    const foreignToday = await scanningSessionTodayStmt(
      kit.env.DB,
      foreignOrgId,
      foreignSession,
      'live',
      SINCE,
    ).first<{ n: number }>();
    expect(foreignStats).toEqual({ devices: 1, online: 1, today: 1 });
    expect(foreignToday).toEqual({ n: 1 });
    expect(foreignStats?.today).toBe(foreignToday?.n);
    const testEvent = await kit.event({ mode: 'test', templateIds: [templateId] });
    const testScanner = await kit.scanner({ mode: 'test', eventId: testEvent.id });
    const testSession = await workspace(testScanner, testEvent.id);
    await record(testScanner.id, test.id, { mode: 'test' });
    await expectCounts(testSession, 1, 1, 1, 'test');
    await record(online.id, live.id, { at: SINCE });
    await record(offline.id, live.id);
    await expectCounts(sessionId, 2, 2, 1);

    await record(online.id, foreign.id, { orgId: foreignOrgId, templateId: foreignTemplateId });
    await expectCounts(sessionId, 2, 2, 1);
    await record(online.id, test.id, { mode: 'test' });
    await expectCounts(sessionId, 2, 2, 1);
    await record(otherSessionDevice.id, live.id);
    await expectCounts(sessionId, 2, 2, 1);
    await record(wrongModeDevice.id, test.id, { mode: 'test' });
    await expectCounts(sessionId, 2, 2, 1);
    await record(wrongScannerMode.id, live.id);
    await expectCounts(sessionId, 2, 2, 1);
    await record(wrongDeviceMode.id, live.id);
    await expectCounts(sessionId, 2, 2, 1);

    await record(online.id, live.id, { undoneBy: kit.fx.ids.id() });
    await expectCounts(sessionId, 2, 2, 1);
    await record(online.id, live.id, { actionKind: 'undo' });
    await expectCounts(sessionId, 2, 2, 1);
    await record(online.id, live.id, { outcome: 'heads_up' });
    await expectCounts(sessionId, 2, 2, 1);
    await record(online.id, live.id, { outcome: 'refused' });
    await expectCounts(sessionId, 2, 2, 1);
    await record(online.id, live.id, { state: 'pending' });
    await expectCounts(sessionId, 2, 2, 1);
    await record(online.id, live.id, { state: 'failed' });
    await expectCounts(sessionId, 2, 2, 1);
    await record(online.id, live.id, { at: SINCE - 1 });
    await expectCounts(sessionId, 2, 2, 1);

    const row = await scanningSessionRow(kit.env.DB, kit.org.id, sessionId);
    if (!row) throw new Error('Missing scanning session');
    expect(
      await scanningSessionStats(
        kit.env.DB,
        { ...row, org_id: foreignOrgId },
        SINCE,
        SINCE,
        await countAuthority(foreignOrgId),
        kit.clock.now(),
      ),
    ).toBeNull();
    expect(
      await scanningSessionTodayStmt(kit.env.DB, foreignOrgId, sessionId, 'live', SINCE).first(),
    ).toEqual({ n: 0 });
    expect(
      await scanningSessionStats(
        kit.env.DB,
        { ...row, mode: 'test' },
        SINCE,
        SINCE,
        await countAuthority(kit.org.id, 'test'),
        kit.clock.now(),
      ),
    ).toBeNull();
    expect(
      await scanningSessionTodayStmt(kit.env.DB, kit.org.id, sessionId, 'test', SINCE).first(),
    ).toEqual({ n: 0 });
  });

  it('enforces actor and reference scope even for otherwise countable successes', async () => {
    const { kit, templateId, foreignOrgId, foreignTemplateId, workspace, record, expectCounts } =
      scope;
    const event = await kit.event({ templateIds: [templateId] });
    const scanner = await kit.scanner({ eventId: event.id });
    const sessionId = await workspace(scanner, event.id);
    const foreignEvent = await kit.event({ orgId: foreignOrgId, templateIds: [foreignTemplateId] });
    const foreignScanner = await kit.scanner({ orgId: foreignOrgId, eventId: foreignEvent.id });
    const localPass = await kit.scanPass(templateId);
    const foreignPass = await kit.scanPass(foreignTemplateId, {}, { orgId: foreignOrgId });

    await record(scanner.id, localPass.id);
    await record(scanner.id, localPass.id, { actorId: foreignScanner.id });
    await expectCounts(sessionId, 1, 1, 1);
    await record(scanner.id, localPass.id, { actorId: kit.fx.ids.id() });
    await expectCounts(sessionId, 2, 1, 1);

    const foreignEventScan = await record(scanner.id, localPass.id);
    await expectCounts(sessionId, 3, 1, 1);
    await run(kit.env.DB, 'UPDATE scans SET event_id=? WHERE id=?', [
      foreignEvent.id,
      foreignEventScan,
    ]);
    await expectCounts(sessionId, 2, 1, 1);

    const foreignScan = await record(foreignScanner.id, foreignPass.id, {
      orgId: foreignOrgId,
      templateId: foreignTemplateId,
    });
    const foreignLink = await record(scanner.id, localPass.id);
    await expectCounts(sessionId, 3, 1, 1);
    await run(kit.env.DB, 'UPDATE scans SET override_of=? WHERE id=?', [foreignScan, foreignLink]);
    await expectCounts(sessionId, 2, 1, 1);

    const otherPass = await kit.scanPass(templateId);
    const otherPassScan = await record(scanner.id, otherPass.id);
    const crossPassLink = await record(scanner.id, localPass.id);
    await expectCounts(sessionId, 4, 1, 1);
    await run(kit.env.DB, 'UPDATE scans SET override_of=? WHERE id=?', [
      otherPassScan,
      crossPassLink,
    ]);
    await expectCounts(sessionId, 3, 1, 1);
  });

  it('keeps historical scans after revocation without counting the device as present', async () => {
    const { kit, templateId, workspace, record, expectCounts } = scope;
    const event = await kit.event({ templateIds: [templateId] });
    const scanner = await kit.scanner({ eventId: event.id });
    const sessionId = await workspace(scanner, event.id);
    const pass = await kit.scanPass(templateId);
    await record(scanner.id, pass.id);
    await expectCounts(sessionId, 1, 1, 1);
    await run(kit.env.DB, 'UPDATE scanners SET revoked_at=? WHERE id=?', [
      kit.clock.now(),
      scanner.id,
    ]);
    await expectCounts(sessionId, 1, 0, 0);
  });

  it('requires a same-scope nonquarantined pass with valid issuance, while retaining legacy passes', async () => {
    const {
      kit,
      templateId,
      foreignOrgId,
      foreignTemplateId,
      workspace,
      record,
      expectCounts,
      releaseOf,
    } = scope;
    const event = await kit.event({ templateIds: [templateId] });
    const scanner = await kit.scanner({ eventId: event.id });
    const sessionId = await workspace(scanner, event.id);
    const issued = await kit.scanPass(templateId);
    await record(scanner.id, issued.id);
    await expectCounts(sessionId, 1, 1, 1);

    const legacy = await makePass(kit.fx, {
      orgId: kit.org.id,
      template: await kit.registry.resolve(templateId),
    });
    expect(
      await first(kit.env.DB, 'SELECT release_id FROM passes WHERE id=?', [legacy.id]),
    ).toEqual({ release_id: null });
    await record(scanner.id, legacy.id);
    await expectCounts(sessionId, 2, 1, 1);

    const wrongTemplate = await kit.scanPass(templateId);
    const unrelatedTemplate = await kit.scanTemplate('Unrelated issuance', { actions: [ACTION] });
    const unrelated = await kit.scanPass(unrelatedTemplate);
    await run(kit.env.DB, 'UPDATE passes SET release_id=? WHERE id=?', [
      await releaseOf(unrelated.id),
      wrongTemplate.id,
    ]);
    await record(scanner.id, wrongTemplate.id);
    await expectCounts(sessionId, 2, 1, 1);

    const wrongMode = await kit.scanPass(templateId);
    const testPass = await kit.scanPass(templateId, {}, { mode: 'test' });
    await run(kit.env.DB, 'UPDATE passes SET release_id=? WHERE id=?', [
      await releaseOf(testPass.id),
      wrongMode.id,
    ]);
    await record(scanner.id, wrongMode.id);
    await expectCounts(sessionId, 2, 1, 1);

    const shared = kit.registry.add({
      id: `session-count-shared-${kit.fx.ids.token(6)}`,
      orgId: null,
      manifest: { ...kit.template.manifest, name: 'Shared issuance', scan: { actions: [ACTION] } },
      passJson: kit.template.passJson,
      assets: { 'icon.png': ICON_PNG },
    });
    await persistTemplate(kit.fx, shared, { registry: kit.registry });
    for (const orgId of [kit.org.id, foreignOrgId]) {
      await approveAppleRelease(kit, {
        orgId,
        templateId: shared.id,
        version: shared.version,
        mode: 'live',
      });
    }
    const wrongOrg = await kit.scanPass(shared.id);
    const foreignRelease = await first<{ id: string }>(
      kit.env.DB,
      "SELECT id FROM template_releases WHERE template_id=? AND org_id=? AND mode='live' AND provider='apple'",
      [shared.id, foreignOrgId],
    );
    if (!foreignRelease) throw new Error('Missing foreign scoped release');
    await run(kit.env.DB, 'UPDATE passes SET release_id=? WHERE id=?', [
      foreignRelease.id,
      wrongOrg.id,
    ]);
    await record(scanner.id, wrongOrg.id, { templateId: shared.id });
    await expectCounts(sessionId, 2, 1, 1);

    const foreignPass = await kit.scanPass(foreignTemplateId, {}, { orgId: foreignOrgId });
    await record(scanner.id, foreignPass.id, { templateId: foreignTemplateId });
    await expectCounts(sessionId, 2, 1, 1);
    await record(scanner.id, testPass.id);
    await expectCounts(sessionId, 2, 1, 1);

    const quarantined = await kit.scanPass(templateId);
    await record(scanner.id, quarantined.id);
    await expectCounts(sessionId, 3, 1, 1);
    await run(kit.env.DB, 'UPDATE passes SET test_data_quarantined=1 WHERE id=?', [quarantined.id]);
    await expectCounts(sessionId, 2, 1, 1);
    await run(kit.env.DB, 'UPDATE passes SET test_data_quarantined=0 WHERE id=?', [quarantined.id]);
    await expectCounts(sessionId, 2, 1, 1);
  });

  it('rejects a stale session DTO after its stored mode changes', async () => {
    const { kit, templateId, workspace, record, expectCounts, countAuthority } = scope;
    const event = await kit.event({ templateIds: [templateId] });
    const scanner = await kit.scanner({ eventId: event.id });
    const sessionId = await workspace(scanner, event.id);
    const pass = await kit.scanPass(templateId);
    await record(scanner.id, pass.id);
    await expectCounts(sessionId, 1, 1, 1);
    const row = await scanningSessionRow(kit.env.DB, kit.org.id, sessionId);
    if (!row) throw new Error('Missing scanning session');
    await run(kit.env.DB, "UPDATE scanning_sessions SET mode='test' WHERE id=?", [sessionId]);
    expect(
      await scanningSessionStats(
        kit.env.DB,
        row,
        SINCE,
        SINCE,
        await countAuthority(kit.org.id),
        kit.clock.now(),
      ),
    ).toBeNull();
    expect(
      await scanningSessionTodayStmt(kit.env.DB, kit.org.id, sessionId, 'live', SINCE).first(),
    ).toEqual({ n: 0 });
    await expectCounts(sessionId, 0, 0, 0, 'test');
    await expect(sessionDto(kit.ctx, row, await countAuthority(kit.org.id))).rejects.toMatchObject({
      status: 404,
      code: 'SCANNING_SESSION_NOT_FOUND',
    });
  });
});
