import { beforeAll, describe, expect, it } from 'vitest';
import type { ScannerFixture } from '../../../../test/helpers/index.ts';
import { run } from '../../platform/db.ts';
import { jobCtxOf } from '../delivery/delivery-test-fixtures.ts';
import { setOrgBranding, setOrgStatus } from '../orgs/repo.ts';
import { deleteMemberPhoto, putMemberPhoto } from '../passes/member-photo.ts';
import { makePng } from '../templates/package/fixtures.ts';
import { setTemplateStatus } from '../templates/testing.ts';
import { assetActorFor, genericAssetGrantFor, photoAssetGrantFor } from './asset-test-fixtures.ts';
import { assetGrantValid, mintAssetGrant } from './assets.ts';
import { candidateById } from './repo-lookup.ts';
import { updateScannerStmt } from './repo-scanners-test-support.ts';
import { updateStaffStmt } from './repo-staff-test-support.ts';
import { type ScanKit, setupScanKit } from './test-kit.ts';

let kit: ScanKit;
let template: string;
const system = { type: 'system' as const, id: null };
const png = makePng(270, 270);
const encoded = btoa(String.fromCharCode(...png));

beforeAll(async () => {
  kit = await setupScanKit();
  template = await kit.scanTemplate('Asset lineage', {
    actions: [{ id: 'check_in', label: 'Check in', kind: 'check_in' }],
  });
});

async function photoPass(scanner?: ScannerFixture) {
  const device = scanner ?? (await kit.scanner({ templateIds: [template] }));
  const pass = await kit.scanPass(template);
  await putMemberPhoto(jobCtxOf(kit), system, pass.id, { png: encoded, includeInPass: true }, null);
  const grant = await photoAssetGrantFor(kit, device, pass.id);
  const image = (value = grant) =>
    kit.get(device.headers, `/passes/${pass.id}/assets/member.png?g=${value}`);
  return { device, pass, grant, image };
}

async function missing(response: Response) {
  expect(response.status).toBe(404);
  expect(await response.json()).toMatchObject({ code: 'ASSET_NOT_FOUND' });
}

