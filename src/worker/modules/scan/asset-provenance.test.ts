// A grant is a stateless capability: nonce, expiry, a truncated HMAC over the lineage it was minted
// from, and the ref prefixes of the credential it was scanned from. Each denial has a positive control.
import { beforeAll, describe, expect, it } from 'vitest';
import { makeSession, makeUser } from '../../../../test/helpers/index.ts';
import type { ScanManifest } from '../../../passkit/types.ts';
import { first } from '../../platform/db.ts';
import { fromBase64Url, toBase64Url } from '../../platform/ids.ts';
import { createSessionStore } from '../auth/sessions.ts';
import { ensureCredentialRefKeyset } from '../passes/credential-keyset.ts';
import { tenantAuthorityOf } from '../passes/http.ts';
import { putMemberPhoto } from '../passes/member-photo.ts';
import { makePng } from '../templates/package/fixtures.ts';
import { adminActor, captureScanTenantAuthority, tenantScanRole } from './actor.ts';
import { assetGrantValid, grantRefsOf, mintAssetGrant } from './asset-grant-test-fixtures.ts';
import { takePhotoGrantToken } from './asset-sidecar.ts';
import { assetActorFor, genericAssetGrantFor, photoAssetGrantFor } from './asset-test-fixtures.ts';
import { prepareAssetGrantVerification, preparePhotoGrant } from './assets.ts';
import { captureScanEpochs } from './authority-checks.ts';
import { scanCredentialKeys } from './credential-input.ts';
import { candidateById } from './repo-lookup.ts';
import { grantScanMembership, type ScanKit, setupScanKit } from './test-kit.ts';

const system = { type: 'system' as const, id: null };
const encodedPhoto = btoa(String.fromCharCode(...makePng(270, 270)));
const scan: ScanManifest = {
  actions: [{ id: 'check_in', label: 'Check in', kind: 'check_in' }],
  display: { v: 1, header: {}, photo: { minRole: 'door' } },
};
let kit: ScanKit;
let templateId: string;
beforeAll(async () => {
  kit = await setupScanKit();
  await ensureCredentialRefKeyset(kit.env.DB, kit.env);
  templateId = await kit.scanTemplate('Asset capability provenance', scan);
});

async function photoFixture() {
  const device = await kit.scanner({ templateIds: [templateId] });
  const actor = await assetActorFor(kit, device);
  const pass = await kit.scanPass(templateId, { memberName: 'Provenance Person' });
  await putMemberPhoto(kit.ctx, system, pass.id, { png: encodedPhoto, includeInPass: false }, null);
  if (!pass.scanCode) throw new Error('Pass scan code missing');
  const keys = await scanCredentialKeys(kit.env, kit.org.id, 'live', pass.scanCode, false);
  const current = await candidateById(kit.env.DB, kit.org.id, pass.id);
  if (!current?.assetPhoto) throw new Error('Photo fixture missing');
  const candidate = { ...current, credentialTombstoneRefs: keys.credentialTombstoneRefs };
  const url = (grant: string, name = 'member.png', scanner = device) =>
    kit.get(scanner.headers, `/passes/${pass.id}/assets/${name}?g=${grant}`);
  return { device, actor, pass, candidate, keys, url };
}

const mintPhoto = (f: Awaited<ReturnType<typeof photoFixture>>) =>
  mintAssetGrant(
    kit.ctx,
    f.actor,
    f.candidate,
    f.candidate.connectionGeneration,
    f.candidate.activeTemplateVersion,
    true,
    'commit',
  );

async function missing(response: Response) {
  expect(response.status).toBe(404);
  expect(await response.json()).toMatchObject({ code: 'ASSET_NOT_FOUND' });
}

/** The same token with one byte changed. */
function flipped(grant: string, offset: number): string {
  const bytes = fromBase64Url(grant);
  bytes[offset] = (bytes[offset] ?? 0) ^ 1;
  return toBase64Url(bytes);
}

