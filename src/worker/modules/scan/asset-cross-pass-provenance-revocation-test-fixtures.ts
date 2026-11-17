import { expect } from 'vitest';
import {
  crossPassFixture,
  expectPhoto,
  origin,
} from './asset-cross-pass-provenance-setup-test-fixtures.ts';
import { parseGrant } from './asset-grant-mint.ts';
import { credentialTombstonesClear } from './repo-credential-tombstones.ts';
import { candidateById } from './repo-lookup.ts';
import { resolveOutcome } from './resolve-outcome.ts';
import { key } from './test-kit.ts';

export async function expectMissing(response: Response) {
  expect(response.status).toBe(404);
  expect(await response.json()).toMatchObject({ code: 'ASSET_NOT_FOUND' });
}

export async function crossPassRevocationFixture() {
  const f = await crossPassFixture();
  const scanned = await f.scannedPhoto();
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
  // A pass-ID evaluation presents no credential, so its capability carries no retired-ref check.
  expect(parseGrant(explicitToken)?.refs).toEqual([]);
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
    // The scanned pass itself did not move: only the credential it was scanned from was retired.
    expect(current?.pass).toEqual(f.original.pass);
    expect(current?.assetPhoto).toEqual(f.original.assetPhoto);
    expect(pending.transferPending).toBe(true);
    expect(pending.pass.credentialGeneration).toBeGreaterThan(f.source.pass.credentialGeneration);
    await expectMissing(await f.request(scanned.photoUrl));
    await expectMissing(
      await f.request(`/api/v1/scan/passes/${f.target.id}/assets/icon.png?g=${scanned.token}`),
    );
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
