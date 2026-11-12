import { describe, expect, it } from 'vitest';
import { run } from '../../platform/db.ts';
import { approveAppleRelease } from '../passes/apple-release-test-fixtures.ts';
import { ICON_PNG } from '../passes/pass-test-fixtures.ts';
import { buildKey as templateBuildKey } from '../templates/package/hash.ts';
import {
  action,
  expectOneClaim,
  expectRedactedReceipt,
  expectSafeReceipt,
  replay,
} from './console-privacy-actions-test-fixtures.ts';
import {
  admin,
  app,
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
import { key, ORIGIN } from './test-kit.ts';

setupPrivacyKit();

describe('idempotent scanner replay privacy', () => {
  it('retains a non-identifying actionless no-match replay', async () => {
    const scanner = await kit.scanner({ templateIds: [templateId] });
    const request = {
      idempotencyKey: key(),
      input: { code: 'REPLAY-NO-MATCH-674', method: 'camera' },
      clientTs: kit.clock.now(),
      actionId: 'check_in',
    };
    const send = () => kit.post(scanner.headers, '/actions', request);
    const original = await replay(send);
    expect(original).toMatchObject({
      kind: 'refused',
      reason: 'not_found',
      replay: false,
      action: null,
      card: null,
      template: null,
      display: null,
    });
    const again = await replay(send);
    expect(again).toMatchObject({
      kind: 'refused',
      reason: 'not_found',
      replay: true,
      scanId: original.scanId,
      action: null,
      card: null,
      template: null,
      display: null,
    });
    expect(JSON.stringify(again)).not.toContain(request.input.code);
    await expectOneClaim(scanner, request.idempotencyKey);
  });

  it('replays the original receipt without new effects after undo and a later check-in', async () => {
    const scanner = await kit.scanner({ templateIds: [templateId] });
    const pass = await privatePass();
    const original = await action(scanner, pass);
    if (!original.original.scanId) throw new Error('A successful scan must have an id.');
    const undo = await app.request(
      `${ORIGIN}/api/v1/scans/${original.original.scanId}/undo`,
      {
        method: 'POST',
        headers: { ...admin, 'content-type': 'application/json' },
        body: JSON.stringify({ idempotencyKey: key() }),
      },
      kit.env,
    );
    expect(undo.status).toBe(200);
    const afterUndo = await replayEffects(pass);
    const undoneReceipt = await replay(original.send);
    expect(undoneReceipt).toMatchObject({
      kind: 'ok',
      scanId: original.original.scanId,
      replay: true,
      undoUntil: null,
      overridable: false,
    });
    expectNoSecrets(undoneReceipt, pass);
    expect(await replayEffects(pass)).toEqual(afterUndo);
    const next = await action(scanner, pass);
    expect(next.original.scanId).not.toBe(original.original.scanId);
    const afterReentry = await replayEffects(pass);
    const priorReceipt = await replay(original.send);
    expect(priorReceipt).toMatchObject({
      kind: 'ok',
      scanId: original.original.scanId,
      replay: true,
      undoUntil: null,
      overridable: false,
    });
    expectNoSecrets(priorReceipt, pass);
    expect(await replayEffects(pass)).toEqual(afterReentry);
    await expectOneClaim(scanner, original.request.idempotencyKey);
    await expectOneClaim(scanner, next.request.idempotencyKey);
  });

  it('reprojects an authorized replay after the signed-in Manager becomes Door', async () => {
    const staff = await kit.staff('manager');
    const scanner = await kit.scanner({
      templateIds: [templateId],
      staffId: staff.id,
      settings: { staffSignIn: true },
    });
    const pass = await privatePass();
    const { original, request, send } = await action(scanner, pass);
    expect(JSON.stringify(original.display)).toContain(MANAGER);
    expectNoSecrets(original, pass, true);

    await run(
      kit.env.DB,
      "UPDATE scan_staff SET role = 'door', updated_at = updated_at + 1 WHERE id = ?",
      [staff.id],
    );
    const again = await replay(send);
    expect(again).toMatchObject({ kind: 'ok', replay: true, scanId: original.scanId });
    expect(again).toMatchObject({
      display: null,
      card: null,
      template: null,
      previous: null,
      action: { id: 'check_in', label: 'Check in', kind: 'check_in' },
    });
    expectNoSecrets(again, pass);
    await expectOneClaim(scanner, request.idempotencyKey);
  });

  it('redacts receipt replays whose action label or source becomes private after a role downgrade', async () => {
    const base = await kit.registry.resolve(templateId, 'v1');
    const manifest = structuredClone(base.manifest);
    manifest.inputs = {
      type: 'object',
      required: ['memberName'],
      properties: {
        memberName: { type: 'string', minLength: 1 },
        tier: { type: 'string', 'x-scan': 'manager' },
        privateNotes: { type: 'string', 'x-scan': 'hidden' },
        entryCount: { type: 'integer', 'x-scan': 'manager' },
      },
    };
    if (!manifest.scan) throw new Error('The template must have scan actions.');
    manifest.scan.actions = [
      { id: 'private_label', label: MANAGER, kind: 'check_in' },
      { id: 'private_source', label: 'Entry count', kind: 'check_in', input: 'entryCount' },
    ];
    const restricted = kit.registry.add({
      id: kit.fx.ids.id(),
      orgId: kit.org.id,
      manifest,
      passJson: base.passJson,
      assets: { 'icon.png': ICON_PNG },
    });
    await run(
      kit.env.DB,
      `INSERT INTO templates (id, org_id, slug, name, origin, active_version, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        restricted.id,
        kit.org.id,
        restricted.id,
        restricted.manifest.name,
        restricted.origin,
        restricted.version,
        kit.clock.now(),
        kit.clock.now(),
      ],
    );
    await insertVersion(restricted, await templateBuildKey(restricted));
    await approveAppleRelease(kit, {
      orgId: kit.org.id,
      mode: 'live',
      templateId: restricted.id,
      version: restricted.version,
    });
    const staff = await kit.staff('manager');
    const scanner = await kit.scanner({
      templateIds: [restricted.id],
      staffId: staff.id,
      settings: { staffSignIn: true },
    });
    const pass = await kit.scanPass(
      restricted.id,
      {
        memberName: PUBLIC,
        tier: MANAGER,
        privateNotes: HIDDEN,
        entryCount: 27,
      },
      { holderEmail: EMAIL },
    );
    const { original, request, send } = await action(scanner, pass, 'private_label');
    expect(original.action).toMatchObject({ id: 'private_label', label: MANAGER });
    expectNoSecrets(original, pass, true);
    const sourcePass = await kit.scanPass(
      restricted.id,
      {
        memberName: PUBLIC,
        tier: MANAGER,
        privateNotes: HIDDEN,
        entryCount: 27,
      },
      { holderEmail: EMAIL },
    );
    const source = await action(scanner, sourcePass, 'private_source');
    expect(source.original.action).toMatchObject({ id: 'private_source', label: 'Entry count' });
    expectNoSecrets(source.original, sourcePass, true);
    await run(
      kit.env.DB,
      "UPDATE scan_staff SET role = 'door', updated_at = updated_at + 1 WHERE id = ?",
      [staff.id],
    );
    const before = await replayEffects(pass);
    const sourceBefore = await replayEffects(sourcePass);
    const labelReceipt = await replay(send);
    expectSafeReceipt(labelReceipt, original, pass);
    const sourceReceipt = await replay(source.send);
    expectSafeReceipt(sourceReceipt, source.original, sourcePass);
    expect(JSON.stringify(sourceReceipt)).not.toContain('Entry count');
    expect(await replayEffects(pass)).toEqual(before);
    expect(await replayEffects(sourcePass)).toEqual(sourceBefore);
    await expectOneClaim(scanner, request.idempotencyKey);
    await expectOneClaim(scanner, source.request.idempotencyKey);
  });

  it('retains a redacted Manager-only receipt after the signed-in staff role is downgraded', async () => {
    const staff = await kit.staff('manager');
    const scanner = await kit.scanner({
      templateIds: [templateId],
      staffId: staff.id,
      settings: { staffSignIn: true },
    });
    const pass = await privatePass();
    const { original, request, send } = await action(scanner, pass, 'manager_only');
    await run(
      kit.env.DB,
      "UPDATE scan_staff SET role = 'door', updated_at = updated_at + 1 WHERE id = ?",
      [staff.id],
    );
    const before = await replayEffects(pass);
    const receipt = await replay(send);
    expectSafeReceipt(receipt, original, pass);
    expect(JSON.stringify(receipt)).not.toContain('Manager entry');
    expect(await replayEffects(pass)).toEqual(before);
    await expectOneClaim(scanner, request.idempotencyKey);
  });

  it('reprojects a receipt under the changed same-build release and current role', async () => {
    const staff = await kit.staff('manager');
    const scanner = await kit.scanner({
      templateIds: [templateId],
      staffId: staff.id,
      settings: { staffSignIn: true },
    });
    const pass = await privatePass();
    const { original, request, send } = await action(scanner, pass);
    const pinned = await kit.registry.resolve(templateId, 'v1');
    const manifest = structuredClone(pinned.manifest);
    if (!manifest.scan) throw new Error('The template must have scan actions.');
    manifest.scan.actions = manifest.scan.actions.map((item) =>
      item.id === 'check_in' ? { ...item, minRole: 'manager' as const } : item,
    );
    const active = kit.registry.add({
      id: templateId,
      orgId: kit.org.id,
      version: 'v2',
      manifest,
      passJson: pinned.passJson,
      assets: { 'icon.png': ICON_PNG },
    });
    // Model an equal-build-key policy activation while keeping both version rows immutable.
    await insertVersion(active, initialBuildKey);
    await approveAppleRelease(kit, {
      orgId: kit.org.id,
      mode: 'live',
      templateId,
      version: active.version,
    });
    await run(
      kit.env.DB,
      "UPDATE scan_staff SET role = 'door', updated_at = updated_at + 1 WHERE id = ?",
      [staff.id],
    );
    const before = await replayEffects(pass);
    const doorReceipt = await replay(send);
    expectSafeReceipt(doorReceipt, original, pass);
    await run(
      kit.env.DB,
      "UPDATE scan_staff SET role = 'manager', updated_at = updated_at + 1 WHERE id = ?",
      [staff.id],
    );
    const managerReceipt = await replay(send);
    expect(managerReceipt).toMatchObject({
      kind: 'ok',
      scanId: original.scanId,
      replay: true,
      action: { id: 'check_in' },
      undoUntil: null,
      overridable: false,
    });
    expect(managerReceipt).toMatchObject({
      display: null,
      card: null,
      template: null,
      previous: null,
    });
    expectNoSecrets(managerReceipt, pass, true);
    const conflict = await kit.post(scanner.headers, '/actions', {
      ...request,
      actionId: 'manager_only',
    });
    expect(conflict.status).toBe(422);
    expect(await conflict.json()).toMatchObject({ code: 'IDEMPOTENCY_KEY_REUSED' });
    expect(await replayEffects(pass)).toEqual(before);
    await expectOneClaim(scanner, request.idempotencyKey);
  });

  it('returns a redacted receipt when the current release has an incompatible build key', async () => {
    const scanner = await kit.scanner({ templateIds: [templateId] });
    const pass = await privatePass();
    const { original, request, send } = await action(scanner, pass);
    expect(await replay(send)).toMatchObject({ kind: 'ok', replay: true, scanId: original.scanId });
    const pinned = await kit.registry.resolve(templateId, 'v1');
    const active = kit.registry.add({
      id: templateId,
      orgId: kit.org.id,
      version: 'v2',
      manifest: structuredClone(pinned.manifest),
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
    const before = await replayEffects(pass);
    expectRedactedReceipt(await replay(send), original, pass);
    expect(await replayEffects(pass)).toEqual(before);
    await expectOneClaim(scanner, request.idempotencyKey);
  });

  it('applies the same-head current Manager policy to a scan on a pinned pass and its replay', async () => {
    const pass = await privatePass();
    const pinned = await kit.registry.resolve(templateId, 'v1');
    const manifest = structuredClone(pinned.manifest);
    if (!manifest.scan) throw new Error('The template must have scan actions.');
    manifest.scan.actions = manifest.scan.actions.map((item) =>
      item.id === 'check_in' ? { ...item, minRole: 'manager' as const } : item,
    );
    const active = kit.registry.add({
      id: templateId,
      orgId: kit.org.id,
      version: 'v2',
      manifest,
      passJson: pinned.passJson,
      assets: { 'icon.png': ICON_PNG },
    });
    await insertVersion(active, initialBuildKey);
    await approveAppleRelease(kit, {
      orgId: kit.org.id,
      mode: 'live',
      templateId,
      version: active.version,
    });
    const staff = await kit.staff('manager');
    const scanner = await kit.scanner({
      templateIds: [templateId],
      staffId: staff.id,
      settings: { staffSignIn: true },
    });
    const { original, request, send } = await action(scanner, pass);
    const authorized = await replay(send);
    expect(authorized).toMatchObject({ kind: 'ok', replay: true, scanId: original.scanId });
    expect(authorized).toMatchObject({
      display: null,
      card: null,
      template: null,
      previous: null,
      action: { id: 'check_in', label: 'Check in', kind: 'check_in' },
    });
    expectNoSecrets(authorized, pass, true);
    await run(
      kit.env.DB,
      "UPDATE scan_staff SET role = 'door', updated_at = updated_at + 1 WHERE id = ?",
      [staff.id],
    );
    const before = await replayEffects(pass);
    const receipt = await replay(send);
    expectSafeReceipt(receipt, original, pass);
    expect(await replayEffects(pass)).toEqual(before);
    await expectOneClaim(scanner, request.idempotencyKey);
  });
});
