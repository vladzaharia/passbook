import { describe, expect, it } from 'vitest';
import { makeOrg, persistTemplate, runOne } from '../../../../test/helpers/index.ts';
import type { ResolvedTemplate } from '../../../passkit/template/registry.ts';
import { first, run } from '../../platform/db.ts';
import { ICON_PNG } from '../passes/pass-test-fixtures.ts';
import { recordedCheckIn } from './console-privacy-actions-test-fixtures.ts';
import {
  app,
  exportPath,
  fake,
  get,
  kit,
  lastExportCount,
  page,
  privatePass,
  seedScan,
  setupPrivacyKit,
  templateId,
} from './console-privacy-test-fixtures.ts';
import { ORIGIN } from './test-kit.ts';

setupPrivacyKit();

describe('scan console and feed privacy', () => {
  it('filters optional IDs only when the corresponding pass-bound row proves their provenance', async () => {
    const event = await kit.event({ templateIds: [templateId] });
    const staff = await kit.staff('manager');
    const scanner = await kit.scanner({
      eventId: event.id,
      templateIds: [templateId],
      staffId: staff.id,
      settings: { staffSignIn: true },
    });
    const pass = await privatePass();
    const proven = await recordedCheckIn(scanner, pass.id);
    const unproven = await seedScan({ scanner, passId: pass.id, passVersion: pass.version });
    await run(kit.env.DB, 'UPDATE scans SET event_id = ?, staff_id = ? WHERE id = ?', [
      event.id,
      staff.id,
      unproven.id,
    ]);
    const rows = (await page(`?orgId=${kit.org.id}`)).items;
    expect(rows.find((item) => item.id === proven.id)).toMatchObject({
      eventId: event.id,
      scannerId: scanner.id,
      staffId: staff.id,
    });
    expect(rows.find((item) => item.id === unproven.id)).toMatchObject({
      eventId: null,
      scannerId: null,
      staffId: null,
    });
    const apiKey = fake.apiKey({ orgId: kit.org.id, scopes: ['scans:read'] });
    const feed = await page('', apiKey);
    expect(feed.items.find((item) => item.id === unproven.id)).toMatchObject({
      eventId: null,
      scannerId: null,
    });
    for (const [name, id] of [
      ['eventId', event.id],
      ['scannerId', scanner.id],
      ['staffId', staff.id],
    ] as const) {
      const query = `${name}=${encodeURIComponent(id)}`;
      expect((await page(`?orgId=${kit.org.id}&${query}`)).items.map((item) => item.id)).toEqual([
        proven.id,
      ]);
      const keyRows = (await page(`?${query}`, apiKey)).items;
      expect(keyRows.map((item) => item.id)).toEqual(name === 'staffId' ? [] : [proven.id]);
      const exported = await get(exportPath(`&${query}`));
      expect(exported.status).toBe(200);
      const csv = await exported.text();
      expect(csv).toContain(new Date(proven.at).toISOString());
      expect(csv).not.toContain(new Date(unproven.at).toISOString());
      expect(await lastExportCount()).toBe(1);
    }
  });

  it.each(['undoes', 'undone_by', 'override_of'] as const)(
    'excludes same-scope scans with a cross-pass %s reference',
    async (column) => {
      const scanner = await kit.scanner({ templateIds: [templateId] });
      const pass = await privatePass();
      const otherPass = await kit.scanPass(templateId, { memberName: 'Other guest' });
      const keep = await recordedCheckIn(scanner, pass.id);
      const linked = await recordedCheckIn(scanner, pass.id);
      const other = await recordedCheckIn(scanner, otherPass.id);
      // A legacy passless row is not independently eligible for ledger history.
      const orphan = await seedScan({
        scanner,
        passId: null,
        templateId,
        actionId: 'check_in',
        actionKind: 'check_in',
        passVersion: 1,
      });
      await run(kit.env.DB, "UPDATE scans SET outcome = 'ok', reason = NULL WHERE id = ?", [
        orphan.id,
      ]);
      const apiKey = fake.apiKey({ orgId: kit.org.id, scopes: ['scans:read'] });

      // A same-pass reference remains ledger-visible even if its event proof is no longer usable.
      await runOne(kit.env.DB, `UPDATE scans SET ${column} = ? WHERE id = ?`, [keep.id, linked.id]);
      expect((await page(`?orgId=${kit.org.id}`)).items.map((row) => row.id)).toEqual([
        other.id,
        linked.id,
        keep.id,
      ]);
      expect((await get(`/${linked.id}`)).status).toBe(200);

      for (const targetId of [other.id, orphan.id]) {
        await runOne(kit.env.DB, `UPDATE scans SET ${column} = ? WHERE id = ?`, [
          targetId,
          linked.id,
        ]);
        expect((await page(`?orgId=${kit.org.id}`)).items.map((row) => row.id)).toEqual([
          other.id,
          keep.id,
        ]);
        expect(
          (await page(`?orgId=${kit.org.id}&passId=${pass.id}`)).items.map((row) => row.id),
        ).toEqual([keep.id]);
        expect((await get(`/${linked.id}`)).status).toBe(404);
        expect((await get(`/${keep.id}`)).status).toBe(200);
        expect((await get(`/${other.id}`)).status).toBe(200);
        expect((await page('', apiKey)).items.map((row) => row.id)).toEqual([other.id, keep.id]);

        const exported = await get(exportPath());
        expect(exported.status).toBe(200);
        const csv = await exported.text();
        expect(
          csv
            .replace(/^\uFEFF/, '')
            .trimEnd()
            .split('\r\n'),
        ).toHaveLength(3);
        expect(csv).toContain(new Date(keep.at).toISOString());
        expect(csv).toContain(new Date(other.at).toISOString());
        expect(csv).not.toContain(new Date(linked.at).toISOString());
        expect(await lastExportCount()).toBe(2);
        const filtered = await get(exportPath(`&passId=${pass.id}`));
        expect(filtered.status).toBe(200);
        expect(
          (await filtered.text())
            .replace(/^\uFEFF/, '')
            .trimEnd()
            .split('\r\n'),
        ).toHaveLength(2);
        expect(await lastExportCount()).toBe(1);

        const recent = await app.request(
          `${ORIGIN}/api/v1/scan/scans?limit=10`,
          { headers: scanner.headers },
          kit.env,
        );
        expect(recent.status).toBe(200);
        const recentBody = (await recent.json()) as { items: { scanId: string }[] };
        expect(recentBody.items.map((row) => row.scanId)).toEqual([other.id, keep.id]);
        const summary = await app.request(
          `${ORIGIN}/api/v1/scan/summary`,
          { headers: scanner.headers },
          kit.env,
        );
        expect(summary.status).toBe(200);
        expect(await summary.json()).toMatchObject({
          total: 2,
          ok: 2,
          byAction: [{ actionId: 'check_in', label: 'Check in', count: 2 }],
        });
      }

      // Missing references are retained rather than treated as an existing foreign link.
      await runOne(kit.env.DB, `UPDATE scans SET ${column} = ? WHERE id = ?`, [
        kit.fx.ids.id(),
        linked.id,
      ]);
      expect((await page(`?orgId=${kit.org.id}`)).items.map((row) => row.id)).toEqual([
        other.id,
        linked.id,
        keep.id,
      ]);
      expect((await get(`/${linked.id}`)).status).toBe(200);
    },
  );

  it('excludes pass history with foreign template, connection, or signing identity provenance', async () => {
    const scanner = await kit.scanner({ templateIds: [templateId] });
    const pass = await privatePass();
    const valid = await recordedCheckIn(scanner, pass.id);
    const otherOrg = await makeOrg(kit.fx);
    const base = await kit.registry.resolve(templateId, 'v1');
    const foreignTemplate = kit.registry.add({
      id: kit.fx.ids.id(),
      orgId: otherOrg.id,
      version: base.version,
      manifest: base.manifest,
      passJson: base.passJson,
      assets: { 'icon.png': ICON_PNG },
    });
    const globalTemplate = kit.registry.add({
      id: kit.fx.ids.id(),
      orgId: null,
      version: base.version,
      manifest: base.manifest,
      passJson: base.passJson,
      assets: { 'icon.png': ICON_PNG },
    });
    await persistTemplate(kit.fx, foreignTemplate, { registry: kit.registry });
    await persistTemplate(kit.fx, globalTemplate, { registry: kit.registry });

    const foreignConnection = kit.fx.ids.id();
    await run(
      kit.env.DB,
      `INSERT INTO connections
      (id, org_id, connector_type, name, created_at, updated_at) VALUES (?, ?, 'fixture', 'Foreign', ?, ?)`,
      [foreignConnection, otherOrg.id, kit.clock.now(), kit.clock.now()],
    );
    const foreignIdentity = kit.fx.ids.id();
    await run(
      kit.env.DB,
      `INSERT INTO signing_identities
      (id, org_id, label, pass_type_identifier, team_identifier, source, env_prefix, created_at)
      VALUES (?, ?, 'Foreign', ?, 'FOREIGNTEAM', 'env', 'FOREIGN', ?)`,
      [foreignIdentity, otherOrg.id, `pass.foreign.${kit.fx.ids.token(8)}`, kit.clock.now()],
    );
    expect(
      await first(kit.env.DB, 'SELECT org_id FROM signing_identities WHERE id = ?', [
        pass.identityId,
      ]),
    ).toEqual({ org_id: null });

    // Insert the inconsistent legacy provenance directly: credential identity is immutable after insertion.
    const legacyPass = async (
      template: ResolvedTemplate,
      identityId: string,
      connectionId: string | null = null,
    ) => {
      const id = kit.fx.ids.id();
      const now = kit.clock.now();
      await run(
        kit.env.DB,
        `INSERT INTO passes
        (id, org_id, identity_id, serial, template_id, template_version, auth_token, download_token,
         web_service_url, personalization, object_key, modified_at, created_at, mode, connection_id)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, '{}', ?, ?, ?, 'live', ?)`,
        [
          id,
          kit.org.id,
          identityId,
          kit.fx.ids.token(16),
          template.id,
          template.version,
          kit.fx.ids.token(),
          kit.fx.ids.token(),
          `${ORIGIN}/wallet`,
          `passes/${id}/legacy.pkpass`,
          now,
          now,
          connectionId,
        ],
      );
      return id;
    };
    const cases = [
      {
        kind: 'template',
        passId: await legacyPass(foreignTemplate, pass.identityId),
        template: foreignTemplate,
      },
      {
        kind: 'connection',
        passId: await legacyPass(base, pass.identityId, foreignConnection),
        template: base,
      },
      { kind: 'identity', passId: await legacyPass(base, foreignIdentity), template: base },
    ] as const;
    const hidden: { id: string; at: number }[] = [];
    const connectionRows: { id: string; at: number }[] = [];
    for (const entry of cases) {
      for (const scanTemplate of [null, entry.template.id]) {
        const row = await seedScan({ scanner, passId: entry.passId, templateId: scanTemplate });
        hidden.push(row);
        if (entry.kind === 'connection') connectionRows.push(row);
      }
    }
    const globalPass = await legacyPass(globalTemplate, pass.identityId);
    const global = await seedScan({ scanner, passId: globalPass, templateId: null });
    const apiKey = fake.apiKey({ orgId: kit.org.id, scopes: ['scans:read'] });
    const expected = [global.id, valid.id];
    expect((await page(`?orgId=${kit.org.id}`)).items.map((row) => row.id)).toEqual(expected);
    expect((await page('', apiKey)).items.map((row) => row.id)).toEqual(expected);
    for (const row of hidden) expect((await get(`/${row.id}`)).status).toBe(404);
    const globalDetail = await get(`/${global.id}`);
    expect(globalDetail.status).toBe(200);
    expect(await globalDetail.json()).toMatchObject({
      id: global.id,
      passId: null,
      templateId: null,
    });
    const firstPage = await page(`?orgId=${kit.org.id}&limit=1`);
    expect(firstPage.items.map((row) => row.id)).toEqual([global.id]);
    if (!firstPage.nextCursor) throw new Error('The visible history must have a second page.');
    expect(
      (
        await page(
          `?orgId=${kit.org.id}&limit=1&cursor=${encodeURIComponent(firstPage.nextCursor)}`,
        )
      ).items.map((row) => row.id),
    ).toEqual([valid.id]);

    const exported = await get(exportPath());
    expect(exported.status).toBe(200);
    const csv = await exported.text();
    expect(
      csv
        .replace(/^\uFEFF/, '')
        .trimEnd()
        .split('\r\n'),
    ).toHaveLength(3);
    for (const row of hidden) expect(csv).not.toContain(new Date(row.at).toISOString());
    expect(await lastExportCount()).toBe(2);
    const summary = await app.request(
      `${ORIGIN}/api/v1/scan/summary`,
      { headers: scanner.headers },
      kit.env,
    );
    expect(summary.status).toBe(200);
    expect(await summary.json()).toMatchObject({ total: 2, ok: 2 });

    // A deleted connection is set to NULL by the FK and no longer makes its pass foreign.
    await runOne(kit.env.DB, 'DELETE FROM connections WHERE id = ?', [foreignConnection]);
    expect(
      await first(kit.env.DB, 'SELECT connection_id FROM passes WHERE id = ?', [cases[1].passId]),
    ).toEqual({ connection_id: null });
    const restored = [global.id, ...connectionRows.map((row) => row.id).reverse(), valid.id];
    expect((await page(`?orgId=${kit.org.id}`)).items.map((row) => row.id)).toEqual(restored);
    expect((await page('', apiKey)).items.map((row) => row.id)).toEqual(restored);
    for (const row of connectionRows) {
      const detail = await get(`/${row.id}`);
      expect(detail.status).toBe(200);
      expect(await detail.json()).toMatchObject({ id: row.id, passId: null, templateId: null });
    }
    const after = await get(exportPath());
    expect(after.status).toBe(200);
    expect(
      (await after.text())
        .replace(/^\uFEFF/, '')
        .trimEnd()
        .split('\r\n'),
    ).toHaveLength(5);
    expect(await lastExportCount()).toBe(4);
  });
});
