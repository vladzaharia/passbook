// A pass used under its own release while the head is on another build keeps its member photo
// under the head's photo policy, read as the device card reads that state.
import { beforeAll, describe, expect, it } from 'vitest';
import { persistTemplate } from '../../../../test/helpers/index.ts';
import type { TemplateManifest } from '../../../passkit/types.ts';
import { run } from '../../platform/db.ts';
import { approveAppleRelease } from '../passes/apple-release-test-fixtures.ts';
import { ensureCredentialRefKeyset } from '../passes/credential-keyset.ts';
import { putMemberPhoto } from '../passes/member-photo.ts';
import { ICON_PNG } from '../passes/pass-test-fixtures.ts';
import { makePng } from '../templates/package/fixtures.ts';
import { assetActorFor } from './asset-test-fixtures.ts';
import { confirmAssetGrantToken, mintAssetGrant } from './assets.ts';
import { canShowPhotoForCandidate, knownPhotoUrl } from './member-photo.ts';
import { scanPhotoUrl } from './member-photo-url.ts';
import { prepareAssetGrantInsertion } from './repo-asset-grants.ts';
import { candidateById } from './repo-lookup.ts';
import { type ScanKit, setupScanKit } from './test-kit.ts';

let kit: ScanKit;
const png = btoa(String.fromCharCode(...makePng(270, 270)));
beforeAll(async () => {
  kit = await setupScanKit();
  await ensureCredentialRefKeyset(kit.env.DB, kit.env);
});

async function setup(name: string) {
  const templateId = await kit.scanTemplate(name, {
    actions: [{ id: 'check_in', label: 'Check in', kind: 'check_in' }],
  });
  const device = await kit.scanner({
    templateIds: [templateId],
    settings: { roleWithoutSignIn: 'desk' },
  });
  const pass = await kit.scanPass(templateId);
  await putMemberPhoto(
    kit.ctx,
    { type: 'system', id: null },
    pass.id,
    { png, includeInPass: false },
    null,
  );
  return { templateId, device, pass, actor: await assetActorFor(kit, device) };
}

/** Approve a second version with a different build as the head; `edit` changes its policy. */
async function moveHead(templateId: string, edit?: (m: TemplateManifest) => void) {
  const pinned = await kit.registry.resolve(templateId);
  const manifest = structuredClone(pinned.manifest);
  edit?.(manifest);
  const next = kit.registry.add({
    id: templateId,
    orgId: pinned.orgId,
    version: 'v2',
    manifest,
    passJson: pinned.passJson,
    assets: { 'icon.png': ICON_PNG },
  });
  await persistTemplate(kit.fx, next, { registry: kit.registry, buildKey: 'incompatible-v2' });
  await approveAppleRelease(kit, { templateId, version: 'v2', mode: 'live' });
}

async function current(passId: string) {
  const candidate = await candidateById(kit.env.DB, kit.org.id, passId);
  if (!candidate) throw new Error('Photo candidate missing.');
  return candidate;
}

/** The card's path: policy, read-purpose plan, guarded insert, then the served image. */
async function cardPhoto(fixture: Awaited<ReturnType<typeof setup>>) {
  const candidate = await current(fixture.pass.id);
  const pinned = await kit.registry.resolve(fixture.templateId, candidate.pass.templateVersion);
  const photo = await knownPhotoUrl(kit.ctx, fixture.actor, candidate, pinned);
  if (!photo) return null;
  const bind = await prepareAssetGrantInsertion(kit.ctx, photo.grant, undefined, candidate);
  const inserted = await kit.env.DB.batch(bind(kit.clock.now(), undefined));
  const token = confirmAssetGrantToken(photo.grant, inserted);
  return { purpose: photo.grant.guard.purpose, token };
}

const image = (fixture: Awaited<ReturnType<typeof setup>>, grant: string) =>
  kit
    .get(fixture.device.headers, `/passes/${fixture.pass.id}/assets/member.png?g=${grant}`)
    .then((response) => response.status);

describe('member photos under the issued-release rule', () => {
  it('serves the photo of a pass on its own release under an incompatible head', async () => {
    const fixture = await setup('Own release photo');
    expect((await cardPhoto(fixture))?.purpose).toBe('commit');
    await moveHead(fixture.templateId);
    const candidate = await current(fixture.pass.id);
    expect(candidate).toMatchObject({ activeReleaseVersion: 'v2', displayTemplateVersion: null });
    expect(await canShowPhotoForCandidate(kit.ctx, fixture.actor, candidate)).toBe(true);
    const photo = await cardPhoto(fixture);
    expect(photo?.purpose).toBe('read');
    if (!photo?.token) throw new Error('Photo grant not confirmed.');
    expect(await image(fixture, photo.token)).toBe(200);
    const url = await scanPhotoUrl(kit.ctx, fixture.actor, fixture.pass.id);
    expect(url).toEqual(expect.any(String));
    expect((await kit.get(fixture.device.headers, url!.replace('/api/v1/scan', ''))).status).toBe(
      200,
    );
    // A commit capability is not issued for this state: the purpose follows the release state.
    const generation = candidate.connectionGeneration;
    const version = candidate.activeTemplateVersion;
    await expect(
      mintAssetGrant(kit.ctx, fixture.actor, candidate, generation, version, undefined, true),
    ).rejects.toMatchObject({ code: 'ASSET_NOT_FOUND' });
  });

  it('withholds the photo when the head raises its role above the reader', async () => {
    const fixture = await setup('Head photo policy');
    await moveHead(fixture.templateId, (manifest) => {
      if (!manifest.scan) throw new Error('Missing scan manifest.');
      manifest.scan.display = { v: 1, header: {}, photo: { minRole: 'manager' } };
    });
    const candidate = await current(fixture.pass.id);
    expect(candidate.displayTemplateVersion).toBeNull();
    expect(await canShowPhotoForCandidate(kit.ctx, fixture.actor, candidate)).toBe(false);
    expect(await cardPhoto(fixture)).toBeNull();
    expect(await scanPhotoUrl(kit.ctx, fixture.actor, fixture.pass.id)).toBeNull();
  });

  it('stops serving the photo once the template is deleted', async () => {
    const fixture = await setup('Deleted photo');
    await moveHead(fixture.templateId);
    const photo = await cardPhoto(fixture);
    if (!photo?.token) throw new Error('Photo grant not confirmed.');
    expect(await image(fixture, photo.token)).toBe(200);
    await run(kit.env.DB, "UPDATE templates SET status = 'deleted' WHERE id = ?", [
      fixture.templateId,
    ]);
    expect(await image(fixture, photo.token)).toBe(404);
    expect(await candidateById(kit.env.DB, kit.org.id, fixture.pass.id)).toBeNull();
    expect(await scanPhotoUrl(kit.ctx, fixture.actor, fixture.pass.id)).toBeNull();
  });
});
