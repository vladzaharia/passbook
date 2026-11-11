import { beforeAll, describe, expect, it, vi } from 'vitest';
import { makePass } from '../../../../test/helpers/index.ts';
import { run } from '../../platform/db.ts';
import { jobCtxOf } from '../delivery/delivery-test-fixtures.ts';
import { setOrgStatus } from '../orgs/repo.ts';
import { approveAppleRelease } from '../passes/apple-release-test-fixtures.ts';
import { putPassAsset } from '../passes/asset-service.ts';
import { putMemberPhoto } from '../passes/member-photo.ts';
import { memberPhoto } from '../passes/repo-member-photo.ts';
import { getPassAsset } from '../public/repo.ts';
import { makePng } from '../templates/package/fixtures.ts';
import { setTemplateStatus } from '../templates/testing.ts';
import {
  genericAssetGrantFor,
  observeCancellation,
  photoAssetGrantFor,
} from './asset-test-fixtures.ts';
import { candidateById } from './repo-lookup.ts';
import { updateScannerStmt } from './repo-scanners-test-support.ts';
import { type ScanKit, setupScanKit } from './test-kit.ts';

let kit: ScanKit;
let template: string;
const system = { type: 'system' as const, id: null };
const png = makePng(270, 270);
const encoded = btoa(String.fromCharCode(...png));

beforeAll(async () => {
  kit = await setupScanKit();
  template = await kit.scanTemplate('Asset stream races', {
    actions: [{ id: 'check_in', label: 'Check in', kind: 'check_in' }],
  });
});

async function photoPass() {
  const device = await kit.scanner({ templateIds: [template] });
  const pass = await kit.scanPass(template);
  await putMemberPhoto(jobCtxOf(kit), system, pass.id, { png: encoded, includeInPass: true }, null);
  const grant = await photoAssetGrantFor(kit, device, pass.id);
  const image = () => kit.get(device.headers, `/passes/${pass.id}/assets/member.png?g=${grant}`);
  return { device, pass, image };
}

async function missing(response: Response) {
  expect(response.status).toBe(404);
  expect(await response.json()).toMatchObject({ code: 'ASSET_NOT_FOUND' });
}

