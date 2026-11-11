import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { stagePendingCredentialTransfer } from '../../../../test/helpers/credential-transfer.ts';
import { makeSession, makeUser, persistTemplate } from '../../../../test/helpers/index.ts';
import { ScanRecordSchema } from '../../../shared/contracts/scanners.ts';
import { first, run } from '../../platform/db.ts';
import { approveAppleRelease } from '../passes/apple-release-test-fixtures.ts';
import { ICON_PNG } from '../passes/pass-test-fixtures.ts';
import { recordedCheckIn } from './console-privacy-actions-test-fixtures.ts';
import {
  app,
  EMAIL,
  expectNoSecrets,
  exportPath,
  fake,
  get,
  HIDDEN,
  kit,
  lastExportCount,
  MANAGER,
  PUBLIC,
  page,
  privatePass,
  setupPrivacyKit,
  templateId,
} from './console-privacy-test-fixtures.ts';
import { grantScanMembership, ORIGIN, startScanCredentialTransfer } from './test-kit.ts';

setupPrivacyKit();

describe('scan console and feed privacy', () => {
  it.each(['rotation', 'pending transfer'] as const)(
    'redacts prior scan history after %s',
    async (change) => {
      const scanner = await kit.scanner({ templateIds: [templateId] });
      const pass = await privatePass();
      const row = await recordedCheckIn(scanner, pass.id);
      const event = await first<{ data: string }>(
        kit.env.DB,
        "SELECT data FROM pass_events WHERE pass_id = ? AND json_extract(data, '$.scanId') = ?",
        [pass.id, row.id],
      );
      if (!event) throw new Error('A recorded scan must have its pass event.');
      const authority = z
        .object({
          authority: z.object({
            credentialGeneration: z.number().int().positive(),
            noPendingTransfer: z.literal(true),
          }),
        })
        .parse(JSON.parse(event.data)).authority;
      expect((await page(`?orgId=${kit.org.id}`)).items[0]).toMatchObject({
        id: row.id,
        passId: pass.id,
        passTitle: PUBLIC,
        actionId: 'check_in',
      });
      if (change === 'rotation') {
        expect(
          await startScanCredentialTransfer(kit, pass.id, {
            target: { holderEmail: 'incoming@example.test', ownerUserId: null },
          }),
        ).toMatchObject({ state: 'completed' });
        expect(
          await first(kit.env.DB, 'SELECT credential_generation FROM passes WHERE id = ?', [
            pass.id,
          ]),
        ).toEqual({ credential_generation: authority.credentialGeneration + 1 });
      } else {
        const transferId = kit.fx.ids.ordered();
        await stagePendingCredentialTransfer(kit.env.DB, pass.id, {
          id: transferId,
          token: kit.fx.ids.token(),
          now: kit.clock.now(),
          targetHolderEmail: 'incoming@example.test',
        });
        expect(
          await first(
            kit.env.DB,
            'SELECT state, source_generation, target_generation FROM pass_credential_transfers WHERE id = ?',
            [transferId],
          ),
        ).toEqual({
          state: 'pending',
          source_generation: authority.credentialGeneration,
          target_generation: authority.credentialGeneration + 1,
        });
        expect(
          await first(kit.env.DB, 'SELECT credential_generation FROM passes WHERE id = ?', [
            pass.id,
          ]),
        ).toEqual({ credential_generation: authority.credentialGeneration + 1 });
      }

      const history = await page(`?orgId=${kit.org.id}`);
      expect(history.items).toHaveLength(1);
      expect(history.items[0]).toMatchObject({
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
      });
      const detail = await get(`/${row.id}`);
      expect(detail.status).toBe(200);
      expect(await detail.json()).toMatchObject({
        id: row.id,
        passId: null,
        passTitle: null,
        kind: null,
      });
      for (const query of [
        `q=${encodeURIComponent(PUBLIC)}`,
        `q=${encodeURIComponent(pass.id)}`,
        `passId=${pass.id}`,
      ])
        expect((await page(`?orgId=${kit.org.id}&${query}`)).items).toEqual([]);
      const apiKey = fake.apiKey({ orgId: kit.org.id, scopes: ['scans:read'] });
      expect((await page('', apiKey)).items[0]).toMatchObject({
        id: row.id,
        passId: null,
        templateId: null,
        kind: null,
      });
      expect((await page(`?passId=${pass.id}`, apiKey)).items).toEqual([]);
      const exported = await get(exportPath());
      expect(exported.status).toBe(200);
      const csv = await exported.text();
      expect(
        csv
          .replace(/^\uFEFF/, '')
          .trimEnd()
          .split('\r\n'),
      ).toHaveLength(2);
      expect(csv).not.toContain(PUBLIC);
      expect(csv).not.toContain(pass.id);
      expect(await lastExportCount()).toBe(1);
      const filtered = await get(exportPath(`&passId=${pass.id}`));
      expect(filtered.status).toBe(200);
      expect(
        (await filtered.text())
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
      expect(await summary.json()).toMatchObject({ total: 1, ok: 1, byAction: [] });
    },
  );

  it('discloses only a scanner name committed for the viewer and still safe now', async () => {
    const staff = await kit.staff('manager');
    const scanner = await kit.scanner({
      templateIds: [templateId],
      staffId: staff.id,
      settings: { staffSignIn: true },
    });
    await run(kit.env.DB, 'UPDATE scanners SET name = ? WHERE id = ?', [
      'North entrance',
      scanner.id,
    ]);
    const pass = await privatePass();
    const original = await recordedCheckIn(scanner, pass.id);
    const firstPage = await page(`?orgId=${kit.org.id}`);
    expect(firstPage.items[0]).toMatchObject({ id: original.id, scannerName: 'North entrance' });
    const event = await first<{ data: string }>(
      kit.env.DB,
      "SELECT data FROM pass_events WHERE pass_id = ? AND json_extract(data, '$.scanId') = ?",
      [pass.id, original.id],
    );
    if (!event) throw new Error('A recorded scan must have its pass event.');
    expect(event.data).not.toContain('North entrance');

    await run(kit.env.DB, 'UPDATE scanners SET name = ? WHERE id = ?', [EMAIL, scanner.id]);
    const changed = await page(`?orgId=${kit.org.id}`);
    expect(changed.items[0]).toMatchObject({ id: original.id, scannerName: null });
    expectNoSecrets(changed, pass);
    const detail = await get(`/${original.id}`);
    expect(detail.status).toBe(200);
    expect(await detail.json()).toMatchObject({ scannerName: null });
    const exported = await get(exportPath());
    expect(exported.status).toBe(200);
    expectNoSecrets(await exported.text(), pass);

    await run(kit.env.DB, 'UPDATE scanners SET name = ? WHERE id = ?', [
      'West entrance',
      scanner.id,
    ]);
    const next = await recordedCheckIn(scanner, pass.id);
    const history = await page(`?orgId=${kit.org.id}`);
    expect(history.items.find((item) => item.id === original.id)).toMatchObject({
      scannerName: null,
    });
    expect(history.items.find((item) => item.id === next.id)).toMatchObject({
      scannerName: 'West entrance',
    });
  });

  it('redacts independently restricted event actions and titles without hiding proven pass scope', async () => {
    const base = await kit.registry.resolve(templateId, 'v1');
    const titleRestricted = kit.registry.add({
      id: kit.fx.ids.id(),
      orgId: kit.org.id,
      manifest: { ...base.manifest, display: { ...base.manifest.display, title: '{{tier}}' } },
      passJson: base.passJson,
      assets: { 'icon.png': ICON_PNG },
    });
    await persistTemplate(kit.fx, titleRestricted, { registry: kit.registry });
    await approveAppleRelease(kit, {
      orgId: kit.org.id,
      mode: 'live',
      templateId: titleRestricted.id,
      version: titleRestricted.version,
    });
    const actionPass = await privatePass();
    const titlePass = await kit.scanPass(titleRestricted.id, {
      memberName: PUBLIC,
      tier: MANAGER,
      privateNotes: HIDDEN,
    });
    const staff = await kit.staff('manager');
    const scanner = await kit.scanner({
      templateIds: [templateId, titleRestricted.id],
      staffId: staff.id,
      settings: { staffSignIn: true },
    });
    const actionRow = await recordedCheckIn(scanner, actionPass.id, 'manager_only');
    const titleRow = await recordedCheckIn(scanner, titlePass.id);
    const viewer = await makeUser(kit.fx);
    await grantScanMembership(kit.fx, kit.org.id, viewer.id, ['read_only']);
    const viewerHeaders = {
      ...(await makeSession(kit.fx, { userId: viewer.id })).headers,
      origin: ORIGIN,
    };

    const rows = (await page(`?orgId=${kit.org.id}`, viewerHeaders)).items;
    expect(rows.find((item) => item.id === actionRow.id)).toMatchObject({
      id: actionRow.id,
      passId: actionPass.id,
      templateId,
      passTitle: PUBLIC,
      kind: null,
      direction: null,
      actionId: null,
      actionLabel: null,
    });
    expect(rows.find((item) => item.id === titleRow.id)).toMatchObject({
      id: titleRow.id,
      passId: titlePass.id,
      templateId: titleRestricted.id,
      passTitle: null,
      kind: 'check_in',
      actionId: 'check_in',
      actionLabel: 'Check in',
    });
    for (const [id, expected] of [
      [actionRow.id, { passId: actionPass.id, passTitle: PUBLIC, kind: null, actionId: null }],
      [
        titleRow.id,
        { passId: titlePass.id, passTitle: null, kind: 'check_in', actionId: 'check_in' },
      ],
    ] as const) {
      const detail = await get(`/${id}`, viewerHeaders);
      expect(detail.status).toBe(200);
      expect(await detail.json()).toMatchObject(expected);
    }
    expect(
      (await page(`?orgId=${kit.org.id}&q=${encodeURIComponent(PUBLIC)}`, viewerHeaders)).items.map(
        (item) => item.id,
      ),
    ).toEqual([actionRow.id]);
    expect(
      (await page(`?orgId=${kit.org.id}&q=${encodeURIComponent(MANAGER)}`, viewerHeaders)).items,
    ).toEqual([]);
    const csv = await get(exportPath(), viewerHeaders);
    expect(csv.status).toBe(200);
    const text = await csv.text();
    expect(text).toContain(PUBLIC);
    expect(text).toContain('Check in');
    expect(text).not.toContain(MANAGER);
    expect(text).not.toContain('Manager entry');
    const managerRows = (await page(`?orgId=${kit.org.id}`)).items;
    expect(managerRows.find((item) => item.id === actionRow.id)).toMatchObject({
      passId: actionPass.id,
      passTitle: PUBLIC,
      actionId: 'manager_only',
      actionLabel: 'Manager entry',
    });
    expect(managerRows.find((item) => item.id === titleRow.id)).toMatchObject({
      passId: titlePass.id,
      passTitle: MANAGER,
      actionId: 'check_in',
      actionLabel: 'Check in',
    });
  });

  it.each(['removed', 'tampered'] as const)(
    'retains immutable ledger facts but redacts pass data when the signed event projection is %s',
    async (change) => {
      const scanner = await kit.scanner({ templateIds: [templateId] });
      const pass = await privatePass();
      const row = await recordedCheckIn(scanner, pass.id);
      const sql =
        change === 'removed'
          ? "json_remove(data, '$.authority.eventProjection')"
          : "json_set(data, '$.authority.eventProjection', json(?))";
      const args =
        change === 'removed'
          ? [row.id]
          : [
              JSON.stringify({
                v: 1,
                roles: {
                  manager: {
                    action: { id: 'check_in', label: HIDDEN, kind: 'check_in' },
                    scannerName: null,
                  },
                },
              }),
              row.id,
            ];
      expect(
        await run(
          kit.env.DB,
          `UPDATE pass_events SET data = ${sql} WHERE json_valid(data)
          AND json_extract(data, '$.scanId') = ?`,
          args,
        ),
      ).toEqual({ changes: 1 });

      const detailResponse = await get(`/${row.id}`);
      expect(detailResponse.status).toBe(200);
      const detail = await detailResponse.json();
      ScanRecordSchema.parse(detail);
      expect(detail).toMatchObject({
        id: row.id,
        at: row.at,
        outcome: 'ok',
        actor: { type: 'scanner', id: scanner.id },
        passId: null,
        passTitle: null,
        templateId: null,
        templateName: null,
        kind: null,
        actionId: null,
        actionLabel: null,
        scannerName: null,
        amount: null,
        before: null,
        after: null,
        passVersion: null,
      });
      expectNoSecrets(detail, pass);
      const listed = await page(`?orgId=${kit.org.id}`);
      expect(listed.items).toHaveLength(1);
      expect(listed.items[0]).toMatchObject({ id: row.id, passId: null, passTitle: null });
      expect((await page(`?orgId=${kit.org.id}&passId=${pass.id}`)).items).toEqual([]);
      expect((await page(`?orgId=${kit.org.id}&q=${encodeURIComponent(PUBLIC)}`)).items).toEqual(
        [],
      );

      const apiKey = fake.apiKey({ orgId: kit.org.id, scopes: ['scans:read'] });
      const feed = await page('', apiKey);
      expect(feed.items).toHaveLength(1);
      expect(feed.items[0]).toMatchObject({
        id: row.id,
        passId: null,
        templateId: null,
        kind: null,
        actionId: null,
      });
      expect((await page(`?passId=${pass.id}`, apiKey)).items).toEqual([]);
      const exported = await get(exportPath());
      expect(exported.status).toBe(200);
      const csv = await exported.text();
      expect(csv).toContain(new Date(row.at).toISOString());
      expect(csv).not.toContain(PUBLIC);
      expectNoSecrets(csv, pass);
      expect(await lastExportCount()).toBe(1);
      const filteredExport = await get(exportPath(`&passId=${pass.id}`));
      expect(filteredExport.status).toBe(200);
      expect(
        (await filteredExport.text())
          .replace(/^\uFEFF/, '')
          .trimEnd()
          .split('\r\n'),
      ).toHaveLength(1);
      expect(await lastExportCount()).toBe(0);
    },
  );
});