describe('scanner asset lineage', () => {
  it('uses an opaque, actor-specific proof and masks malformed grants and paths', async () => {
    const { device, pass, grant, image } = await photoPass();
    expect(grant).toMatch(/^[A-Za-z0-9_-]{54}$/);
    expect(grant).not.toContain(device.id);
    expect(grant).not.toContain(pass.id);
    expect((await image()).status).toBe(200);
    await missing(await image(`${grant.slice(0, -1)}!`));
    await missing(await image('x'.repeat(101)));
    await missing(await kit.get(device.headers, `/passes/${pass.id}/assets/bad.jpg?g=${grant}`));
  });

  it.each([
    [
      'download token',
      "UPDATE passes SET download_token = download_token || '-changed' WHERE id = ?",
    ],
    ['artifact digest', "UPDATE passes SET object_sha256 = 'different' WHERE id = ?"],
    ['barcode hash', 'UPDATE passes SET barcode_hash = NULL, revision = revision + 1 WHERE id = ?'],
    [
      'personalization',
      "UPDATE passes SET personalization = json_set(personalization, '$.tier', 'different') WHERE id = ?",
    ],
    [
      'field sources',
      "UPDATE passes SET field_sources = json_set(field_sources, '$.tier', 'manual') WHERE id = ?",
    ],
    ['external reference', "UPDATE passes SET external_ref = 'different' WHERE id = ?"],
  ] as const)(
    'does not redeem a grant after its %s changes without a version change',
    async (_name, sql) => {
      const fixture = await photoPass();
      await run(kit.env.DB, sql, [fixture.pass.id]);
      await missing(await fixture.image());
    },
  );

  it.each([
    [
      'holder',
      'holderEmail',
      'different@example.test',
      "UPDATE passes SET holder_email = 'different@example.test' WHERE id = ?",
    ],
    ['scan code', 'scanCode', null, 'UPDATE passes SET scan_code = NULL WHERE id = ?'],
  ] as const)(
    'rejects a forged %s snapshot and the forbidden direct credential change',
    async (_name, field, value, sql) => {
      const fixture = await photoPass();
      const actor = await assetActorFor(kit, fixture.device);
      const candidate = await candidateById(kit.env.DB, kit.org.id, fixture.pass.id);
      if (!candidate) throw new Error('Pass fixture missing');
      const forged = { ...candidate, pass: { ...candidate.pass, [field]: value } };
      expect(
        await assetGrantValid(
          kit.ctx,
          actor,
          forged,
          forged.connectionGeneration,
          fixture.grant,
          undefined,
          'commit',
          true,
        ),
      ).toBe(false);
      await expect(run(kit.env.DB, sql, [fixture.pass.id])).rejects.toThrow();
      expect((await fixture.image()).status).toBe(200);
    },
  );

  it('stops serving a generic asset when scanner template scope is removed', async () => {
    const fixture = await photoPass();
    const grant = await genericAssetGrantFor(kit, fixture.device, fixture.pass.id);
    const image = () =>
      kit.get(fixture.device.headers, `/passes/${fixture.pass.id}/assets/icon.png?g=${grant}`);
    const before = await image();
    expect(before.status).toBe(200);
    await before.body?.cancel();
    await run(kit.env.DB, 'DELETE FROM scanner_templates WHERE scanner_id = ?', [
      fixture.device.id,
    ]);
    await missing(await image());
  });

  it.each(['icon.png', 'member.png', 'thumbnail@3x.png'] as const)(
    'does not revive an old %s grant after scanner photo policy changes and is restored',
    async (name) => {
      const fixture = await photoPass();
      const row = await kit.env.DB.prepare('SELECT settings FROM scanners WHERE id = ?')
        .bind(fixture.device.id)
        .first<{ settings: string }>();
      if (!row) throw new Error('Scanner fixture missing');
      const image = (grant: string) =>
        kit.get(fixture.device.headers, `/passes/${fixture.pass.id}/assets/${name}?g=${grant}`);
      const grantFor = name === 'icon.png' ? genericAssetGrantFor : photoAssetGrantFor;
      const grant =
        name === 'icon.png' ? await grantFor(kit, fixture.device, fixture.pass.id) : fixture.grant;
      const before = await image(grant);
      expect(before.status).toBe(200);
      await before.body?.cancel();
      await updateScannerStmt(
        kit.env.DB,
        fixture.device.id,
        {
          settings: JSON.stringify({ ...JSON.parse(row.settings), showPhoto: false }),
        },
        kit.clock.now(),
      ).run();
      await missing(await image(grant));
      await updateScannerStmt(
        kit.env.DB,
        fixture.device.id,
        { settings: row.settings },
        kit.clock.now(),
      ).run();
      await missing(await image(grant));
      expect((await image(await grantFor(kit, fixture.device, fixture.pass.id))).status).toBe(200);
    },
  );

  it('does not revive an old grant after the same photo is deleted and restored', async () => {
    const { pass, grant, image, device } = await photoPass();
    await deleteMemberPhoto(jobCtxOf(kit), system, pass.id, null);
    await putMemberPhoto(
      jobCtxOf(kit),
      system,
      pass.id,
      { png: encoded, includeInPass: true },
      null,
    );
    await missing(await image(grant));
    expect((await image(await photoAssetGrantFor(kit, device, pass.id))).status).toBe(200);
  });

  it('invalidates a scanner configuration restored in the same clock tick', async () => {
    const fixture = await photoPass();
    const before = await kit.env.DB.prepare('SELECT settings FROM scanners WHERE id = ?')
      .bind(fixture.device.id)
      .first<{ settings: string }>();
    if (!before) throw new Error('Scanner fixture missing');
    const settings = JSON.parse(before.settings) as Record<string, unknown>;
    await updateScannerStmt(
      kit.env.DB,
      fixture.device.id,
      {
        settings: JSON.stringify({ ...settings, showPhoto: false }),
      },
      kit.clock.now(),
    ).run();
    await updateScannerStmt(
      kit.env.DB,
      fixture.device.id,
      { settings: before.settings },
      kit.clock.now(),
    ).run();
    await missing(await fixture.image());
    expect(
      (await fixture.image(await photoAssetGrantFor(kit, fixture.device, fixture.pass.id))).status,
    ).toBe(200);
  });

  it('invalidates a staff role restored in the same clock tick', async () => {
    const staff = await kit.staff('manager');
    const device = await kit.scanner({
      templateIds: [template],
      staffId: staff.id,
      settings: { staffSignIn: true },
    });
    const fixture = await photoPass(device);
    await updateStaffStmt(
      kit.env.DB,
      kit.org.id,
      staff.id,
      { role: 'door' },
      kit.clock.now(),
    ).run();
    await updateStaffStmt(
      kit.env.DB,
      kit.org.id,
      staff.id,
      { role: 'manager' },
      kit.clock.now(),
    ).run();
    await missing(await fixture.image());
    expect(
      (await fixture.image(await photoAssetGrantFor(kit, device, fixture.pass.id))).status,
    ).toBe(200);
  });

  it('invalidates a restored event filter even when its visible scope is unchanged', async () => {
    const event = await kit.event({ templateIds: [template] });
    const device = await kit.scanner({ eventId: event.id });
    const fixture = await photoPass(device);
    await run(
      kit.env.DB,
      `UPDATE scan_events SET match_input = 'tier', match_values = '["gold"]',
      updated_at = updated_at + 1 WHERE id = ?`,
      [event.id],
    );
    await run(
      kit.env.DB,
      `UPDATE scan_events SET match_input = NULL, match_values = NULL,
      updated_at = updated_at + 1 WHERE id = ?`,
      [event.id],
    );
    await missing(await fixture.image());
    expect(
      (await fixture.image(await photoAssetGrantFor(kit, device, fixture.pass.id))).status,
    ).toBe(200);
  });

  it('invalidates a session paused and resumed at the same time', async () => {
    const device = await kit.scanner({ templateIds: [template] });
    const row = await kit.env.DB.prepare('SELECT settings FROM scanners WHERE id = ?')
      .bind(device.id)
      .first<{ settings: string }>();
    if (!row) throw new Error('Scanner fixture missing');
    const id = kit.fx.ids.id();
    await run(
      kit.env.DB,
      `INSERT INTO scanning_sessions
      (id, org_id, mode, name, accepts, settings, time_zone, created_at, updated_at)
      VALUES (?, ?, 'live', 'Asset session', ?, ?, 'UTC', ?, ?)`,
      [
        id,
        kit.org.id,
        JSON.stringify({ templateIds: [template] }),
        row.settings,
        kit.clock.now(),
        kit.clock.now(),
      ],
    );
    await run(
      kit.env.DB,
      `INSERT INTO scanning_devices(scanner_id, session_id, org_id, mode)
      VALUES (?, ?, ?, 'live')`,
      [device.id, id, kit.org.id],
    );
    const fixture = await photoPass(device);
    await run(
      kit.env.DB,
      "UPDATE scanning_sessions SET status = 'paused', updated_at = updated_at + 1 WHERE id = ?",
      [id],
    );
    await run(
      kit.env.DB,
      "UPDATE scanning_sessions SET status = 'active', updated_at = updated_at + 1 WHERE id = ?",
      [id],
    );
    await missing(await fixture.image());
    expect(
      (await fixture.image(await photoAssetGrantFor(kit, device, fixture.pass.id))).status,
    ).toBe(200);
  });

  it.each(['organization status', 'organization branding'] as const)(
    'invalidates an old grant after %s goes away and back in one tick',
    async (change) => {
      const fixture = await photoPass();
      const now = kit.clock.now();
      if (change === 'organization status') {
        await setOrgStatus(kit.env.DB, kit.org.id, 'suspended', now);
        await setOrgStatus(kit.env.DB, kit.org.id, 'active', now);
      } else {
        const row = await kit.env.DB.prepare('SELECT branding FROM orgs WHERE id = ?')
          .bind(kit.org.id)
          .first<{ branding: string }>();
        if (!row) throw new Error('Organization fixture missing');
        await setOrgBranding(kit.env.DB, kit.org.id, '{"color":"#123456"}', now);
        await setOrgBranding(kit.env.DB, kit.org.id, row.branding, now);
      }
      await missing(await fixture.image());
      expect(
        (await fixture.image(await photoAssetGrantFor(kit, fixture.device, fixture.pass.id)))
          .status,
      ).toBe(200);
    },
  );

  // An archived template keeps its passes, so its status is no policy change for them.
  it('keeps an old grant after the template status goes away and back in one tick', async () => {
    const fixture = await photoPass();
    const now = kit.clock.now();
    await setTemplateStatus(kit.env.DB, template, 'archived', now);
    expect((await fixture.image()).status).toBe(200);
    await setTemplateStatus(kit.env.DB, template, 'active', now);
    expect((await fixture.image()).status).toBe(200);
  });

  it('refuses to mint from an evaluated snapshot before a same-tick organization policy ABA', async () => {
    const fixture = await photoPass();
    const actor = await assetActorFor(kit, fixture.device);
    const evaluated = await candidateById(kit.env.DB, kit.org.id, fixture.pass.id);
    if (!evaluated) throw new Error('Pass fixture missing');
    await setOrgStatus(kit.env.DB, kit.org.id, 'suspended', kit.clock.now());
    await setOrgStatus(kit.env.DB, kit.org.id, 'active', kit.clock.now());
    await expect(
      mintAssetGrant(
        kit.ctx,
        actor,
        evaluated,
        evaluated.connectionGeneration,
        evaluated.activeTemplateVersion,
        undefined,
        false,
        'commit',
      ),
    ).rejects.toMatchObject({ code: 'ASSET_NOT_FOUND' });
    expect(
      (await fixture.image(await photoAssetGrantFor(kit, fixture.device, fixture.pass.id))).status,
    ).toBe(200);
  });

  it('binds connection generation even when the connection is restored', async () => {
    const device = await kit.scanner({ templateIds: [template] });
    const pass = await kit.scanPass(template);
    const id = kit.fx.ids.id();
    await run(
      kit.env.DB,
      `INSERT INTO connections
      (id, org_id, connector_type, name, created_at, updated_at) VALUES (?, ?, 'demo', 'Asset source', ?, ?)`,
      [id, kit.org.id, kit.clock.now(), kit.clock.now()],
    );
    await run(kit.env.DB, 'UPDATE passes SET connection_id = ?, external_ref = ? WHERE id = ?', [
      id,
      'ref',
      pass.id,
    ]);
    await putMemberPhoto(
      jobCtxOf(kit),
      system,
      pass.id,
      { png: encoded, includeInPass: true },
      null,
    );
    const grant = await photoAssetGrantFor(kit, device, pass.id);
    await run(
      kit.env.DB,
      'UPDATE connections SET enabled = 0, generation = generation + 1 WHERE id = ?',
      [id],
    );
    await run(
      kit.env.DB,
      'UPDATE connections SET enabled = 1, generation = generation + 1 WHERE id = ?',
      [id],
    );
    await missing(await kit.get(device.headers, `/passes/${pass.id}/assets/member.png?g=${grant}`));
    const next = await photoAssetGrantFor(kit, device, pass.id);
    expect(
      (await kit.get(device.headers, `/passes/${pass.id}/assets/member.png?g=${next}`)).status,
    ).toBe(200);
  });
});