describe('stateless asset capability', () => {
  it('is a plan without secrets, and its URL goes only to the recipient it was minted for', async () => {
    const f = await photoFixture();
    const other = await assetActorFor(kit, await kit.scanner({ templateIds: [templateId] }));
    const plan = await preparePhotoGrant(
      kit.ctx,
      f.actor,
      f.candidate,
      f.candidate.connectionGeneration,
      f.candidate.activeTemplateVersion,
    );
    if (!plan) throw new Error('Expected a photo grant plan');
    expect(Object.isFrozen(plan)).toBe(true);
    const cloned = JSON.stringify(structuredClone(plan));
    expect(cloned).not.toMatch(/token|passJsonSnapshot|personalization/i);
    for (const secret of [f.device.token, f.candidate.pass.authToken, f.candidate.pass.scanCode])
      if (secret) expect(cloned).not.toContain(secret);
    // Positive control, then every other recipient or pass.
    expect(takePhotoGrantToken(f.actor, f.pass.id, plan)).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(takePhotoGrantToken(other, f.pass.id, plan)).toBeNull();
    expect(takePhotoGrantToken(f.actor, 'another-pass', plan)).toBeNull();
  });

  it('writes nothing: no table backs a grant', async () => {
    const f = await photoFixture();
    expect(
      await first(kit.env.DB, "SELECT 1 FROM sqlite_master WHERE name LIKE 'scan_asset_grant%'"),
    ).toBeNull();
    const grant = await mintPhoto(f);
    expect((await f.url(grant)).status).toBe(200);
  });

  it('carries the keyed ref prefixes of the scanned credential, and none for a pass-ID card', async () => {
    const f = await photoFixture();
    expect(f.keys.credentialTombstoneRefs.length).toBeGreaterThan(0);
    const scanned = await mintPhoto(f);
    expect(await grantRefsOf(kit.ctx, scanned)).toEqual(
      f.keys.credentialTombstoneRefs.map((ref) => ref.slice(0, 16)),
    );
    const byId = await photoAssetGrantFor(kit, f.device, f.pass.id);
    expect(await grantRefsOf(kit.ctx, byId)).toEqual([]);
    for (const grant of [scanned, byId]) expect((await f.url(grant)).status).toBe(200);
  });

  it('refuses a tampered tag, expiry, nonce, ref or length, and serves the original', async () => {
    const f = await photoFixture();
    const grant = await mintPhoto(f);
    expect((await f.url(grant)).status).toBe(200);
    // nonce 8, expiry 6, tag 24, then the ref prefixes.
    for (const offset of [0, 7, 8, 13, 14, 37, 38, 45])
      await missing(await f.url(flipped(grant, offset)));
    const bytes = fromBase64Url(grant);
    await missing(await f.url(toBase64Url(bytes.subarray(0, bytes.length - 8))));
    await missing(await f.url(`${grant}A`));
    await missing(await f.url(grant.slice(1)));
  });

  it('masks the carried ref prefixes: two grants for one credential share no bytes, and both redeem', async () => {
    const f = await photoFixture();
    const [one, two] = [await mintPhoto(f), await mintPhoto(f)];
    const carried = (grant: string) => fromBase64Url(grant).subarray(38);
    expect(carried(one).length).toBeGreaterThan(0);
    expect(carried(one)).not.toEqual(carried(two));
    const plain = f.keys.credentialTombstoneRefs.map((ref) => ref.slice(0, 16));
    expect(await grantRefsOf(kit.ctx, one)).toEqual(plain);
    expect(await grantRefsOf(kit.ctx, two)).toEqual(plain);
    for (const grant of [one, two]) expect((await f.url(grant)).status).toBe(200);
  });

  it('refuses a grant whose expiry is further out than a grant is ever minted for', async () => {
    const f = await photoFixture();
    const grant = await mintPhoto(f);
    const verify = (skew: number) =>
      prepareAssetGrantVerification(
        { ...kit.ctx, clock: { now: () => kit.clock.now() - skew } },
        f.actor,
        f.candidate,
        f.candidate.connectionGeneration,
        grant,
        'commit',
        true,
      );
    // Within an hour and a minute of its expiry it verifies; further out it never does.
    expect(await verify(30_000)).not.toBeNull();
    expect(await verify(61_000)).toBeNull();
  });

  it('refuses a later expiry that was not minted', async () => {
    const f = await photoFixture();
    const grant = await mintPhoto(f);
    const bytes = fromBase64Url(grant);
    bytes[10] = (bytes[10] ?? 0) + 1;
    await missing(await f.url(toBase64Url(bytes)));
    expect((await f.url(grant)).status).toBe(200);
  });

  it('is bound to its asset class: a photo grant is not an icon grant and the reverse', async () => {
    const f = await photoFixture();
    const photo = await photoAssetGrantFor(kit, f.device, f.pass.id);
    const generic = await genericAssetGrantFor(kit, f.device, f.pass.id);
    expect((await f.url(photo)).status).toBe(200);
    expect((await f.url(generic, 'icon.png')).status).toBe(200);
    await missing(await f.url(photo, 'icon.png'));
    await missing(await f.url(generic, 'member.png'));
  });

  it('is bound to its recipient: another scanner and an admin cannot redeem it', async () => {
    const f = await photoFixture();
    const second = await kit.scanner({ templateIds: [templateId] });
    const grant = await mintPhoto(f);
    expect((await f.url(grant)).status).toBe(200);
    await missing(await f.url(grant, 'member.png', second));
    // The other scanner's own grant works for it, so the denial above is the recipient binding.
    expect(
      (await f.url(await photoAssetGrantFor(kit, second, f.pass.id), 'member.png', second)).status,
    ).toBe(200);

    const user = await makeUser(kit.fx);
    await grantScanMembership(kit.fx, kit.org.id, user.id);
    const session = await makeSession(kit.fx, { userId: user.id, roles: ['admin', 'user'] });
    const auth = await createSessionStore(kit.env, kit.clock).resolve(session.cookieValue);
    if (!auth) throw new Error('Session fixture missing');
    const authority = await tenantAuthorityOf(kit.ctx, auth, kit.org.id, 'scanning:read');
    if (authority.kind !== 'session') throw new Error('Session authority fixture missing');
    const admin = adminActor(auth, 'live', {
      orgId: kit.org.id,
      event: null,
      templateIds: [],
      timeZone: 'UTC',
    });
    admin.platformSessionId = auth.sessionId;
    admin.tenantAuthority = await captureScanTenantAuthority(kit.ctx, auth, authority);
    admin.role = tenantScanRole(admin.tenantAuthority);
    await captureScanEpochs(kit.env.DB, admin);
    const redeem = (actor: typeof admin, token: string) =>
      assetGrantValid(
        kit.ctx,
        actor,
        f.candidate,
        f.candidate.connectionGeneration,
        token,
        'commit',
        true,
      );
    expect(await redeem(admin, grant)).toBe(false);
    // Positive control: the admin's own grant redeems for the admin and not for the device.
    const own = await mintAssetGrant(
      kit.ctx,
      admin,
      f.candidate,
      f.candidate.connectionGeneration,
      f.candidate.activeTemplateVersion,
      true,
    );
    expect(await redeem(admin, own)).toBe(true);
    expect(
      await assetGrantValid(
        kit.ctx,
        f.actor,
        f.candidate,
        f.candidate.connectionGeneration,
        own,
        'commit',
        true,
      ),
    ).toBe(false);
  });

  it('refuses a snapshot with no or a wrong credential keyset or invalid refs', async () => {
    const f = await photoFixture();
    const mint = (snapshot: unknown) =>
      preparePhotoGrant(
        kit.ctx,
        f.actor,
        snapshot as typeof f.candidate,
        f.candidate.connectionGeneration,
        f.candidate.activeTemplateVersion,
      );
    expect(await mint(f.candidate)).not.toBeNull();
    const wrong =
      f.candidate.credentialKeysetCommitment === '0'.repeat(64) ? '1'.repeat(64) : '0'.repeat(64);
    for (const credentialKeysetCommitment of [wrong, 'invalid', undefined])
      expect(await mint({ ...f.candidate, credentialKeysetCommitment })).toBeNull();
    const ref = 'a'.repeat(64);
    for (const refs of [
      null,
      'x',
      [null],
      ['bad'],
      ['A'.repeat(64)],
      [ref, ref],
      [ref, ref, ref, ref],
    ])
      expect(await mint({ ...f.candidate, credentialTombstoneRefs: refs })).toBeNull();
  });
});