describe('scanner asset stream races', () => {
  it.each([
    [
      'voided Wallet JSON',
      "UPDATE pass_versions SET pass_json = json_set(pass_json, '$.voided', json('true')) WHERE pass_id = ?",
    ],
    ['invalid Wallet JSON', "UPDATE pass_versions SET pass_json = '{' WHERE pass_id = ?"],
    ['non-object Wallet JSON', "UPDATE pass_versions SET pass_json = '[]' WHERE pass_id = ?"],
    ['missing Wallet JSON', 'UPDATE pass_versions SET pass_json = NULL WHERE pass_id = ?'],
    [
      'wrong Wallet serial',
      "UPDATE pass_versions SET pass_json = json_set(pass_json, '$.serialNumber', 'foreign') WHERE pass_id = ?",
    ],
    [
      'wrong Wallet pass type',
      "UPDATE pass_versions SET pass_json = json_set(pass_json, '$.passTypeIdentifier', 'pass.foreign') WHERE pass_id = ?",
    ],
    [
      'wrong Wallet team',
      "UPDATE pass_versions SET pass_json = json_set(pass_json, '$.teamIdentifier', 'FOREIGN') WHERE pass_id = ?",
    ],
    [
      'Wallet version personalization',
      "UPDATE pass_versions SET personalization = json_set(personalization, '$.tier', 'different') WHERE pass_id = ?",
    ],
    [
      'Wallet template version',
      "UPDATE pass_versions SET template_version = 'another-version' WHERE pass_id = ?",
    ],
    [
      'expired Wallet JSON',
      "UPDATE pass_versions SET pass_json = json_set(pass_json, '$.expirationDate', '2000-01-01T00:00:00Z') WHERE pass_id = ?",
    ],
    [
      'invalid Wallet expiry',
      "UPDATE pass_versions SET pass_json = json_set(pass_json, '$.expirationDate', 'bad') WHERE pass_id = ?",
    ],
    ['malformed pass data', "UPDATE passes SET personalization = '[]' WHERE id = ?"],
    ['malformed field sources', "UPDATE passes SET field_sources = '[]' WHERE id = ?"],
    ['pass removed', 'UPDATE passes SET removed_at = 1 WHERE id = ?'],
    ['pass deleted', 'UPDATE passes SET deleted_at = 1 WHERE id = ?'],
    ['pass quarantined', 'UPDATE passes SET test_data_quarantined = 1 WHERE id = ?'],
    ['pass issuance release', 'UPDATE passes SET release_id = NULL WHERE id = ?'],
    ['pass generation', 'UPDATE passes SET link_generation = link_generation + 1 WHERE id = ?'],
  ] as const)('cancels the open photo if %s changes during the R2 read', async (_name, sql) => {
    const fixture = await photoPass();
    if (_name === 'pass issuance release')
      expect(
        (await candidateById(kit.env.DB, kit.org.id, fixture.pass.id))?.pass.releaseId,
      ).toBeTruthy();
    const photo = await memberPhoto(kit.env.DB, kit.org.id, fixture.pass.id);
    if (!photo) throw new Error('Photo fixture missing');
    const originalGet = kit.env.BUCKET.get.bind(kit.env.BUCKET);
    let opened = false;
    let cancelled = 0;
    const spy = vi.spyOn(kit.env.BUCKET, 'get').mockImplementation(async (key, options) => {
      const object = await originalGet(key, options);
      if (key !== photo.r2_key || !object) return object;
      opened = true;
      await run(kit.env.DB, sql, [fixture.pass.id]);
      return observeCancellation(object, () => cancelled++);
    });
    let response: Response;
    try {
      response = await fixture.image();
    } finally {
      spy.mockRestore();
    }
    expect(opened).toBe(true);
    expect(cancelled).toBe(1);
    await missing(response);
  });

  it('cancels the opened photo after a direct photo A→B→A image-generation change', async () => {
    const fixture = await photoPass();
    const original = await candidateById(kit.env.DB, kit.org.id, fixture.pass.id);
    const photo = await memberPhoto(kit.env.DB, kit.org.id, fixture.pass.id);
    if (!original || !photo) throw new Error('Photo fixture missing');
    const originalGet = kit.env.BUCKET.get.bind(kit.env.BUCKET);
    let opened = false;
    let cancelled = 0;
    const spy = vi.spyOn(kit.env.BUCKET, 'get').mockImplementation(async (key, options) => {
      const object = await originalGet(key, options);
      if (key !== photo.r2_key || !object) return object;
      opened = true;
      await run(kit.env.DB, 'UPDATE member_photos SET include_in_pass=0 WHERE pass_id=?', [
        fixture.pass.id,
      ]);
      await run(kit.env.DB, 'UPDATE member_photos SET include_in_pass=1 WHERE pass_id=?', [
        fixture.pass.id,
      ]);
      return observeCancellation(object, () => cancelled++);
    });
    let response: Response;
    try {
      response = await fixture.image();
    } finally {
      spy.mockRestore();
    }
    const current = await candidateById(kit.env.DB, kit.org.id, fixture.pass.id);
    expect(current?.assetPhoto).toEqual(original.assetPhoto);
    expect(current?.pass.imageGeneration).toBeGreaterThan(original.pass.imageGeneration);
    expect(opened).toBe(true);
    expect(cancelled).toBe(1);
    await missing(response);
  });

  it.each(['member.png', 'thumbnail@3x.png'] as const)(
    'cancels %s if scanner photo authority changes while opening it',
    async (name) => {
      const fixture = await photoPass();
      const photo = await memberPhoto(kit.env.DB, kit.org.id, fixture.pass.id);
      const scanner = await kit.env.DB.prepare('SELECT settings FROM scanners WHERE id = ?')
        .bind(fixture.device.id)
        .first<{ settings: string }>();
      if (!photo || !scanner) throw new Error('Photo or scanner fixture missing');
      const grant = await photoAssetGrantFor(kit, fixture.device, fixture.pass.id);
      const originalGet = kit.env.BUCKET.get.bind(kit.env.BUCKET);
      let opened = false;
      let cancelled = 0;
      const spy = vi.spyOn(kit.env.BUCKET, 'get').mockImplementation(async (key, options) => {
        const object = await originalGet(key, options);
        if (key !== photo.r2_key || !object) return object;
        opened = true;
        await updateScannerStmt(
          kit.env.DB,
          fixture.device.id,
          {
            settings: JSON.stringify({ ...JSON.parse(scanner.settings), showPhoto: false }),
          },
          kit.clock.now(),
        ).run();
        return observeCancellation(object, () => cancelled++);
      });
      let response: Response;
      try {
        response = await kit.get(
          fixture.device.headers,
          `/passes/${fixture.pass.id}/assets/${name}?g=${grant}`,
        );
      } finally {
        spy.mockRestore();
      }
      expect(opened).toBe(true);
      expect(cancelled).toBe(1);
      await missing(response);
    },
  );

  it.each(['scanner', 'organization', 'template'] as const)(
    'cancels the opened stream when %s authority changes and is restored during R2 access',
    async (change) => {
      const fixture = await photoPass();
      const photo = await memberPhoto(kit.env.DB, kit.org.id, fixture.pass.id);
      const scanner = await kit.env.DB.prepare('SELECT settings FROM scanners WHERE id = ?')
        .bind(fixture.device.id)
        .first<{ settings: string }>();
      if (!photo || !scanner) throw new Error('Photo or scanner fixture missing');
      const originalGet = kit.env.BUCKET.get.bind(kit.env.BUCKET);
      let opened = false;
      let cancelled = 0;
      const spy = vi.spyOn(kit.env.BUCKET, 'get').mockImplementation(async (key, options) => {
        const object = await originalGet(key, options);
        if (key !== photo.r2_key || !object) return object;
        opened = true;
        if (change === 'scanner') {
          const altered = JSON.stringify({ ...JSON.parse(scanner.settings), showPhoto: false });
          await updateScannerStmt(
            kit.env.DB,
            fixture.device.id,
            { settings: altered },
            kit.clock.now(),
          ).run();
          await updateScannerStmt(
            kit.env.DB,
            fixture.device.id,
            { settings: scanner.settings },
            kit.clock.now(),
          ).run();
        } else if (change === 'organization') {
          await setOrgStatus(kit.env.DB, kit.org.id, 'suspended', kit.clock.now());
          await setOrgStatus(kit.env.DB, kit.org.id, 'active', kit.clock.now());
        } else {
          await setTemplateStatus(kit.env.DB, template, 'archived', kit.clock.now());
          await setTemplateStatus(kit.env.DB, template, 'active', kit.clock.now());
        }
        return observeCancellation(object, () => cancelled++);
      });
      let response: Response;
      try {
        response = await fixture.image();
      } finally {
        spy.mockRestore();
      }
      expect(opened).toBe(true);
      if (change === 'template') {
        // Authority is the template's status and org, not its history: A-B-A is the same template.
        expect(cancelled).toBe(0);
        expect(response.status).toBe(200);
        await response.body?.cancel();
        return;
      }
      expect(cancelled).toBe(1);
      await missing(response);
    },
  );

  it.each(['thumbnail@3x.png', 'icon.png'] as const)(
    'cancels %s when Wallet JSON becomes void during its R2 read',
    async (name) => {
      const fixture = await photoPass();
      if (name === 'icon.png')
        await putPassAsset(jobCtxOf(kit), system, fixture.pass.id, name, makePng(38, 38), null, {});
      const photo = await memberPhoto(kit.env.DB, kit.org.id, fixture.pass.id);
      const override = await getPassAsset(kit.env.DB, fixture.pass.id, name);
      const key = name === 'icon.png' ? override?.r2Key : photo?.r2_key;
      if (!key) throw new Error('Image fixture missing');
      const grant = await (name === 'icon.png' ? genericAssetGrantFor : photoAssetGrantFor)(
        kit,
        fixture.device,
        fixture.pass.id,
      );
      const originalGet = kit.env.BUCKET.get.bind(kit.env.BUCKET);
      let opened = false;
      let cancelled = 0;
      const spy = vi.spyOn(kit.env.BUCKET, 'get').mockImplementation(async (objectKey, options) => {
        const object = await originalGet(objectKey, options);
        if (objectKey !== key || !object) return object;
        opened = true;
        await run(
          kit.env.DB,
          "UPDATE pass_versions SET pass_json = json_set(pass_json, '$.voided', json('true')) WHERE pass_id = ?",
          [fixture.pass.id],
        );
        return observeCancellation(object, () => cancelled++);
      });
      let response: Response;
      try {
        response = await kit.get(
          fixture.device.headers,
          `/passes/${fixture.pass.id}/assets/${name}?g=${grant}`,
        );
      } finally {
        spy.mockRestore();
      }
      expect(opened).toBe(true);
      expect(cancelled).toBe(1);
      await missing(response);
    },
  );

  it('serves a photo when a release is approved during R2 access (content, not authority)', async () => {
    const fixture = await photoPass();
    const photo = await memberPhoto(kit.env.DB, kit.org.id, fixture.pass.id);
    const candidate = await candidateById(kit.env.DB, kit.org.id, fixture.pass.id);
    if (!photo || !candidate?.activeReleaseVersion) throw new Error('Release fixture missing');
    const originalGet = kit.env.BUCKET.get.bind(kit.env.BUCKET);
    let opened = false;
    let cancelled = 0;
    const spy = vi.spyOn(kit.env.BUCKET, 'get').mockImplementation(async (key, options) => {
      const object = await originalGet(key, options);
      if (key !== photo.r2_key || !object) return object;
      opened = true;
      await approveAppleRelease(kit, {
        orgId: kit.org.id,
        mode: 'live',
        templateId: template,
        version: candidate.activeReleaseVersion!,
      });
      return observeCancellation(object, () => cancelled++);
    });
    let response: Response;
    try {
      response = await fixture.image();
    } finally {
      spy.mockRestore();
    }
    expect(opened).toBe(true);
    expect(cancelled).toBe(0);
    expect(response.status).toBe(200);
    await response.body?.cancel();
  });

  it('cancels a photo after signing identity A→B→A during the R2 read', async () => {
    const device = await kit.scanner({ templateIds: [template] });
    const identityId = kit.fx.ids.id();
    const passType = `pass.test.${identityId}`;
    const team = 'ORIGINALTEAM';
    await run(
      kit.env.DB,
      `INSERT INTO signing_identities
      (id,org_id,label,pass_type_identifier,team_identifier,source,env_prefix,created_at)
      VALUES (?,?,'Asset fixture',?,?,'env','TEST',?)`,
      [identityId, kit.org.id, passType, team, kit.clock.now()],
    );
    const resolved = await kit.registry.resolve(template);
    const pass = await makePass(kit.fx, { orgId: kit.org.id, template: resolved, identityId });
    await run(kit.env.DB, 'UPDATE pass_versions SET pass_json = ? WHERE pass_id = ?', [
      JSON.stringify({
        ...resolved.passJson,
        serialNumber: pass.serial,
        passTypeIdentifier: passType,
        teamIdentifier: team,
      }),
      pass.id,
    ]);
    await putMemberPhoto(kit.ctx, system, pass.id, { png: encoded, includeInPass: false }, null);
    const fixture = { device, pass };
    const grant = await photoAssetGrantFor(kit, device, pass.id);
    const original = await candidateById(kit.env.DB, kit.org.id, fixture.pass.id);
    const photo = await memberPhoto(kit.env.DB, kit.org.id, fixture.pass.id);
    if (!photo || !original?.identityRevision) throw new Error('Identity fixture missing');
    const originalGet = kit.env.BUCKET.get.bind(kit.env.BUCKET);
    let opened = false;
    let cancelled = 0;
    const spy = vi.spyOn(kit.env.BUCKET, 'get').mockImplementation(async (key, options) => {
      const object = await originalGet(key, options);
      if (key !== photo.r2_key || !object) return object;
      opened = true;
      await run(kit.env.DB, 'UPDATE signing_identities SET team_identifier = ? WHERE id = ?', [
        'CHANGED',
        identityId,
      ]);
      await run(kit.env.DB, 'UPDATE signing_identities SET team_identifier = ? WHERE id = ?', [
        team,
        identityId,
      ]);
      return observeCancellation(object, () => cancelled++);
    });
    let response: Response;
    try {
      response = await kit.get(
        fixture.device.headers,
        `/passes/${fixture.pass.id}/assets/member.png?g=${grant}`,
      );
    } finally {
      spy.mockRestore();
    }
    const current = await candidateById(kit.env.DB, kit.org.id, fixture.pass.id);
    expect(current?.identityRevision).toBeGreaterThan(original.identityRevision);
    expect(opened).toBe(true);
    expect(cancelled).toBe(1);
    await missing(response);
  });
});
