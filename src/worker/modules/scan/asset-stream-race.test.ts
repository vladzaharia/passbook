import { beforeAll, describe, expect, it, vi } from 'vitest';
import { setOrgStatus } from '../../../../test/helpers/index.ts';
import { run } from '../../platform/db.ts';
import { jobCtxOf } from '../delivery/delivery-test-fixtures.ts';
import { approveAppleRelease } from '../passes/apple-release-test-fixtures.ts';
import { putMemberPhoto } from '../passes/member-photo.ts';
import { memberPhoto } from '../passes/repo-member-photo.ts';
import { makePng } from '../templates/package/fixtures.ts';
import { setTemplateStatus } from '../templates/testing.ts';
import { observeCancellation, photoAssetGrantFor } from './asset-test-fixtures.ts';
import { issueUnderOlderAdapter } from './release-policy-test-fixtures.ts';
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

async function photoPass(older = false) {
  const device = await kit.scanner({ templateIds: [template] });
  const pass = await kit.scanPass(template);
  if (older) await issueUnderOlderAdapter(kit, pass.id);
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
  // Authority is the pass's liveness and issuance release; content edits are not authority (F8).
  it.each([
    ['pass removed', 'UPDATE passes SET removed_at = 1 WHERE id = ?', true],
    ['pass deleted', 'UPDATE passes SET deleted_at = 1 WHERE id = ?', true],
    ['pass quarantined', 'UPDATE passes SET test_data_quarantined = 1 WHERE id = ?', true],
    ['pass issuance release', 'UPDATE passes SET release_id = NULL WHERE id = ?', false],
    [
      'voided Wallet JSON',
      "UPDATE pass_versions SET pass_json = json_set(pass_json, '$.voided', json('true')) WHERE pass_id = ?",
      false,
    ],
    [
      'wrong Wallet serial',
      "UPDATE pass_versions SET pass_json = json_set(pass_json, '$.serialNumber', 'foreign') WHERE pass_id = ?",
      false,
    ],
    [
      'Wallet version personalization',
      "UPDATE pass_versions SET personalization = json_set(personalization, '$.tier', 'different') WHERE pass_id = ?",
      false,
    ],
    ['malformed pass data', "UPDATE passes SET personalization = '[]' WHERE id = ?", false],
    [
      'pass link generation',
      'UPDATE passes SET link_generation = link_generation + 1 WHERE id = ?',
      false,
    ],
  ] as const)('%s during the R2 read: cancelled=%s', async (_name, sql, cancels) => {
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
    if (cancels) {
      expect(cancelled).toBe(1);
      await missing(response);
    } else {
      expect(cancelled).toBe(0);
      expect(response.status).toBe(200);
      await response.body?.cancel();
    }
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
    'keeps or cancels the opened stream when %s authority changes and is restored during R2 access',
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
      if (change === 'template' || change === 'organization') {
        // Authority is the template's and the org's state, not their history: A-B-A is the same.
        expect(cancelled).toBe(0);
        expect(response.status).toBe(200);
        await response.body?.cancel();
        return;
      }
      expect(cancelled).toBe(1);
      await missing(response);
    },
  );

  it.each([
    ['an identical', false],
    ['an other-adapter', true],
  ] as const)(
    'serves or cancels a photo when %s release of the pass version lands during R2 access',
    async (_name, older) => {
      const fixture = await photoPass(older);
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
      if (older) {
        // The release differs from the pass's own in the adapter: a real change.
        expect(cancelled).toBe(1);
        await missing(response);
      } else {
        // Identical to the pass's own release: nothing a scanner sees or may do changed.
        expect(cancelled).toBe(0);
        expect(response.status).toBe(200);
      }
    },
  );
});
