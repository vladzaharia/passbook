import { beforeAll, describe, expect, it } from 'vitest';
import type { ScanManifest } from '../../../passkit/types.ts';
import { first } from '../../platform/db.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { ensureCredentialRefKeyset } from '../passes/credential-keyset.ts';
import { putMemberPhoto } from '../passes/member-photo.ts';
import { makePng } from '../templates/package/fixtures.ts';
import type { ScanActor } from './actor.ts';
import { grantInsertConfirmed } from './asset-grant-results.ts';
import { assetActorFor } from './asset-test-fixtures.ts';
import { confirmAssetGrantToken, preparePhotoGrant } from './assets.ts';
import { scanCredentialKeys } from './credential-input.ts';
import { prepareAssetGrantInsertion } from './repo-asset-grants.ts';
import { type Candidate, candidateById } from './repo-lookup.ts';
import { type ScanKit, setupScanKit } from './test-kit.ts';

const system = { type: 'system' as const, id: null };
const photoBytes = makePng(270, 270);
const encodedPhoto = btoa(String.fromCharCode(...photoBytes));
const person = 'Cross Pass Private Person';
const email = 'cross-pass-private@example.test';
const scan: ScanManifest = {
  actions: [{ id: 'check_in', label: 'Check in', kind: 'check_in' }],
  display: { v: 1, header: {}, photo: { minRole: 'door' } },
};
let kit: ScanKit, templateId: string;
beforeAll(async () => {
  kit = await setupScanKit();
  await ensureCredentialRefKeyset(kit.env.DB, kit.env);
  templateId = await kit.scanTemplate('Asset capability provenance', scan);
});
async function planFor(ctx: ServiceContext, actor: ScanActor, candidate: Candidate) {
  const plan = await preparePhotoGrant(
    ctx,
    actor,
    candidate,
    candidate.connectionGeneration,
    candidate.activeTemplateVersion,
  );
  if (!plan) throw new Error('Expected a photo grant plan');
  return plan;
}

async function expectMissing(response: Response) {
  expect(response.status).toBe(404);
  expect(await response.json()).toMatchObject({ code: 'ASSET_NOT_FOUND' });
}

async function expectPhoto(response: Response) {
  expect(response.status).toBe(200);
  expect(response.headers.get('content-type')).toBe('image/png');
  expect(response.headers.get('cache-control')).toBe('private, no-store');
  expect(response.headers.get('etag')).toBeNull();
  expect(new Uint8Array(await response.arrayBuffer())).toEqual(photoBytes);
}

async function sha256Token(token: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}
async function photoFixture() {
  const device = await kit.scanner({ templateIds: [templateId] });
  const actor = await assetActorFor(kit, device);
  const pass = await kit.scanPass(templateId, { memberName: person }, { holderEmail: email });
  await putMemberPhoto(kit.ctx, system, pass.id, { png: encodedPhoto, includeInPass: false }, null);
  if (!pass.scanCode) throw new Error('Pass scan code missing');
  const keys = await scanCredentialKeys(kit.env, kit.org.id, 'live', pass.scanCode, false);
  const current = await candidateById(kit.env.DB, kit.org.id, pass.id);
  if (!current?.assetPhoto) throw new Error('Photo fixture missing');
  expect(current.credentialKeysetCommitment).toMatch(/^[a-f0-9]{64}$/);
  expect(current.credentialKeysetCommitment).toBe(keys.credentialKeysetCommitment);
  expect(keys.credentialTombstoneRefs.length).toBeGreaterThan(0);
  const candidate = { ...current, credentialTombstoneRefs: keys.credentialTombstoneRefs };
  return { device, actor, pass, candidate, keys, raw: pass.scanCode };
}

