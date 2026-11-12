import { expect, vi } from 'vitest';
import { fakeRateLimiter, makeScanner, persistTemplate } from '../../../../test/helpers/index.ts';
import type { ScanManifest } from '../../../passkit/types.ts';
import { createApp } from '../../app.ts';
import { denyAllStores } from '../../platform/auth.ts';
import { jobCtxOf } from '../delivery/delivery-test-fixtures.ts';
import { getHolderPass } from '../holders/repo.ts';
import { approveAppleRelease } from '../passes/apple-release-test-fixtures.ts';
import { createPassRow } from '../passes/create.ts';
import { startCredentialTransfer } from '../passes/credential-transfer.ts';
import { putMemberPhoto } from '../passes/member-photo.ts';
import { ICON_PNG } from '../passes/pass-test-fixtures.ts';
import { memberPhoto } from '../passes/repo-member-photo.ts';
import { makePng } from '../templates/package/fixtures.ts';
import { requireApprovedRelease } from '../templates/releases.ts';
import { setupSamsungCallbacks } from '../wallet-providers/callbacks-test-fixtures.ts';
import { assetActorFor } from './asset-test-fixtures.ts';
import { createScannerStore } from './auth-store.ts';
import { scanCredentialKeys } from './credential-input.ts';
import { assetGrantCredentialRefs } from './repo-asset-cross-pass-provenance-test-fixtures.ts';
import { credentialTombstonesClear } from './repo-credential-tombstones.ts';
import { candidateById } from './repo-lookup.ts';
import { resolveOutcome } from './resolve-outcome.ts';
import { key, type ScanKit } from './test-kit.ts';

const system = { type: 'system' as const, id: null };
const photoBytes = makePng(270, 270);
const encodedPhoto = btoa(String.fromCharCode(...photoBytes));
export const origin = 'https://wallet.test';
const person = 'Cross Pass Private Person';
const email = 'cross-pass-private@example.test';
const scan: ScanManifest = {
  actions: [{ id: 'check_in', label: 'Check in', kind: 'check_in' }],
  display: { v: 1, header: {}, photo: { minRole: 'door' } },
};

export async function expectPhoto(response: Response) {
  expect(response.status).toBe(200);
  expect(response.headers.get('content-type')).toBe('image/png');
  expect(response.headers.get('cache-control')).toBe('private, no-store');
  expect(response.headers.get('etag')).toBeNull();
  expect(new Uint8Array(await response.arrayBuffer())).toEqual(photoBytes);
}

