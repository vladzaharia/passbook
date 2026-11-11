import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { makeSession, makeUser } from '../../../../test/helpers/index.ts';
import { first, run } from '../../platform/db.ts';
import { approveAppleRelease } from '../passes/apple-release-test-fixtures.ts';
import { ICON_PNG } from '../passes/pass-test-fixtures.ts';
import { buildKey as templateBuildKey } from '../templates/package/hash.ts';
import { recordedCheckIn } from './console-privacy-actions-test-fixtures.ts';
import {
  exportPath,
  fake,
  get,
  HIDDEN,
  initialBuildKey,
  insertVersion,
  kit,
  MANAGER,
  PUBLIC,
  page,
  setupPrivacyKit,
  templateId,
  testAdmin,
} from './console-privacy-test-fixtures.ts';
import { grantScanMembership, ORIGIN } from './test-kit.ts';

setupPrivacyKit();

describe('scan console and feed privacy', () => {
  it('uses the effective release for the requested organization and mode', async () => {
    const pinned = await kit.registry.resolve(templateId, 'v1');
    const manifest = structuredClone(pinned.manifest);
    if (!manifest.scan) throw new Error('The template must have scan actions.');
    manifest.scan.actions = manifest.scan.actions.map((item) =>
      item.id === 'check_in' ? { ...item, label: 'Test mode entry' } : item,
    );
    const testVersion = kit.registry.add({
      id: templateId,
      orgId: kit.org.id,
      version: 'v2',
      manifest,
      passJson: pinned.passJson,
      assets: { 'icon.png': ICON_PNG },
    });
    await insertVersion(testVersion, await templateBuildKey(testVersion));
    await approveAppleRelease(kit, {
      orgId: kit.org.id,
      mode: 'test',
      templateId,
      version: testVersion.version,
    });
    const livePass = await kit.scanPass(templateId, { memberName: PUBLIC });
    const testPass = await kit.scanPass(templateId, { memberName: PUBLIC }, { mode: 'test' });
    expect(livePass.templateVersion).toBe(pinned.version);
    expect(testPass.templateVersion).toBe(testVersion.version);
    const liveScanner = await kit.scanner({ templateIds: [templateId] });
    const testScanner = await kit.scanner({ templateIds: [templateId], mode: 'test' });
    const live = await recordedCheckIn(liveScanner, livePass.id);
    const test = await recordedCheckIn(testScanner, testPass.id);
    const liveList = await page(`?orgId=${kit.org.id}`);
    expect(liveList.items).toEqual([
      expect.objectContaining({ id: live.id, actionLabel: 'Check in' }),
    ]);
    const testList = await page(`?orgId=${kit.org.id}`, testAdmin);
    expect(testList.items).toEqual([
      expect.objectContaining({ id: test.id, actionLabel: 'Test mode entry' }),
    ]);
    const liveCsv = await get(exportPath());
    expect(liveCsv.status).toBe(200);
    expect(await liveCsv.text()).toContain('Check in');
    const testCsv = await get(exportPath(), testAdmin);
    expect(testCsv.status).toBe(200);
    expect(await testCsv.text()).toContain('Test mode entry');
    const liveKey = fake.apiKey({ orgId: kit.org.id, scopes: ['scans:read'] });
    const testKey = fake.apiKey({ orgId: kit.org.id, scopes: ['scans:read'], mode: 'test' });
    expect((await page('', liveKey)).items.map((item) => item.id)).toEqual([live.id]);
    expect((await page('', testKey)).items.map((item) => item.id)).toEqual([test.id]);
  });

  it('applies an active release policy to legacy pinned history instead of the old template policy', async () => {
    const pinned = await kit.registry.resolve(templateId, 'v1');
    const legacyPass = await kit.scanPass(templateId, { memberName: PUBLIC });
    await run(kit.env.DB, 'UPDATE passes SET release_id = NULL WHERE id = ?', [legacyPass.id]);
    const scanner = await kit.scanner({ templateIds: [templateId] });
    const row = await recordedCheckIn(scanner, legacyPass.id);
    const viewer = await makeUser(kit.fx);
    await grantScanMembership(kit.fx, kit.org.id, viewer.id, ['read_only']);
    const headers = {
      ...(await makeSession(kit.fx, { userId: viewer.id })).headers,
      origin: ORIGIN,
    };
    expect((await page(`?orgId=${kit.org.id}`, headers)).items[0]).toMatchObject({
      id: row.id,
      passId: legacyPass.id,
      actionId: 'check_in',
      actionLabel: 'Check in',
    });
    const manifest = structuredClone(pinned.manifest);
    if (!manifest.scan) throw new Error('The template must have scan actions.');
    manifest.scan.actions = manifest.scan.actions.map((item) =>
      item.id === 'check_in'
        ? { ...item, label: 'Restricted entry', minRole: 'manager' as const }
        : item,
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
    expect((await page(`?orgId=${kit.org.id}`, headers)).items[0]).toMatchObject({
      id: row.id,
      passId: legacyPass.id,
      kind: null,
      direction: null,
      actionId: null,
      actionLabel: null,
    });
    expect((await page(`?orgId=${kit.org.id}`)).items[0]).toMatchObject({
      id: row.id,
      passId: legacyPass.id,
      kind: null,
      direction: null,
      actionId: null,
      actionLabel: null,
    });
    const detail = await get(`/${row.id}`, headers);
    expect(detail.status).toBe(200);
    expect(await detail.json()).toMatchObject({
      kind: null,
      direction: null,
      actionId: null,
      actionLabel: null,
    });
    const csv = await get(exportPath(), headers);
    expect(csv.status).toBe(200);
    expect(await csv.text()).not.toContain('Restricted entry');
  });

  it('intersects event-time and current policy after a compatible release relaxes source and role visibility', async () => {
    const base = await kit.registry.resolve(templateId, 'v1');
    const pinned = kit.registry.add({
      id: kit.fx.ids.id(),
      orgId: kit.org.id,
      manifest: {
        ...base.manifest,
        name: 'Event-time privacy card',
        display: { ...base.manifest.display, title: '{{tier}}' },
        scan: {
          actions: [
            {
              id: 'check_in',
              label: 'Member entry',
              kind: 'check_in',
              minRole: 'manager',
            },
          ],
        },
      },
      passJson: base.passJson,
      assets: { 'icon.png': ICON_PNG },
    });
    await run(
      kit.env.DB,
      `INSERT INTO templates (id, org_id, slug, name, origin, active_version, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        pinned.id,
        kit.org.id,
        pinned.id,
        pinned.manifest.name,
        pinned.origin,
        pinned.version,
        kit.clock.now(),
        kit.clock.now(),
      ],
    );
    const build = await templateBuildKey(pinned);
    await insertVersion(pinned, build);
    await approveAppleRelease(kit, {
      orgId: kit.org.id,
      mode: 'live',
      templateId: pinned.id,
      version: pinned.version,
    });
    const pass = await kit.scanPass(pinned.id, {
      memberName: PUBLIC,
      tier: MANAGER,
      privateNotes: HIDDEN,
    });
    const staff = await kit.staff('manager');
    const scanner = await kit.scanner({
      templateIds: [pinned.id],
      staffId: staff.id,
      settings: { staffSignIn: true },
    });
    const row = await recordedCheckIn(scanner, pass.id);
    const event = await first<{ data: string }>(
      kit.env.DB,
      "SELECT data FROM pass_events WHERE pass_id = ? AND json_extract(data, '$.scanId') = ?",
      [pass.id, row.id],
    );
    if (!event) throw new Error('A recorded scan must have its pass event.');
    expect(event.data).not.toContain(MANAGER);
    expect(event.data).not.toContain(HIDDEN);
    expect(event.data).not.toContain('Member entry');
    const projection = z
      .object({
        authority: z.object({
          eventProjection: z.object({
            roles: z.object({ door: z.unknown(), manager: z.unknown() }),
          }),
        }),
      })
      .parse(JSON.parse(event.data)).authority.eventProjection;
    expect(projection.roles.door).toMatchObject({ action: null, titleHash: null });
    expect(projection.roles.manager).toMatchObject({
      action: { id: 'check_in', kind: 'check_in', labelHash: expect.any(String) },
      titleHash: expect.any(String),
    });
    const user = await makeUser(kit.fx);
    await grantScanMembership(kit.fx, kit.org.id, user.id, ['read_only']);
    const headers = { ...(await makeSession(kit.fx, { userId: user.id })).headers, origin: ORIGIN };
    expect((await page(`?orgId=${kit.org.id}`, headers)).items[0]).toMatchObject({
      id: row.id,
      passTitle: null,
      kind: null,
      actionId: null,
      actionLabel: null,
    });
    const manifest = structuredClone(pinned.manifest);
    manifest.inputs = {
      type: 'object',
      required: ['memberName'],
      properties: {
        memberName: { type: 'string', minLength: 1 },
        tier: { type: 'string' },
        privateNotes: { type: 'string', 'x-scan': 'hidden' },
      },
    };
    if (!manifest.scan) throw new Error('The template must have scan actions.');
    manifest.scan.actions = manifest.scan.actions.map((item) =>
      item.id === 'check_in' ? { ...item, minRole: 'door' as const } : item,
    );
    const active = kit.registry.add({
      id: pinned.id,
      orgId: kit.org.id,
      version: 'v2',
      manifest,
      passJson: pinned.passJson,
      assets: { 'icon.png': ICON_PNG },
    });
    await insertVersion(active, build);
    await approveAppleRelease(kit, {
      orgId: kit.org.id,
      mode: 'live',
      templateId: pinned.id,
      version: active.version,
    });
    const list = await page(`?orgId=${kit.org.id}`, headers);
    expect(list.items[0]).toMatchObject({
      id: row.id,
      passTitle: null,
      kind: null,
      actionId: null,
      actionLabel: null,
    });
    expect(JSON.stringify(list)).not.toContain(MANAGER);
    expect(
      (await page(`?orgId=${kit.org.id}&q=${encodeURIComponent(MANAGER)}`, headers)).items,
    ).toEqual([]);
    const detail = await get(`/${row.id}`, headers);
    expect(detail.status).toBe(200);
    expect(await detail.json()).toMatchObject({
      passTitle: null,
      kind: null,
      actionId: null,
      actionLabel: null,
    });
    const csv = await get(exportPath(), headers);
    expect(csv.status).toBe(200);
    const text = await csv.text();
    expect(text).not.toContain(MANAGER);
    expect(text).not.toContain('Member entry');
    expect((await page(`?orgId=${kit.org.id}`)).items[0]).toMatchObject({
      id: row.id,
      passTitle: MANAGER,
      actionId: 'check_in',
      actionLabel: 'Member entry',
    });
    await run(
      kit.env.DB,
      "UPDATE pass_versions SET personalization = '{}' WHERE pass_id = ? AND version = ?",
      [pass.id, pass.version],
    );
    await run(kit.env.DB, 'UPDATE passes SET personalization = ? WHERE id = ?', [
      JSON.stringify({ memberName: PUBLIC, tier: 'Changed tier', privateNotes: HIDDEN }),
      pass.id,
    ]);
    const unverified = await page(`?orgId=${kit.org.id}`);
    expect(unverified.items).toHaveLength(1);
    expect(unverified.items[0]).toMatchObject({ id: row.id, passTitle: null });
    expect(JSON.stringify(unverified)).not.toContain(MANAGER);
  });
});