describe('scanner asset capability provenance', () => {
  it('keeps a cloneable tokenless plan unusable until its guarded batch is confirmed', async () => {
    const { device, actor, pass, candidate, keys, raw } = await photoFixture();
    const plan = await planFor(kit.ctx, actor, candidate);
    expect(Object.isFrozen(plan)).toBe(true);
    expect(Object.isFrozen(plan.guard)).toBe(true);
    expect(Object.isFrozen(plan.guard.credentialTombstoneRefs)).toBe(true);
    const clone = structuredClone(plan);
    expect(clone).toEqual(plan);
    expect(clone).not.toBe(plan);
    const csrf = await first<{ csrf_secret: string }>(
      kit.env.DB,
      'SELECT csrf_secret FROM scanners WHERE id=?',
      [device.id],
    );
    if (!csrf?.csrf_secret) throw new Error('Scanner CSRF fixture missing');
    const cloned = JSON.stringify(clone);
    const jsonClone = JSON.parse(cloned) as typeof plan;
    expect(jsonClone).not.toHaveProperty('token');
    expect(cloned).not.toContain(csrf.csrf_secret);
    expect(cloned).not.toContain(device.token);
    expect(cloned).not.toMatch(/passJsonSnapshot|personalization/i);
    for (const secret of [
      candidate.pass.authToken,
      candidate.pass.downloadToken,
      candidate.pass.scanCode,
    ]) {
      if (secret) expect(cloned).not.toContain(secret);
    }
    expect(plan).not.toHaveProperty('token');
    expect(plan.guard).not.toHaveProperty('actor');
    expect(plan.guard).not.toHaveProperty('source');
    expect(plan.guard).not.toHaveProperty('recipientSession');
    expect(plan.guard).not.toHaveProperty('sourceSession');
    expect(confirmAssetGrantToken(plan, undefined)).toBeNull();
    expect(plan.expiresAt).toBe(kit.clock.now() + 3_600_000);
    const cloneBind = await prepareAssetGrantInsertion(kit.ctx, clone, undefined, candidate);
    await expect(kit.env.DB.batch(cloneBind(kit.clock.now(), undefined))).rejects.toThrow(
      'scan_asset_authority_failed',
    );
    const jsonBind = await prepareAssetGrantInsertion(kit.ctx, jsonClone, undefined, candidate);
    await expect(kit.env.DB.batch(jsonBind(kit.clock.now(), undefined))).rejects.toThrow(
      'scan_asset_authority_failed',
    );
    const alteredRefs = { ...candidate, credentialTombstoneRefs: [] };
    const alteredBind = await prepareAssetGrantInsertion(kit.ctx, plan, undefined, alteredRefs);
    await expect(kit.env.DB.batch(alteredBind(kit.clock.now(), undefined))).rejects.toThrow(
      'scan_asset_authority_failed',
    );
    const bind = await prepareAssetGrantInsertion(kit.ctx, plan, undefined, candidate);
    await expect(kit.env.DB.batch(bind(kit.clock.now(), { sql: '0', params: [] }))).rejects.toThrow(
      'scan_asset_authority_failed',
    );
    expect(grantInsertConfirmed(undefined)).toBe(false);
    expect(
      await first(kit.env.DB, 'SELECT * FROM scan_asset_grant_provenance WHERE token_hash = ?', [
        plan.tokenHash,
      ]),
    ).toBeNull();
    const [output, ...inserted] = await kit.env.DB.batch([
      kit.env.DB.prepare('SELECT 42 AS output_marker'),
      ...bind(kit.clock.now(), undefined),
    ]);
    expect(output?.results).toEqual([{ output_marker: 42 }]);
    expect(grantInsertConfirmed(inserted)).toBe(true);
    expect(confirmAssetGrantToken(clone, inserted)).toBeNull();
    expect(confirmAssetGrantToken(jsonClone, inserted)).toBeNull();
    const token = confirmAssetGrantToken(plan, inserted);
    if (!token) throw new Error('Confirmed asset token missing');
    expect(confirmAssetGrantToken(plan, inserted)).toBeNull();
    expect(token).toMatch(/^[A-Za-z0-9_-]{54}$/);
    expect(atob(`${token.replace(/-/g, '+').replace(/_/g, '/')}==`)).toHaveLength(40);
    expect(plan.tokenHash).toBe(await sha256Token(token));
    const image = () => kit.get(device.headers, `/passes/${pass.id}/assets/member.png?g=${token}`);
    expect(inserted[0]?.results).toEqual([{ token_hash: plan.tokenHash }]);
    const row = await first<Record<string, unknown>>(
      kit.env.DB,
      'SELECT * FROM scan_asset_grant_provenance WHERE token_hash = ?',
      [plan.tokenHash],
    );
    expect(row).toEqual({
      token_hash: await sha256Token(token),
      org_id: kit.org.id,
      mode: 'live',
      expires_at: kit.clock.now() + 3_600_000,
      credential_refs: JSON.stringify(keys.credentialTombstoneRefs),
    });
    const stored = JSON.stringify(row);
    for (const secret of [
      token,
      raw,
      pass.id,
      pass.serial,
      pass.identityId,
      pass.downloadToken,
      device.id,
      device.token,
      actor.scanner?.csrfSecret,
      actor.scanningSession?.id,
      person,
      email,
      candidate.activeReleaseId,
      candidate.activeReleaseCandidateHash,
      candidate.credentialKeysetCommitment,
      candidate.assetPhoto!.version,
      candidate.assetPhoto!.key,
      candidate.assetPhoto!.sha1,
    ]) {
      if (secret) expect(stored).not.toContain(secret);
    }
    await expectPhoto(await image());
    // Losing the row, or replacing its refs, never recreates the original capability.
    await kit.env.DB.prepare('DELETE FROM scan_asset_grant_provenance WHERE token_hash = ?')
      .bind(plan.tokenHash)
      .run();
    await expectMissing(await image());
    await kit.env.DB.prepare(`INSERT INTO scan_asset_grant_provenance
      (token_hash, org_id, mode, expires_at, credential_refs) VALUES (?, ?, ?, ?, ?)`)
      .bind(plan.tokenHash, kit.org.id, 'live', plan.expiresAt, '[]')
      .run();
    await expectMissing(await image());
  });
  it('fails closed on missing or invalid original references and keyset commitments', async () => {
    const { actor, candidate } = await photoFixture();
    const missing: Partial<Candidate> = { ...candidate };
    delete missing.credentialTombstoneRefs;
    expect(
      await preparePhotoGrant(
        kit.ctx,
        actor,
        missing as Candidate,
        candidate.connectionGeneration,
        candidate.activeTemplateVersion,
      ),
    ).toBeNull();
    const ref = 'a'.repeat(64);
    const invalid: unknown[] = [
      null,
      'not-an-array',
      [null],
      ['bad'],
      ['A'.repeat(64)],
      [ref, ref],
      ['1'.repeat(64), '2'.repeat(64), '3'.repeat(64), '4'.repeat(64)],
    ];
    for (const refs of invalid) {
      const altered = { ...candidate, credentialTombstoneRefs: refs } as Candidate;
      expect(
        await preparePhotoGrant(
          kit.ctx,
          actor,
          altered,
          candidate.connectionGeneration,
          candidate.activeTemplateVersion,
        ),
      ).toBeNull();
    }
    missing.credentialTombstoneRefs = candidate.credentialTombstoneRefs;
    delete missing.credentialKeysetCommitment;
    const wrong =
      candidate.credentialKeysetCommitment === '0'.repeat(64) ? '1'.repeat(64) : '0'.repeat(64);
    const snapshots = [
      missing as Candidate,
      { ...candidate, credentialKeysetCommitment: 'invalid' },
      { ...candidate, credentialKeysetCommitment: wrong },
    ];
    for (const snapshot of snapshots) {
      const plan = await preparePhotoGrant(
        kit.ctx,
        actor,
        snapshot,
        candidate.connectionGeneration,
        candidate.activeTemplateVersion,
      );
      if (!plan) {
        expect(plan).toBeNull();
        continue;
      }
      const bind = await prepareAssetGrantInsertion(kit.ctx, plan, undefined, snapshot);
      await expect(kit.env.DB.batch(bind(kit.clock.now(), undefined))).rejects.toThrow(
        'scan_asset_authority_failed',
      );
      expect(
        await first(kit.env.DB, 'SELECT * FROM scan_asset_grant_provenance WHERE token_hash = ?', [
          plan.tokenHash,
        ]),
      ).toBeNull();
      expect(confirmAssetGrantToken(plan, undefined)).toBeNull();
    }
  });
});