export async function sha256Token(token: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

/** Pass A's actual Wallet barcode is pass B's serial; only B is transferred. */
export async function crossPassFixture() {
  const t = await setupSamsungCallbacks();
  Object.assign(t.kit.env, {
    RL_SCAN: fakeRateLimiter({ limit: 100_000 }),
    RL_SCAN_ORG: fakeRateLimiter({ limit: 100_000 }),
    RL_SCAN_LOOKUP: fakeRateLimiter({ limit: 100_000 }),
  });
  const orgId = t.kit.org.id;
  const raw = t.pass.serial;
  const id = t.kit.fx.ids.id();
  const template = t.kit.registry.add({
    id,
    orgId,
    version: 'v1',
    manifest: {
      ...t.kit.template.manifest,
      name: 'Cross-pass credential photo',
      scan,
    },
    passJson: {
      ...t.kit.template.passJson,
      barcodes: [{ format: 'PKBarcodeFormatQR', message: raw, messageEncoding: 'iso-8859-1' }],
    },
    assets: { 'icon.png': ICON_PNG },
  });
  await persistTemplate(t.kit.fx, template, { registry: t.kit.registry });
  await approveAppleRelease(t.kit, { templateId: id, mode: 'live', version: template.version });
  const release = await requireApprovedRelease(t.kit.ctx, id, orgId, 'live', 'apple');
  const target = await createPassRow(jobCtxOf(t.kit), {
    orgId,
    templateId: id,
    templateVersion: release.version,
    releaseId: release.id,
    releaseGeneration: release.generation,
    input: { memberName: person } as never,
    holderEmail: email,
    externalId: raw,
    mode: 'live',
    source: 'manual',
    actor: system,
    execution: { kind: 'system' },
  });
  await putMemberPhoto(
    t.kit.ctx,
    system,
    target.id,
    { png: encodedPhoto, includeInPass: false },
    null,
  );
  const device = await makeScanner(t.kit.fx, { orgId, templateIds: [id] });
  // The shared asset helper uses only the Kit context, environment and clock.
  const actor = await assetActorFor(t.kit as ScanKit, device);
  const keys = await scanCredentialKeys(t.kit.env, orgId, 'live', raw, false);
  const original = await candidateById(t.kit.env.DB, orgId, target.id);
  const source = await candidateById(t.kit.env.DB, orgId, t.pass.id);
  const expected = await getHolderPass(t.kit.env.DB, t.pass.id, null);
  const photo = await memberPhoto(t.kit.env.DB, orgId, target.id);
  if (!original || !source || !expected || !photo || !original.assetPhoto)
    throw new Error('Cross-pass fixture missing');
  const wallet = JSON.parse(original.passJsonSnapshot ?? '{}') as {
    barcodes?: { message?: string }[];
  };
  expect(wallet.barcodes?.[0]?.message).toBe(raw);
  expect(target.barcodeHash).toBe(keys.barcodeHash);
  expect(keys.credentialTombstoneRefs.length).toBeGreaterThan(0);
  expect(
    await credentialTombstonesClear(
      t.kit.env.DB,
      orgId,
      'live',
      keys.credentialTombstoneRefs,
      keys.credentialKeysetCommitment,
    ),
  ).toBe(true);
  expect(source.transferPending).toBe(false);
  const app = createApp({
    stores: { ...denyAllStores, scanners: createScannerStore(t.kit.env, t.kit.clock) },
    clock: t.kit.clock,
  });
  const request = (url: string) =>
    app.request(new URL(url, origin).href, { headers: device.headers }, t.kit.env);
  const transfer = () =>
    startCredentialTransfer(
      jobCtxOf(t.kit),
      system,
      t.pass.id,
      { holderEmail: 'next@example.test', ownerUserId: null },
      null,
      { kind: 'tenant-holder', expected },
    );
  const scannedPhoto = async () => {
    const logs = (['log', 'info', 'warn', 'error', 'debug'] as const).map((level) =>
      vi.spyOn(console, level).mockImplementation(() => {}),
    );
    try {
      const result = await resolveOutcome(t.kit.ctx, actor, {
        idempotencyKey: key(),
        input: { code: raw, method: 'manual' },
        clientTs: t.kit.clock.now(),
      });
      expect(result.outcome).toMatchObject({ kind: 'ready', card: { passId: target.id } });
      expect(result.evaluatedSnapshot?.credentialTombstoneRefs).toEqual(
        keys.credentialTombstoneRefs,
      );
      expect(result.evaluatedSnapshot?.credentialKeysetCommitment).toBe(
        original.credentialKeysetCommitment,
      );
      const photoUrl = result.outcome.card?.display.identity.photo?.url;
      if (!photoUrl || !result.evaluatedSnapshot) throw new Error('Scanned photo grant missing');
      const commitment = result.evaluatedSnapshot.credentialKeysetCommitment;
      if (typeof commitment !== 'string') throw new Error('Credential keyset fixture missing');
      await expectPhoto(await request(photoUrl));
      const output = JSON.stringify(logs.flatMap((spy) => spy.mock.calls));
      const parsed = new URL(photoUrl, origin);
      expect([...parsed.searchParams.keys()]).toEqual(['g']);
      const token = parsed.searchParams.get('g');
      expect(token).toMatch(/^[A-Za-z0-9_-]{54}$/);
      if (!token) throw new Error('Photo capability missing');
      const dto = JSON.stringify(result.outcome);
      for (const secret of [
        raw,
        email,
        ...keys.credentialTombstoneRefs,
        commitment,
        photo.r2_key,
        photo.version,
        photo.sha1,
      ]) {
        for (const text of [photoUrl, dto, output]) expect(text).not.toContain(secret);
      }
      expect(output).not.toContain(token);
      expect(output).not.toContain(person);
      expect(dto).not.toMatch(
        /credentialTombstoneRefs|credentialKeysetCommitment|credentialRefsJson|assetPhoto/,
      );
      const row = await assetGrantCredentialRefs(t.kit.env.DB, await sha256Token(token));
      expect(row?.credential_refs).toBe(JSON.stringify(keys.credentialTombstoneRefs));
      return { snapshot: result.evaluatedSnapshot, photoUrl, token };
    } finally {
      for (const spy of logs) spy.mockRestore();
    }
  };
  return {
    t,
    orgId,
    raw,
    target,
    device,
    actor,
    keys,
    original,
    source,
    photo,
    request,
    transfer,
    scannedPhoto,
  };
}
