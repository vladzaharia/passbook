import { runInDurableObject } from 'cloudflare:test';
import { describe, expect, it, vi } from 'vitest';
import { first, run } from '../../platform/db.ts';
import { jobCtxOf } from '../delivery/delivery-test-fixtures.ts';
import { getHolderPass } from '../holders/repo.ts';
import { startCredentialTransfer } from '../passes/credential-transfer.ts';
import { memberPhoto } from '../passes/repo-member-photo.ts';
import { act } from './act.ts';
import { scannerActor, withRole } from './actor.ts';
import { barcodeHashOfCode, cleanCode } from './codes.ts';
import { publishScan } from './live.ts';
import { type InternalLiveRow, openLiveSourceProof } from './live-provenance.ts';
import { getScanner } from './repo-device.ts';
import { readScannerScope } from './repo-scope.ts';
import { hub, kit, observeCancellation, photoFixture, template } from './scan-hub-test-fixtures.ts';
import { bindScanningSession } from './scanning-workspace.ts';
import { codeOf, key, proofedScanActor } from './test-kit.ts';

async function credentialFixture() {
  const fixture = await photoFixture();
  const scanner = await getScanner(kit.env.DB, fixture.source.id);
  if (!scanner) throw new Error('Missing source scanner.');
  const scope = await readScannerScope(kit.env.DB, scanner, null);
  const rawActor = scannerActor(kit.ctx, scanner, scanner.mode, 'cookie', scope);
  await bindScanningSession(kit.ctx, rawActor);
  withRole(rawActor, null);
  const actor = await proofedScanActor(kit.ctx, rawActor);
  const input = codeOf(fixture.pass);
  const { outcome, evaluatedSnapshot, credentialContext } = await act(kit.ctx, actor, {
    input,
    actionId: 'check_in',
    clientTs: kit.clock.now(),
    idempotencyKey: key(),
  });
  if (
    !evaluatedSnapshot ||
    !credentialContext?.credentialTombstoneRefs.length ||
    !credentialContext.otherModeCredentialTombstoneRefs.length
  )
    throw new Error('Missing evaluated credential authority.');
  expect(outcome.kind).toBe('ok');
  expect(credentialContext.credentialKeysetCommitment).toBe(
    evaluatedSnapshot.credentialKeysetCommitment,
  );
  expect(credentialContext.credentialTombstoneRefs).toEqual(
    evaluatedSnapshot.credentialTombstoneRefs,
  );
  expect(credentialContext.otherModeCredentialTombstoneRefs).toEqual(
    evaluatedSnapshot.otherModeCredentialTombstoneRefs,
  );
  return { ...fixture, actor, input, outcome, evaluatedSnapshot, credentialContext };
}

type CredentialFixture = Awaited<ReturnType<typeof credentialFixture>>;

async function publishCredential(fixture: CredentialFixture) {
  publishScan(
    kit.ctx,
    fixture.actor,
    fixture.outcome,
    fixture.evaluatedSnapshot,
    fixture.credentialContext,
    'camera',
  );
  await kit.settle();
  const projection = (await hub().snapshot(fixture.monitor.attachment)).rows.find(
    (entry) => entry.scannerId === fixture.source.id && entry.id !== fixture.event.id,
  );
  if (!projection) throw new Error('Missing credential-sourced live event.');
  return projection;
}

async function retirePresentedCredential(fixture: CredentialFixture) {
  const other = await kit.scanPass(template);
  await run(kit.env.DB, 'UPDATE passes SET barcode_hash=?,revision=revision+1 WHERE id=?', [
    await barcodeHashOfCode(cleanCode(fixture.input.code)),
    other.id,
  ]);
  const expected = await getHolderPass(kit.env.DB, other.id, null);
  if (!expected) throw new Error('Missing transfer snapshot.');
  const transfer = await startCredentialTransfer(
    jobCtxOf(kit),
    { type: 'system', id: null },
    other.id,
    { holderEmail: 'next-holder@example.test', ownerUserId: null },
    null,
    { kind: 'tenant-holder', expected },
  );
  expect(transfer.state).toBe('completed');
  const ref = fixture.evaluatedSnapshot.credentialTombstoneRefs;
  expect(
    await first(
      kit.env.DB,
      `SELECT 1 FROM pass_credential_tombstones
    WHERE org_id=? AND mode=? AND credential_hash IN (SELECT value FROM json_each(?))`,
      [fixture.pass.orgId, fixture.pass.mode, JSON.stringify(ref)],
    ),
  ).not.toBeNull();
}

