import { beforeAll, describe, expect, it } from 'vitest';
import { makeOrg, type ScannerFixture } from '../../../../test/helpers/index.ts';
import { crc32 } from '../../../passkit/index.ts';
import { run } from '../../platform/db.ts';
import { jobCtxOf } from '../delivery/delivery-test-fixtures.ts';
import { putPassAsset } from '../passes/asset-service.ts';
import { putMemberPhoto, updateMemberPhoto } from '../passes/member-photo.ts';
import { ICON_PNG } from '../passes/pass-test-fixtures.ts';
import { makePng } from '../templates/package/fixtures.ts';
import { genericAssetGrantFor, photoAssetGrantFor } from './asset-test-fixtures.ts';
import { type ScanKit, setupScanKit } from './test-kit.ts';

let kit: ScanKit;
let template: string;
let restrictedTemplate: string;

const system = { type: 'system' as const, id: null };
const photo = makePng(270, 270);
const encodedPhoto = btoa(String.fromCharCode(...photo));
const photoNames = ['member.png', 'thumbnail@3x.png'] as const;
const allNames = ['icon.png', ...photoNames] as const;

// Distinct, valid PNGs make it observable whether the template, override, or photo was served.
function markedThumbnail(marker: string): Uint8Array {
  const data = new TextEncoder().encode(`tEXtComment\0${marker}`);
  const chunk = new Uint8Array(data.length + 8);
  const view = new DataView(chunk.buffer);
  view.setUint32(0, data.length - 4);
  chunk.set(data, 4);
  view.setUint32(chunk.length - 4, crc32(data));
  return new Uint8Array([...photo.subarray(0, -12), ...chunk, ...photo.subarray(-12)]);
}
const templateThumbnail = markedThumbnail('template');
const overrideThumbnail = markedThumbnail('pass override');

beforeAll(async () => {
  kit = await setupScanKit();
  template = await kit.scanTemplate(
    'Asset privacy',
    {
      actions: [{ id: 'check_in', label: 'Check in', kind: 'check_in' }],
    },
    { assets: { 'thumbnail@3x.png': templateThumbnail } },
  );
  restrictedTemplate = await kit.scanTemplate('Desk photo only', {
    actions: [{ id: 'check_in', label: 'Check in', kind: 'check_in' }],
    display: { v: 1, photo: { minRole: 'desk' }, header: {} },
  });
});

const path = (passId: string, name: string, grant?: string) =>
  `/passes/${passId}/assets/${name}${grant === undefined ? '' : `?g=${grant}`}`;
const genericGrantFor = (scanner: ScannerFixture, passId: string, now = kit.clock.now()) =>
  genericAssetGrantFor(kit, scanner, passId, now);
const photoGrantFor = (scanner: ScannerFixture, passId: string, now = kit.clock.now()) =>
  photoAssetGrantFor(kit, scanner, passId, now);
async function asset(scanner: ScannerFixture, passId: string, name: string, grant: string) {
  return kit.get(scanner.headers, path(passId, name, grant));
}
async function withPhoto(passId: string, includeInPass: boolean) {
  await putMemberPhoto(jobCtxOf(kit), system, passId, { png: encodedPhoto, includeInPass }, null);
}
async function expectImage(response: Response, bytes: Uint8Array, privatePhoto = false) {
  expect(response.status).toBe(200);
  expect(response.headers.get('content-type')).toBe('image/png');
  expect(response.headers.get('etag')).toBeNull();
  if (privatePhoto) expect(response.headers.get('cache-control')).toBe('private, no-store');
  expect(new Uint8Array(await response.arrayBuffer())).toEqual(bytes);
}
async function expectMissing(response: Response) {
  expect(response.status).toBe(404);
  expect(await response.json()).toMatchObject({ code: 'ASSET_NOT_FOUND' });
}
async function expectPhotos(scanner: ScannerFixture, passId: string) {
  const grant = await photoGrantFor(scanner, passId);
  for (const name of photoNames)
    await expectImage(await asset(scanner, passId, name, grant), photo, true);
}
async function expectNoPhotos(scanner: ScannerFixture, passId: string, grant?: string) {
  const photoGrant = grant ?? (await photoGrantFor(scanner, passId));
  for (const name of photoNames)
    await expectMissing(await asset(scanner, passId, name, photoGrant));
}

