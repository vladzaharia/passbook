import { expect } from 'vitest';
import type { ServiceContext } from '../../platform/service-context.ts';
import type { ScanActor } from './actor.ts';
import {
  crossPassFixture,
  expectPhoto,
  origin,
  sha256Token,
} from './asset-cross-pass-provenance-setup-test-fixtures.ts';
import { confirmAssetGrantToken, preparePhotoGrant } from './assets.ts';
import {
  assetGrantCredentialRefs,
  assetGrantProvenance,
} from './repo-asset-cross-pass-provenance-test-fixtures.ts';
import { prepareAssetGrantInsertion } from './repo-asset-grants.ts';
import { credentialTombstonesClear } from './repo-credential-tombstones.ts';
import { type Candidate, candidateById } from './repo-lookup.ts';
import { resolveOutcome } from './resolve-outcome.ts';
import { key } from './test-kit.ts';

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

export async function expectMissing(response: Response) {
  expect(response.status).toBe(404);
  expect(await response.json()).toMatchObject({ code: 'ASSET_NOT_FOUND' });
}

export async function crossPassRevocationFixture() {
  const f = await crossPassFixture();
  const scanned = await f.scannedPhoto();
  const original = {
    ...f.original,
    credentialTombstoneRefs: scanned.snapshot.credentialTombstoneRefs,
  };
  const stalePlan = await planFor(f.t.kit.ctx, f.actor, original);
  const cloned = JSON.stringify(structuredClone(stalePlan));
  expect(stalePlan.guard.snapshotProof).toMatch(/^[A-Za-z0-9_-]{43}$/);
  expect(cloned).not.toMatch(/passJsonSnapshot|personalization/i);
  for (const secret of [
    original.pass.authToken,
    original.pass.downloadToken,
    original.pass.scanCode,
  ]) {
    if (secret) expect(cloned).not.toContain(secret);
  }
  const explicit = await resolveOutcome(f.t.kit.ctx, f.actor, {
    idempotencyKey: key(),
    input: { passId: f.target.id, method: 'manual' },
    clientTs: f.t.kit.clock.now(),
  });
  expect(explicit.outcome).toMatchObject({ kind: 'ready', card: { passId: f.target.id } });
  expect(explicit.evaluatedSnapshot?.credentialTombstoneRefs).toEqual([]);
  const explicitUrl = explicit.outcome.card?.display.identity.photo?.url;
  if (!explicitUrl) throw new Error('Explicit pass ID photo grant missing');
  const explicitToken = new URL(explicitUrl, origin).searchParams.get('g');
  if (!explicitToken) throw new Error('Explicit pass ID capability missing');
  const explicitRow = await assetGrantCredentialRefs(
    f.t.kit.env.DB,
    await sha256Token(explicitToken),
  );
  expect(explicitRow?.credential_refs).toBe('[]');
  await expectPhoto(await f.request(explicitUrl));
  const expectCrossPassRevoked = async () => {
    expect(
      await credentialTombstonesClear(
        f.t.kit.env.DB,
        f.orgId,
        'live',
        f.keys.credentialTombstoneRefs,
        f.keys.credentialKeysetCommitment,
      ),
    ).toBe(false);
    const current = await candidateById(f.t.kit.env.DB, f.orgId, f.target.id);
    const pending = await candidateById(f.t.kit.env.DB, f.orgId, f.t.pass.id);
    if (!pending) throw new Error('Expected transfer-pending pass');
    expect(current?.pass).toEqual(f.original.pass);
    expect(current?.assetPhoto).toEqual(f.original.assetPhoto);
    expect(pending.transferPending).toBe(true);
    expect(pending.pass.credentialGeneration).toBeGreaterThan(f.source.pass.credentialGeneration);
    const bind = await prepareAssetGrantInsertion(f.t.kit.ctx, stalePlan, undefined, original);
    await expect(f.t.kit.env.DB.batch(bind(f.t.kit.clock.now(), undefined))).rejects.toThrow(
      'scan_asset_authority_failed',
    );
    expect(await assetGrantProvenance(f.t.kit.env.DB, stalePlan.tokenHash)).toBeNull();
    await expectMissing(await f.request(scanned.photoUrl));
    await expectMissing(
      await f.request(`/api/v1/scan/passes/${f.target.id}/assets/icon.png?g=${scanned.token}`),
    );
    expect(confirmAssetGrantToken(stalePlan, undefined)).toBeNull();
    // A pass-ID evaluation has no submitted credential to tombstone and remains authorized.
    await expectPhoto(await f.request(explicitUrl));
    const fresh = await resolveOutcome(f.t.kit.ctx, f.actor, {
      idempotencyKey: key(),
      input: { passId: f.target.id, method: 'manual' },
      clientTs: f.t.kit.clock.now(),
    });
    expect(fresh.outcome).toMatchObject({ kind: 'ready', card: { passId: f.target.id } });
    expect(fresh.evaluatedSnapshot?.credentialTombstoneRefs).toEqual([]);
    const freshUrl = fresh.outcome.card?.display.identity.photo?.url;
    if (!freshUrl) throw new Error('Fresh explicit pass ID photo grant missing');
    await expectPhoto(await f.request(freshUrl));
  };
  return { f, scanned, expectCrossPassRevoked };
}