describe('live submitted credential authority', () => {
  it.each(['own', 'other', 'both'] as const)(
    'does not turn a missing %s credential reference set into pass-ID authority',
    async (missing) => {
      const fixture = await credentialFixture();
      const candidate = {
        ...fixture.evaluatedSnapshot,
        credentialTombstoneRefs:
          missing === 'other' ? fixture.evaluatedSnapshot.credentialTombstoneRefs : [],
        otherModeCredentialTombstoneRefs:
          missing === 'own' ? fixture.evaluatedSnapshot.otherModeCredentialTombstoneRefs : [],
      };
      publishScan(
        kit.ctx,
        fixture.actor,
        fixture.outcome,
        candidate,
        fixture.credentialContext,
        'camera',
      );
      await kit.settle();
      const rejected = (await hub().snapshot(fixture.monitor.attachment)).rows.find(
        (entry) => entry.scannerId === fixture.source.id && entry.id !== fixture.event.id,
      );
      expect(rejected).toBeUndefined();
      publishScan(
        kit.ctx,
        fixture.actor,
        fixture.outcome,
        candidate,
        {
          ...fixture.credentialContext,
          credentialTombstoneRefs: candidate.credentialTombstoneRefs,
          otherModeCredentialTombstoneRefs: candidate.otherModeCredentialTombstoneRefs,
        },
        'camera',
      );
      await kit.settle();
      const projection = (await hub().snapshot(fixture.monitor.attachment)).rows.find(
        (entry) => entry.scannerId === fixture.source.id && entry.id !== fixture.event.id,
      );
      expect(projection).toBeUndefined();
    },
  );

  it('retains encrypted input refs and omits a credential retired before publication', async () => {
    const fixture = await credentialFixture();
    await retirePresentedCredential(fixture);
    publishScan(
      kit.ctx,
      fixture.actor,
      fixture.outcome,
      fixture.evaluatedSnapshot,
      fixture.credentialContext,
      'camera',
    );
    await kit.settle();
    const projections = (await hub().snapshot(fixture.monitor.attachment)).rows.filter(
      (entry) => entry.scannerId === fixture.source.id && entry.id !== fixture.event.id,
    );
    expect(projections).toEqual([]);
    const retained = await runInDurableObject(hub(), async (_object, state) =>
      ((await state.storage.get<InternalLiveRow[]>('recent')) ?? []).filter(
        (entry) => entry.scannerId === fixture.source.id && entry.id !== fixture.event.id,
      ),
    );
    expect(retained).toHaveLength(1);
    const sealed = await hub().sourceProof(retained[0]!.id);
    if (!sealed) throw new Error('Missing source proof.');
    const proof = await openLiveSourceProof(kit.env, sealed);
    expect(proof?.credentialContext).toEqual(fixture.credentialContext);
    expect(proof?.passSnapshot?.credentialKeysetCommitment).toBe(
      fixture.credentialContext.credentialKeysetCommitment,
    );
    expect(proof?.passSnapshot?.credentialTombstoneRefs).toEqual(
      fixture.evaluatedSnapshot.credentialTombstoneRefs,
    );
    expect(proof?.passSnapshot?.otherModeCredentialTombstoneRefs).toEqual(
      fixture.evaluatedSnapshot.otherModeCredentialTombstoneRefs,
    );
    for (const ref of [
      ...fixture.credentialContext.credentialTombstoneRefs,
      ...fixture.credentialContext.otherModeCredentialTombstoneRefs,
    ]) {
      expect(JSON.stringify(projections)).not.toContain(ref);
      expect(sealed).not.toContain(ref);
    }
    // The separately authorized pass-ID event did not use the retired input.
    expect((await kit.get(fixture.monitor.headers, fixture.path)).status).toBe(200);
  });

  it('rejects an already-issued live photo grant after its input credential retires', async () => {
    const fixture = await credentialFixture();
    const projection = await publishCredential(fixture);
    if (!projection.photoUrl) throw new Error('Missing credential-sourced photo.');
    const path = projection.photoUrl.replace('/api/v1/scan', '');
    expect((await kit.get(fixture.monitor.headers, path)).status).toBe(200);
    await retirePresentedCredential(fixture);
    expect((await kit.get(fixture.monitor.headers, path)).status).toBe(404);
    const after = (await hub().snapshot(fixture.monitor.attachment)).rows.find(
      (item) => item.id === projection.id,
    );
    expect(after).toBeUndefined();
    expect((await kit.get(fixture.monitor.headers, fixture.path)).status).toBe(200);
  });

  it('cancels an opened photo stream if its credential retires during the object read', async () => {
    const fixture = await credentialFixture();
    const projection = await publishCredential(fixture);
    if (!projection.photoUrl) throw new Error('Missing credential-sourced photo.');
    const path = projection.photoUrl.replace('/api/v1/scan', '');
    const stored = await memberPhoto(kit.env.DB, kit.org.id, fixture.pass.id);
    if (!stored) throw new Error('Missing stored photo.');
    const originalGet = kit.env.BUCKET.get.bind(kit.env.BUCKET);
    let changed = false;
    let cancelled = false;
    const spy = vi.spyOn(kit.env.BUCKET, 'get').mockImplementation(async (key, options) => {
      const object = await originalGet(key, options);
      if (key !== stored.r2_key || !object || changed) return object;
      changed = true;
      await retirePresentedCredential(fixture);
      return observeCancellation(object, () => {
        cancelled = true;
      });
    });
    try {
      expect((await kit.get(fixture.monitor.headers, path)).status).toBe(404);
      expect(changed).toBe(true);
      expect(cancelled).toBe(true);
    } finally {
      spy.mockRestore();
    }
  });
});