describe('scanner pass asset privacy', () => {
  it('serves an included member photo at both URLs without public or persistent caching', async () => {
    const scanner = await kit.scanner({ templateIds: [template] });
    const pass = await kit.scanPass(template);
    await withPhoto(pass.id, true);

    await expectPhotos(scanner, pass.id);
    await expectImage(
      await asset(scanner, pass.id, 'icon.png', await genericGrantFor(scanner, pass.id)),
      ICON_PNG,
    );
  });

  it('serves a non-included photo only at member.png and keeps the template thumbnail', async () => {
    const scanner = await kit.scanner({ templateIds: [template] });
    const pass = await kit.scanPass(template);
    await withPhoto(pass.id, false);

    await expectImage(
      await asset(scanner, pass.id, 'member.png', await photoGrantFor(scanner, pass.id)),
      photo,
      true,
    );
    await expectImage(
      await asset(scanner, pass.id, 'thumbnail@3x.png', await genericGrantFor(scanner, pass.id)),
      templateThumbnail,
    );
    await expectMissing(
      await asset(scanner, pass.id, 'thumbnail@3x.png', await photoGrantFor(scanner, pass.id)),
    );
  });

  it('blocks both photo URLs when photos are disabled, but preserves ordinary thumbnails', async () => {
    const scanner = await kit.scanner({
      templateIds: [template],
      settings: { showPhoto: false },
    });
    const included = await kit.scanPass(template);
    await withPhoto(included.id, true);
    await expectNoPhotos(scanner, included.id);
    await expectImage(
      await asset(scanner, included.id, 'icon.png', await genericGrantFor(scanner, included.id)),
      ICON_PNG,
    );

    const withoutPhoto = await kit.scanPass(template);
    const withoutPhotoGrant = await genericGrantFor(scanner, withoutPhoto.id);
    await expect(photoGrantFor(scanner, withoutPhoto.id)).rejects.toMatchObject({
      code: 'ASSET_NOT_FOUND',
    });
    await expectMissing(await asset(scanner, withoutPhoto.id, 'member.png', withoutPhotoGrant));
    await expectImage(
      await asset(scanner, withoutPhoto.id, 'thumbnail@3x.png', withoutPhotoGrant),
      templateThumbnail,
    );

    const notIncluded = await kit.scanPass(template);
    await putPassAsset(
      jobCtxOf(kit),
      system,
      notIncluded.id,
      'thumbnail@3x.png',
      overrideThumbnail,
      null,
      {},
    );
    await withPhoto(notIncluded.id, false);
    const grant = await genericGrantFor(scanner, notIncluded.id);
    const photoGrant = await photoGrantFor(scanner, notIncluded.id);
    await expectMissing(await asset(scanner, notIncluded.id, 'member.png', grant));
    await expectMissing(await asset(scanner, notIncluded.id, 'member.png', photoGrant));
    await expectImage(
      await asset(scanner, notIncluded.id, 'thumbnail@3x.png', grant),
      overrideThumbnail,
    );
    await updateMemberPhoto(kit.ctx, system, notIncluded.id, true, null);
    for (const name of photoNames) {
      await expectMissing(await asset(scanner, notIncluded.id, name, grant));
      await expectMissing(await asset(scanner, notIncluded.id, name, photoGrant));
    }
    await updateMemberPhoto(kit.ctx, system, notIncluded.id, false, null);
    await expectMissing(await asset(scanner, notIncluded.id, 'member.png', grant));
    await expectMissing(await asset(scanner, notIncluded.id, 'member.png', photoGrant));
    await expectMissing(await asset(scanner, notIncluded.id, 'thumbnail@3x.png', grant));
    await expectImage(
      await asset(
        scanner,
        notIncluded.id,
        'thumbnail@3x.png',
        await genericGrantFor(scanner, notIncluded.id),
      ),
      overrideThumbnail,
    );
  });

  it('enforces the template minimum role on both photo URLs', async () => {
    const pass = await kit.scanPass(restrictedTemplate);
    await withPhoto(pass.id, true);
    const door = await kit.scanner({ templateIds: [restrictedTemplate] });
    const desk = await kit.scanner({
      templateIds: [restrictedTemplate],
      settings: { roleWithoutSignIn: 'desk' },
    });

    await expectPhotos(desk, pass.id);
    await expectNoPhotos(door, pass.id);
    await expectImage(
      await asset(door, pass.id, 'icon.png', await genericGrantFor(door, pass.id)),
      ICON_PNG,
    );
  });

  it('denies photo URLs for a template outside the scanner scope', async () => {
    const scanner = await kit.scanner({
      templateIds: [template, restrictedTemplate],
      settings: { roleWithoutSignIn: 'desk' },
    });
    const accepted = await kit.scanPass(template);
    const excluded = await kit.scanPass(restrictedTemplate);
    await withPhoto(accepted.id, true);
    await withPhoto(excluded.id, true);
    const oldGrant = await photoGrantFor(scanner, excluded.id);
    await run(
      kit.env.DB,
      'DELETE FROM scanner_templates WHERE scanner_id = ? AND template_id = ?',
      [scanner.id, restrictedTemplate],
    );
    await run(kit.env.DB, 'UPDATE scanners SET updated_at = updated_at + 1 WHERE id = ?', [
      scanner.id,
    ]);

    await expectPhotos(scanner, accepted.id);
    await expectNoPhotos(scanner, excluded.id, oldGrant);
  });

  it('uses the selected event template scope rather than the scanner template list', async () => {
    const event = await kit.event({ templateIds: [template, restrictedTemplate] });
    const scanner = await kit.scanner({
      eventId: event.id,
      templateIds: [restrictedTemplate],
      settings: { roleWithoutSignIn: 'desk' },
    });
    const accepted = await kit.scanPass(template);
    const excluded = await kit.scanPass(restrictedTemplate);
    await withPhoto(accepted.id, true);
    await withPhoto(excluded.id, true);
    const oldGrant = await photoGrantFor(scanner, excluded.id);
    await run(
      kit.env.DB,
      'DELETE FROM scan_event_templates WHERE event_id = ? AND template_id = ?',
      [event.id, restrictedTemplate],
    );
    await run(kit.env.DB, 'UPDATE scan_events SET updated_at = updated_at + 1 WHERE id = ?', [
      event.id,
    ]);

    await expectPhotos(scanner, accepted.id);
    await expectNoPhotos(scanner, excluded.id, oldGrant);
  });

  it('denies both photo URLs when the event filter does not match the pass', async () => {
    const event = await kit.event({ templateIds: [template] });
    const scanner = await kit.scanner({ eventId: event.id });
    const accepted = await kit.scanPass(template, { tier: 'gold' });
    const excluded = await kit.scanPass(template, { tier: 'silver' });
    await withPhoto(accepted.id, true);
    await withPhoto(excluded.id, true);
    const oldGrant = await photoGrantFor(scanner, excluded.id);
    const oldGenericGrant = await genericGrantFor(scanner, excluded.id);
    await run(
      kit.env.DB,
      `UPDATE scan_events SET match_input = ?, match_values = ?,
      updated_at = updated_at + 1 WHERE id = ?`,
      ['tier', '["gold"]', event.id],
    );

    await expectPhotos(scanner, accepted.id);
    await expect(photoGrantFor(scanner, excluded.id)).rejects.toMatchObject({
      code: 'ASSET_NOT_FOUND',
    });
    await expect(genericGrantFor(scanner, excluded.id)).rejects.toMatchObject({
      code: 'ASSET_NOT_FOUND',
    });
    await expectNoPhotos(scanner, excluded.id, oldGrant);
    await expectMissing(await asset(scanner, excluded.id, 'icon.png', oldGenericGrant));
  });

  it('requires an unexpired grant bound to this scanner and pass as well as authentication', async () => {
    const first = await kit.scanner({ templateIds: [template] });
    const second = await kit.scanner({ templateIds: [template] });
    const pass = await kit.scanPass(template);
    const otherPass = await kit.scanPass(template);
    await withPhoto(pass.id, true);
    await withPhoto(otherPass.id, true);
    const genericGrant = await genericGrantFor(first, pass.id);
    const photoGrant = await photoGrantFor(first, pass.id);
    for (const name of photoNames)
      await expectMissing(await asset(first, pass.id, name, genericGrant));
    await expectMissing(await asset(first, pass.id, 'icon.png', photoGrant));

    for (const name of allNames) {
      const grant = name === 'icon.png' ? genericGrant : photoGrant;
      const grantFor = name === 'icon.png' ? genericGrantFor : photoGrantFor;
      await expectImage(
        await asset(first, pass.id, name, grant),
        name === 'icon.png' ? ICON_PNG : photo,
        name !== 'icon.png',
      );
      await expectMissing(await kit.get(first.headers, path(pass.id, name)));
      await expectMissing(await asset(first, pass.id, name, 'invalid'));
      await expectMissing(await asset(second, pass.id, name, grant));
      await expectMissing(await asset(first, otherPass.id, name, grant));
      await expectMissing(
        await asset(
          first,
          pass.id,
          name,
          await grantFor(first, pass.id, kit.clock.now() - 3_600_000),
        ),
      );
      expect((await kit.get({}, path(pass.id, name, grant))).status).toBe(401);
    }
  });

  it('isolates assets across organizations and live/test modes even with valid grants', async () => {
    const foreignOrg = await makeOrg(kit.fx);
    const foreignTemplate = await kit.scanTemplate(
      'Foreign assets',
      { actions: [{ id: 'check_in', label: 'Check in', kind: 'check_in' }] },
      { orgId: foreignOrg.id },
    );
    const live = await kit.scanner({ templateIds: [template] });
    const test = await kit.scanner({ templateIds: [template], mode: 'test' });
    const foreign = await kit.scanner({ orgId: foreignOrg.id, templateIds: [foreignTemplate] });
    const livePass = await kit.scanPass(template);
    const testPass = await kit.scanPass(template, {}, { mode: 'test' });
    const foreignPass = await kit.scanPass(foreignTemplate, {}, { orgId: foreignOrg.id });
    for (const pass of [livePass, testPass, foreignPass]) await withPhoto(pass.id, true);

    await expectPhotos(live, livePass.id);
    await expectPhotos(test, testPass.id);
    await expectPhotos(foreign, foreignPass.id);
    for (const name of allNames) {
      const grantFor = name === 'icon.png' ? genericGrantFor : photoGrantFor;
      await expectMissing(await asset(live, testPass.id, name, await grantFor(test, testPass.id)));
      await expectMissing(await asset(test, livePass.id, name, await grantFor(live, livePass.id)));
      await expectMissing(
        await asset(foreign, livePass.id, name, await grantFor(live, livePass.id)),
      );
      await expectMissing(
        await asset(live, foreignPass.id, name, await grantFor(foreign, foreignPass.id)),
      );
    }
  });
});
