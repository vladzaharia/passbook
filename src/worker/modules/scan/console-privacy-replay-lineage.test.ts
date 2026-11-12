import { describe, expect, it } from 'vitest';
import { makeOrg } from '../../../../test/helpers/index.ts';
import { type ScanOutcome, ScanOutcomeSchema } from '../../../shared/contracts/scan.ts';
import { all, first, run } from '../../platform/db.ts';
import { approveAppleRelease } from '../passes/apple-release-test-fixtures.ts';
import { ICON_PNG } from '../passes/pass-test-fixtures.ts';
import { buildKey as templateBuildKey } from '../templates/package/hash.ts';
import {
  action,
  expectMasked,
  expectOneClaim,
  expectRedactedReceipt,
  replay,
} from './console-privacy-actions-test-fixtures.ts';
import {
  EMAIL,
  expectNoSecrets,
  HIDDEN,
  initialBuildKey,
  insertVersion,
  kit,
  MANAGER,
  PUBLIC,
  privatePass,
  setupPrivacyKit,
  templateId,
} from './console-privacy-test-fixtures.ts';
import { replayEffects } from './repo-console-privacy-state-test-fixtures.ts';
import { codeOf, DAY, key } from './test-kit.ts';

setupPrivacyKit();

describe('idempotent scanner replay privacy', () => {
  // Policy follows the head whatever its build; the pass keeps its own release for content.
  it('admits a pinned pass under an incompatible approved release with its own display', async () => {
    const scanner = await kit.scanner({ templateIds: [templateId] });
    const pass = await privatePass();
    const pinned = await kit.registry.resolve(templateId, 'v1');
    const manifest = structuredClone(pinned.manifest);
    if (!manifest.scan?.display) throw new Error('The template must have a scan display.');
    manifest.scan.display.holder = 'Incompatible current display sentinel';
    const active = kit.registry.add({
      id: templateId,
      orgId: kit.org.id,
      version: 'v2',
      manifest,
      passJson: { ...pinned.passJson, description: 'A changed pass artifact' },
      assets: { 'icon.png': ICON_PNG },
    });
    const changedBuildKey = await templateBuildKey(active);
    expect(changedBuildKey).not.toBe(initialBuildKey);
    await insertVersion(active, changedBuildKey);
    await approveAppleRelease(kit, {
      orgId: kit.org.id,
      mode: 'live',
      templateId,
      version: active.version,
    });
    const request = {
      idempotencyKey: key(),
      input: codeOf(pass),
      clientTs: kit.clock.now(),
      actionId: 'check_in',
    };
    const response = await kit.post(scanner.headers, '/actions', request);
    expect(response.status).toBe(200);
    const outcome: ScanOutcome = await response.json();
    ScanOutcomeSchema.parse(outcome);
    expect(outcome).toMatchObject({
      kind: 'ok',
      replay: false,
      action: { id: 'check_in' },
      display: { templateVersion: 'v1', identity: { holder: PUBLIC } },
    });
    expectNoSecrets(outcome, pass);
    expect(JSON.stringify(outcome)).not.toContain('Incompatible current display sentinel');
    const again = await kit.post(scanner.headers, '/actions', request);
    expect(again.status).toBe(200);
    expect(await again.json()).toMatchObject({ scanId: outcome.scanId, replay: true });
    expect(
      await all(kit.env.DB, 'SELECT id FROM scans WHERE actor_key = ? AND idempotency_key = ?', [
        `s:${scanner.id}`,
        request.idempotencyKey,
      ]),
    ).toEqual([{ id: outcome.scanId }]);
  });

  it.each(['live', 'test'] as const)(
    'preserves both receipts when only the %s release head is republished',
    async (mode) => {
      const liveScanner = await kit.scanner({ templateIds: [templateId] });
      const testScanner = await kit.scanner({ templateIds: [templateId], mode: 'test' });
      const livePass = await privatePass();
      const testPass = await kit.scanPass(
        templateId,
        { memberName: PUBLIC, tier: MANAGER, privateNotes: HIDDEN },
        { mode: 'test', holderEmail: EMAIL },
      );
      const live = await action(liveScanner, livePass);
      const test = await action(testScanner, testPass);
      const pinned = await kit.registry.resolve(templateId, 'v1');
      const otherMode = mode === 'live' ? 'test' : 'live';
      const previous = await first<{ id: string }>(
        kit.env.DB,
        "SELECT id FROM template_releases WHERE template_id = ? AND org_id = ? AND mode = ? AND provider = 'apple' ORDER BY generation DESC LIMIT 1",
        [templateId, kit.org.id, mode],
      );
      const untouched = await first<{ id: string }>(
        kit.env.DB,
        "SELECT id FROM template_releases WHERE template_id = ? AND org_id = ? AND mode = ? AND provider = 'apple' ORDER BY generation DESC LIMIT 1",
        [templateId, kit.org.id, otherMode],
      );
      expect(previous).not.toBeNull();
      expect(untouched).not.toBeNull();
      const published = await approveAppleRelease(kit, {
        orgId: kit.org.id,
        mode,
        templateId,
        version: pinned.version,
      });
      expect(published.previousReleaseId).toBe(previous?.id);
      expect(
        await first(
          kit.env.DB,
          "SELECT id FROM template_releases WHERE template_id = ? AND org_id = ? AND mode = ? AND provider = 'apple' ORDER BY generation DESC LIMIT 1",
          [templateId, kit.org.id, otherMode],
        ),
      ).toEqual(untouched);
      const liveBefore = await replayEffects(livePass);
      const testBefore = await replayEffects(testPass);
      const unchanged = mode === 'live' ? test : live;
      const changed = mode === 'live' ? live : test;
      const unchangedPass = mode === 'live' ? testPass : livePass;
      const changedPass = mode === 'live' ? livePass : testPass;
      const unchangedReplay = await replay(unchanged.send);
      expect(unchangedReplay).toMatchObject({
        kind: 'ok',
        replay: true,
        scanId: unchanged.original.scanId,
      });
      expectNoSecrets(unchangedReplay, unchangedPass);
      const changedReplay = await replay(changed.send);
      expect(changedReplay).toMatchObject({
        kind: 'ok',
        replay: true,
        scanId: changed.original.scanId,
        undoUntil: null,
        overridable: false,
      });
      expect(changedReplay).toMatchObject({
        display: null,
        card: null,
        template: null,
        previous: null,
      });
      expectNoSecrets(changedReplay, changedPass);
      expect(await replayEffects(livePass)).toEqual(liveBefore);
      expect(await replayEffects(testPass)).toEqual(testBefore);
      await expectOneClaim(liveScanner, live.request.idempotencyKey);
      await expectOneClaim(testScanner, test.request.idempotencyKey);
    },
  );

  it('preserves organization-scoped receipts when a shared template release is republished', async () => {
    const other = await makeOrg(kit.fx);
    const base = await kit.registry.resolve(templateId, 'v1');
    const shared = kit.registry.add({
      id: kit.fx.ids.id(),
      orgId: null,
      manifest: { ...base.manifest, name: 'Shared privacy card' },
      passJson: base.passJson,
      assets: { 'icon.png': ICON_PNG },
    });
    await run(
      kit.env.DB,
      `INSERT INTO templates (id, org_id, slug, name, origin, active_version, created_at, updated_at)
       VALUES (?, NULL, ?, ?, ?, ?, ?, ?)`,
      [
        shared.id,
        shared.id,
        shared.manifest.name,
        shared.origin,
        shared.version,
        kit.clock.now(),
        kit.clock.now(),
      ],
    );
    const sharedKey = await templateBuildKey(shared);
    await insertVersion(shared, sharedKey);
    const otherManifest = structuredClone(shared.manifest);
    if (!otherManifest.scan) throw new Error('The template must have scan actions.');
    otherManifest.scan.actions = otherManifest.scan.actions.map((item) =>
      item.id === 'check_in' ? { ...item, label: 'Other org entry' } : item,
    );
    const otherVersion = kit.registry.add({
      id: shared.id,
      orgId: null,
      version: 'v2',
      manifest: otherManifest,
      passJson: shared.passJson,
      assets: { 'icon.png': ICON_PNG },
    });
    await insertVersion(otherVersion, await templateBuildKey(otherVersion));
    const ownRelease = await approveAppleRelease(kit, {
      orgId: kit.org.id,
      mode: 'live',
      templateId: shared.id,
      version: shared.version,
    });
    const otherRelease = await approveAppleRelease(kit, {
      orgId: other.id,
      mode: 'live',
      templateId: shared.id,
      version: otherVersion.version,
    });
    const ownScanner = await kit.scanner({ templateIds: [shared.id] });
    const otherScanner = await kit.scanner({ orgId: other.id, templateIds: [shared.id] });
    const input = { memberName: PUBLIC, tier: MANAGER, privateNotes: HIDDEN };
    const ownPass = await kit.scanPass(shared.id, input, { holderEmail: EMAIL });
    const otherPass = await kit.scanPass(shared.id, input, { orgId: other.id, holderEmail: EMAIL });
    expect(ownPass.templateVersion).toBe(shared.version);
    expect(otherPass.templateVersion).toBe(otherVersion.version);
    const own = await action(ownScanner, ownPass);
    const foreign = await action(otherScanner, otherPass);
    expect(own.original.action?.label).toBe('Check in');
    expect(foreign.original.action?.label).toBe('Other org entry');
    const published = await approveAppleRelease(kit, {
      orgId: other.id,
      mode: 'live',
      templateId: shared.id,
      version: otherVersion.version,
    });
    expect(published.previousReleaseId).toBe(otherRelease.id);
    expect(
      await first(
        kit.env.DB,
        "SELECT id FROM template_releases WHERE template_id = ? AND org_id = ? AND mode = 'live' AND provider = 'apple' ORDER BY generation DESC LIMIT 1",
        [shared.id, kit.org.id],
      ),
    ).toEqual({ id: ownRelease.id });
    const ownBefore = await replayEffects(ownPass);
    const foreignBefore = await replayEffects(otherPass);
    const ownReplay = await replay(own.send);
    expect(ownReplay).toMatchObject({ kind: 'ok', replay: true, scanId: own.original.scanId });
    expectNoSecrets(ownReplay, ownPass);
    const foreignReplay = await replay(foreign.send);
    expect(foreignReplay).toMatchObject({
      kind: 'ok',
      replay: true,
      scanId: foreign.original.scanId,
      undoUntil: null,
      overridable: false,
      action: { id: 'check_in', label: 'Other org entry' },
    });
    expectNoSecrets(foreignReplay, otherPass);
    expect(await replayEffects(ownPass)).toEqual(ownBefore);
    expect(await replayEffects(otherPass)).toEqual(foreignBefore);
    await expectOneClaim(ownScanner, own.request.idempotencyKey);
    await expectOneClaim(otherScanner, foreign.request.idempotencyKey);
  });

  it.each([
    'accepted templates',
    'mode',
    'organization',
    'quarantined',
    'removed',
    'deleted',
    'hard-deleted',
    'voided status',
    'voided Wallet pass',
    'expired Wallet pass',
    'invalid expiration',
    'invalid voided',
    'non-object Wallet JSON',
  ] as const)('protects a previous receipt after changing %s', async (change) => {
    const scanner = await kit.scanner({ templateIds: [templateId] });
    const pass = await privatePass();
    const { original, request, send } = await action(scanner, pass);
    if (change === 'accepted templates') {
      const otherTemplate = await kit.scanTemplate('Other card', {
        actions: [{ id: 'check_in', label: 'Check in', kind: 'check_in' }],
      });
      await run(kit.env.DB, 'DELETE FROM scanner_templates WHERE scanner_id = ?', [scanner.id]);
      await run(
        kit.env.DB,
        'INSERT INTO scanner_templates (scanner_id, template_id) VALUES (?, ?)',
        [scanner.id, otherTemplate],
      );
    } else if (change === 'mode') {
      await run(kit.env.DB, "UPDATE scanners SET mode = 'test' WHERE id = ?", [scanner.id]);
    } else if (change === 'organization') {
      const other = await makeOrg(kit.fx);
      await run(kit.env.DB, 'UPDATE scanners SET org_id = ? WHERE id = ?', [other.id, scanner.id]);
    } else if (change === 'quarantined') {
      await run(kit.env.DB, 'UPDATE passes SET test_data_quarantined = 1 WHERE id = ?', [pass.id]);
    } else if (change === 'removed') {
      await run(kit.env.DB, 'UPDATE passes SET removed_at = ? WHERE id = ?', [
        kit.clock.now(),
        pass.id,
      ]);
    } else if (change === 'deleted') {
      await run(kit.env.DB, 'UPDATE passes SET deleted_at = ? WHERE id = ?', [
        kit.clock.now(),
        pass.id,
      ]);
    } else if (change === 'hard-deleted') {
      await run(kit.env.DB, 'DELETE FROM passes WHERE id = ?', [pass.id]);
    } else if (change === 'voided status') {
      await run(kit.env.DB, "UPDATE passes SET status = 'voided' WHERE id = ?", [pass.id]);
    } else if (change === 'voided Wallet pass') {
      await run(
        kit.env.DB,
        "UPDATE pass_versions SET pass_json = json_set(pass_json, '$.voided', json('true')) WHERE pass_id = ?",
        [pass.id],
      );
    } else if (change === 'invalid expiration') {
      await run(
        kit.env.DB,
        "UPDATE pass_versions SET pass_json = json_set(pass_json, '$.expirationDate', ?) WHERE pass_id = ?",
        ['not-a-date', pass.id],
      );
    } else if (change === 'invalid voided') {
      await run(
        kit.env.DB,
        "UPDATE pass_versions SET pass_json = json_set(pass_json, '$.voided', ?) WHERE pass_id = ?",
        ['true', pass.id],
      );
    } else if (change === 'non-object Wallet JSON') {
      await run(kit.env.DB, 'UPDATE pass_versions SET pass_json = ? WHERE pass_id = ?', [
        '[]',
        pass.id,
      ]);
    } else {
      await run(
        kit.env.DB,
        "UPDATE pass_versions SET pass_json = json_set(pass_json, '$.expirationDate', ?) WHERE pass_id = ?",
        [new Date(kit.clock.now() - DAY).toISOString(), pass.id],
      );
    }
    const before = await replayEffects(pass);
    const receipt = await replay(send);
    // A hard-deleted pass leaves retained history like a soft delete: a receipt without pass data.
    if (['accepted templates', 'mode', 'organization', 'quarantined'].includes(change)) {
      expectMasked(receipt, original, pass);
    } else {
      expectRedactedReceipt(receipt, original, pass);
    }
    expect(await replayEffects(pass)).toEqual(before);
    await expectOneClaim(scanner, request.idempotencyKey);
  });
});
