import { describe, expect, it } from 'vitest';
import type { ScanOutcome } from '../../../shared/contracts/scan.ts';
import { ScanRecordSchema } from '../../../shared/contracts/scanners.ts';
import { run } from '../../platform/db.ts';
import { approveAppleRelease } from '../passes/apple-release-test-fixtures.ts';
import { ICON_PNG } from '../passes/pass-test-fixtures.ts';
import { buildKey as templateBuildKey } from '../templates/package/hash.ts';
import { recordedCheckIn } from './console-privacy-actions-test-fixtures.ts';
import {
  EMAIL,
  expectNoSecrets,
  exportPath,
  fake,
  get,
  HIDDEN,
  initialBuildKey,
  insertVersion,
  kit,
  lastExportCount,
  MANAGER,
  PUBLIC,
  page,
  privatePass,
  seedScan,
  setupPrivacyKit,
  templateId,
} from './console-privacy-test-fixtures.ts';
import { key } from './test-kit.ts';

setupPrivacyKit();

describe('scan console and feed privacy', () => {
  it('retains incompatible-build history with only safe metadata and the original outcome', async () => {
    const base = await kit.registry.resolve(templateId, 'v1');
    const pinned = kit.registry.add({
      id: kit.fx.ids.id(),
      orgId: kit.org.id,
      manifest: {
        ...base.manifest,
        name: 'Historical policy card',
        display: { ...base.manifest.display, title: '{{tier}}' },
        scan: {
          actions: [
            { id: 'check_in', label: 'Check in', kind: 'check_in' },
            { id: 'set_tier', label: 'Tier change', kind: 'set', input: 'tier' },
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
    const pinnedKey = await templateBuildKey(pinned);
    await insertVersion(pinned, pinnedKey);
    await approveAppleRelease(kit, {
      orgId: kit.org.id,
      mode: 'live',
      templateId: pinned.id,
      version: pinned.version,
    });
    const pass = await kit.scanPass(
      pinned.id,
      {
        memberName: PUBLIC,
        tier: MANAGER,
        privateNotes: HIDDEN,
      },
      { holderEmail: EMAIL },
    );
    // The manager title needs a manager-recorded event: an event records each role's view only up
    // to the recorder's role.
    const staff = await kit.staff('manager');
    const scanner = await kit.scanner({
      templateIds: [pinned.id],
      staffId: staff.id,
      settings: { staffSignIn: true },
    });
    const first = await recordedCheckIn(scanner, pass.id);
    kit.clock.advance(1000);
    const duplicateResponse = await kit.post(scanner.headers, '/actions', {
      idempotencyKey: key(),
      input: { passId: pass.id, method: 'manual' },
      clientTs: kit.clock.now(),
      actionId: 'check_in',
    });
    expect(duplicateResponse.status).toBe(200);
    const duplicate: ScanOutcome = await duplicateResponse.json();
    expect(duplicate).toMatchObject({ kind: 'heads_up', reason: 'already_done', replay: false });
    if (!duplicate.scanId || duplicate.at === null)
      throw new Error('A recorded heads-up must have an id and time.');
    const row = { id: duplicate.scanId, at: duplicate.at };
    const synthetic = await seedScan({
      scanner,
      passId: pass.id,
      templateId: pinned.id,
      passVersion: pass.version,
      actionId: 'set_tier',
      actionKind: 'set',
      before: MANAGER,
      after: MANAGER,
    });
    const provenDetail = await get(`/${row.id}`);
    expect(provenDetail.status).toBe(200);
    expect(await provenDetail.json()).toMatchObject({
      id: row.id,
      passId: pass.id,
      passTitle: MANAGER,
      outcome: 'heads_up',
      reason: 'already_done',
    });
    const manifest = structuredClone(pinned.manifest);
    manifest.inputs = {
      type: 'object',
      required: ['memberName'],
      properties: {
        memberName: { type: 'string', minLength: 1 },
        tier: { type: 'string', 'x-scan': 'hidden' },
        privateNotes: { type: 'string', 'x-scan': 'hidden' },
      },
    };
    const active = kit.registry.add({
      id: pinned.id,
      orgId: kit.org.id,
      version: 'v2',
      manifest,
      passJson: { ...pinned.passJson, description: 'A different historical artifact' },
      assets: { 'icon.png': ICON_PNG },
    });
    const activeKey = await templateBuildKey(active);
    expect(activeKey).not.toBe(pinnedKey);
    await insertVersion(active, activeKey);
    await approveAppleRelease(kit, {
      orgId: kit.org.id,
      mode: 'live',
      templateId: pinned.id,
      version: active.version,
    });

    const list = await page(`?orgId=${kit.org.id}&limit=1`);
    expect(list.items).toHaveLength(1);
    expect(list.items[0]).toMatchObject({
      id: synthetic.id,
      passId: null,
      templateId: null,
      passTitle: null,
      kind: null,
      actionId: null,
      actionLabel: null,
      amount: null,
      passVersion: null,
      outcome: 'ok',
      reason: null,
      before: null,
      after: null,
    });
    if (!list.nextCursor) throw new Error('A second history page must have a continuation.');
    expect(list.nextCursor).not.toContain(synthetic.id);
    const rest = await page(
      `?orgId=${kit.org.id}&limit=2&cursor=${encodeURIComponent(list.nextCursor)}`,
    );
    expect(rest.items.map((item) => item.id)).toEqual([row.id, first.id]);
    expect(rest.nextCursor).toBeNull();
    expect(rest.items[0]).toMatchObject({
      id: row.id,
      passId: null,
      templateId: null,
      passTitle: null,
      kind: null,
      actionId: null,
      actionLabel: null,
      amount: null,
      passVersion: null,
      outcome: 'heads_up',
      reason: 'already_done',
      before: null,
      after: null,
    });
    expect(JSON.stringify(list)).not.toContain(pass.id);
    expect(JSON.stringify(list)).not.toContain(pinned.id);
    expectNoSecrets(list, pass);
    const detail = await get(`/${row.id}`);
    expect(detail.status).toBe(200);
    const detailBody = await detail.json();
    ScanRecordSchema.parse(detailBody);
    expect(detailBody).toMatchObject({
      id: row.id,
      passId: null,
      templateId: null,
      passTitle: null,
      kind: null,
      actionId: null,
      actionLabel: null,
      amount: null,
      passVersion: null,
      outcome: 'heads_up',
      reason: 'already_done',
      before: null,
      after: null,
    });
    expect(JSON.stringify(detailBody)).not.toContain(pass.id);
    expectNoSecrets(detailBody, pass);
    const apiKey = fake.apiKey({ orgId: kit.org.id, scopes: ['scans:read'] });
    const feed = await page('', apiKey);
    expect(feed.items.map((item) => item.id)).toEqual([synthetic.id, row.id, first.id]);
    expect(feed.items[1]).toMatchObject({
      passId: null,
      templateId: null,
      kind: null,
      actionId: null,
      amount: null,
      outcome: 'heads_up',
      reason: 'already_done',
      before: null,
      after: null,
    });
    expectNoSecrets(feed, pass);
    const response = await get(exportPath());
    expect(response.status).toBe(200);
    const csv = await response.text();
    expect(
      csv
        .replace(/^\uFEFF/, '')
        .trimEnd()
        .split('\r\n'),
    ).toHaveLength(4);
    expect(csv).toContain(new Date(row.at).toISOString());
    expect(csv).not.toContain('Tier change');
    expect(csv).not.toContain(pass.id);
    expectNoSecrets(csv, pass);
    expect(await lastExportCount()).toBe(3);
  });

  it.each(['list', 'detail', 'export'] as const)(
    'does not return a stale %s projection when the approved head changes during its read',
    async (kind) => {
      const scanner = await kit.scanner({ templateIds: [templateId] });
      const pass = await privatePass();
      const row = await recordedCheckIn(scanner, pass.id);
      const pinned = await kit.registry.resolve(templateId, 'v1');
      const active = kit.registry.add({
        id: templateId,
        orgId: kit.org.id,
        version: 'v2',
        manifest: structuredClone(pinned.manifest),
        passJson: pinned.passJson,
        assets: { 'icon.png': ICON_PNG },
      });
      await insertVersion(active, initialBuildKey);
      const db = kit.env.DB;
      let intercepted = 0;
      const wrap = (statement: D1PreparedStatement, sql: string): D1PreparedStatement =>
        new Proxy(statement, {
          get(target, member) {
            if (member === 'bind')
              return (...values: unknown[]) => wrap(target.bind(...values), sql);
            if (member === 'all')
              return async () => {
                const result = await target.all();
                // The history proof read: the head moves before the final fence.
                if (intercepted === 0 && sql.includes('WITH ids(id) AS (VALUES')) {
                  intercepted++;
                  await approveAppleRelease(kit, {
                    orgId: kit.org.id,
                    mode: 'live',
                    templateId,
                    version: active.version,
                    db,
                  });
                }
                return result;
              };
            const value = Reflect.get(target, member, target);
            return typeof value === 'function' ? value.bind(target) : value;
          },
        });
      const proxy = new Proxy(db, {
        get(target, property) {
          if (property === 'prepare') return (sql: string) => wrap(target.prepare(sql), sql);
          const value = Reflect.get(target, property, target);
          return typeof value === 'function' ? value.bind(target) : value;
        },
      });
      Object.assign(kit.env, { DB: proxy });
      let response: Response;
      let text: string;
      try {
        const path =
          kind === 'list'
            ? `?orgId=${kit.org.id}`
            : kind === 'detail'
              ? `/${row.id}`
              : exportPath();
        response = await get(path);
        text = await response.text();
      } finally {
        Object.assign(kit.env, { DB: db });
      }
      expect(intercepted).toBe(1);
      expect(response.status).toBe(200);
      expectNoSecrets(text, pass);
      expect(text).not.toContain(PUBLIC);
      expect(text).not.toContain(pass.id);
      expect(text).not.toContain(templateId);
      const redacted = {
        id: row.id,
        passId: null,
        templateId: null,
        passTitle: null,
        kind: null,
        actionId: null,
        actionLabel: null,
        amount: null,
        before: null,
        after: null,
        outcome: 'ok',
        reason: null,
      };
      if (kind === 'list') {
        expect(JSON.parse(text)).toMatchObject({ items: [redacted], nextCursor: null });
      } else if (kind === 'detail') {
        expect(JSON.parse(text)).toMatchObject(redacted);
      } else {
        expect(
          text
            .replace(/^\uFEFF/, '')
            .trimEnd()
            .split('\r\n'),
        ).toHaveLength(2);
        expect(text).toContain(new Date(row.at).toISOString());
      }
      const fresh = await get(`/${row.id}`);
      expect(fresh.status).toBe(200);
      expect(await fresh.json()).toMatchObject({ id: row.id, passId: pass.id, passTitle: PUBLIC });
    },
  );
});
