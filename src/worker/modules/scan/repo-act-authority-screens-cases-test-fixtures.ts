import { expect, it } from 'vitest';
import { persistTemplate } from '../../../../test/helpers/index.ts';
import { first, run } from '../../platform/db.ts';
import { approveAppleRelease } from '../passes/apple-release-test-fixtures.ts';
import { ICON_PNG } from '../passes/pass-test-fixtures.ts';
import { expectAdmitted, expectBlocked, raceGate } from './act-authority-test-fixtures.ts';
import { act, CHECK_IN, kit, out, rows, tpl } from './act-test-fixtures.ts';
import { scannerActor, withRole } from './actor.ts';
import { scanInputVisible } from './projection-privacy.ts';
import { getScanner } from './repo-device.ts';
import { candidateById } from './repo-lookup.ts';
import { readScannerScope } from './repo-scope.ts';
import { foundOf } from './resolve.ts';
import { codeOf, key, proofedScanActor } from './test-kit.ts';

export function registerAuthorityScreens() {
  it('fails closed when an incompatible approved revision tightens action policy', async () => {
    const base = await kit.registry.resolve(tpl);
    const templateId = `policy-${key()}`;
    const pinned = kit.registry.add({
      id: templateId,
      orgId: kit.org.id,
      version: 'v1',
      manifest: base.manifest,
      passJson: base.passJson,
      assets: { 'icon.png': ICON_PNG },
    });
    await run(
      kit.env.DB,
      `INSERT INTO templates
      (id,org_id,slug,name,origin,active_version,created_at,updated_at)
      VALUES (?,?,?,?,'uploaded',?,?,?)`,
      [
        templateId,
        kit.org.id,
        templateId,
        pinned.manifest.name,
        pinned.version,
        kit.clock.now(),
        kit.clock.now(),
      ],
    );
    await persistTemplate(kit.fx, pinned, { registry: kit.registry, buildKey: 'original-build' });
    await approveAppleRelease(kit, { templateId, mode: 'live', version: pinned.version });
    const pass = await kit.scanPass(templateId, { tier: 'overdue' });
    const scanner = await kit.scanner({
      templateIds: [templateId],
      settings: { roleWithoutSignIn: 'door' },
    });

    const current = kit.registry.add({
      id: templateId,
      orgId: kit.org.id,
      version: 'v2',
      manifest: {
        ...pinned.manifest,
        inputs: {
          ...pinned.manifest.inputs,
          properties: {
            ...pinned.manifest.inputs.properties,
            tier: { type: 'string', 'x-scan': 'hidden' },
          },
        },
        scan: { ...pinned.manifest.scan, actions: [{ ...CHECK_IN, minRole: 'manager' }] },
      },
      passJson: pinned.passJson,
      assets: { 'icon.png': ICON_PNG },
    });
    await persistTemplate(kit.fx, current, { registry: kit.registry, buildKey: 'different-build' });
    await approveAppleRelease(kit, { templateId, mode: 'live', version: current.version });
    const candidate = await candidateById(kit.env.DB, kit.org.id, pass.id);
    const scannerRow = await getScanner(kit.env.DB, scanner.id);
    if (!candidate || !scannerRow) throw new Error('Missing scanner candidate');
    const scope = await readScannerScope(kit.env.DB, scannerRow, null);
    const actor = await proofedScanActor(
      kit.ctx,
      withRole(scannerActor(kit.ctx, scannerRow, 'live', 'cookie', scope), null),
    );
    const found = await foundOf(kit.ctx, candidate, actor);
    expect(found).not.toBeNull();
    expect(found?.template.version).toBe(pinned.version);
    expect(found?.activeTemplate?.version).toBe(pinned.version);
    expect(found?.activePolicy?.version).toBe(current.version);
    expect(found?.scan.actions.find((action) => action.id === 'check_in')?.minRole).toBe('manager');
    expect(found && scanInputVisible(found, actor, 'tier')).toBe(false);
    const idempotencyKey = key();
    const response = await act(scanner.headers, codeOf(pass), { idempotencyKey });
    // The approved policy needs a manager and this scanner has none, so the check-in is refused.
    expect(response.status).toBe(200);
    expect(await out(response)).toMatchObject({ kind: 'refused' });
    expect(await rows('SELECT pass_id FROM scan_gates WHERE pass_id=?', [pass.id])).toHaveLength(0);
    expect(
      await first(kit.env.DB, 'SELECT template_version FROM passes WHERE id=?', [pass.id]),
    ).toEqual({ template_version: pinned.version });
  });

  it.each(['monitor', 'customer'] as const)(
    'does not change a %s screen or its staff binding when an action is denied',
    async (deviceRole) => {
      const staff = await kit.staff('manager');
      const s = await kit.scanner({ deviceRole, templateIds: [tpl], staffId: staff.id });
      const pass = await kit.scanPass(tpl);
      const before = await first(
        kit.env.DB,
        'SELECT device_role,staff_id,staff_since,staff_seen_at,event_id FROM scanners WHERE id=?',
        [s.id],
      );
      const response = await act(s.headers, codeOf(pass));
      expect(response.status).toBe(403);
      expect(await response.json()).toMatchObject({ code: 'SCREEN_ONLY' });
      expect(
        await first(
          kit.env.DB,
          'SELECT device_role,staff_id,staff_since,staff_seen_at,event_id FROM scanners WHERE id=?',
          [s.id],
        ),
      ).toEqual(before);
      expect(await rows('SELECT pass_id FROM scan_gates WHERE pass_id=?', [pass.id])).toHaveLength(
        0,
      );
    },
  );

  it.each(['ready', 'refused'] as const)(
    'does not return a %s pass display after the device becomes a screen',
    async (outcome) => {
      const s = await kit.scanner({
        templateIds: [tpl],
        ...(outcome === 'ready' ? { settings: { flow: 'choose' } } : {}),
      });
      const pass = await kit.scanPass(tpl);
      if (outcome === 'refused')
        await run(kit.env.DB, "UPDATE passes SET status='voided' WHERE id=?", [pass.id]);
      const idempotencyKey = key();
      const response = await raceGate(
        s.headers,
        codeOf(pass),
        (db) => run(db, "UPDATE scanners SET device_role='monitor' WHERE id=?", [s.id]),
        { idempotencyKey },
      );
      await expectBlocked(response, pass.id, idempotencyKey, 'SCAN_CONFIG_CHANGED');
    },
  );

  it('does not replay a pass display after the device becomes a screen', async () => {
    const s = await kit.scanner({ templateIds: [tpl] });
    const pass = await kit.scanPass(tpl);
    const idempotencyKey = key();
    expect((await out(await act(s.headers, codeOf(pass), { idempotencyKey }))).kind).toBe('ok');
    // scanners.config_epoch moved (device_role): the guard answers before any receipt is built.
    await run(kit.env.DB, "UPDATE scanners SET device_role='customer' WHERE id=?", [s.id]);
    const response = await act(s.headers, codeOf(pass), { idempotencyKey });
    expect(response.status).toBe(403);
    const body = await response.text();
    expect(JSON.parse(body)).toMatchObject({ code: 'SCREEN_ONLY' });
    expect(body).not.toContain(pass.id);
    expect(
      await rows("SELECT id FROM pass_events WHERE pass_id=? AND kind='scan.checked_in'", [
        pass.id,
      ]),
    ).toHaveLength(1);
  });

  it.each(['monitor', 'customer'] as const)(
    'does not admit if the scanner becomes a %s after its actor was resolved',
    async (deviceRole) => {
      const s = await kit.scanner({ templateIds: [tpl] });
      const pass = await kit.scanPass(tpl);
      const idempotencyKey = key();
      const response = await raceGate(
        s.headers,
        codeOf(pass),
        (db) => run(db, 'UPDATE scanners SET device_role=? WHERE id=?', [deviceRole, s.id]),
        { idempotencyKey },
      );
      await expectBlocked(response, pass.id, idempotencyKey, 'SCAN_CONFIG_CHANGED');
      expect(
        await first<{ device_role: string }>(
          kit.env.DB,
          'SELECT device_role FROM scanners WHERE id=?',
          [s.id],
        ),
      ).toEqual({ device_role: deviceRole });
    },
  );

  it.each([
    [
      'settings (config_epoch)',
      "UPDATE scanners SET settings=json_set(settings,'$.flow','choose') WHERE id=?",
      'SCAN_CONFIG_CHANGED',
    ],
    [
      'csrf (credential_epoch)',
      'UPDATE scanners SET csrf_secret=?,updated_at=updated_at+1 WHERE id=?',
      'SCANNER_REPAIR',
    ],
    [
      'revocation (credential_epoch)',
      'UPDATE scanners SET revoked_at=? WHERE id=?',
      'SCANNER_REPAIR',
    ],
  ] as const)(
    'refuses a scanner %s change between preflight and commit',
    async (_name, sql, code) => {
      const s = await kit.scanner({ templateIds: [tpl] });
      const pass = await kit.scanPass(tpl);
      const idempotencyKey = key();
      const response = await raceGate(
        s.headers,
        codeOf(pass),
        (db) =>
          run(
            db,
            sql,
            sql.includes('?,')
              ? [`csrf-${key()}`, s.id]
              : sql.includes('revoked_at')
                ? [kit.clock.now(), s.id]
                : [s.id],
          ),
        { idempotencyKey },
      );
      await expectBlocked(response, pass.id, idempotencyKey, code);
    },
  );

  it('admits the scan when only volatile scanner columns change before commit', async () => {
    const s = await kit.scanner({ templateIds: [tpl] });
    const pass = await kit.scanPass(tpl);
    const response = await raceGate(
      s.headers,
      codeOf(pass),
      (db) => run(db, 'UPDATE scanners SET updated_at=updated_at+1 WHERE id=?', [s.id]),
      { idempotencyKey: key() },
    );
    await expectAdmitted(response, pass.id);
  });
}
