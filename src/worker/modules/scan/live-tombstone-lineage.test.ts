import { describe, expect, it, vi } from 'vitest';
import { jobCtxOf } from '../delivery/delivery-test-fixtures.ts';
import { createPassRow } from '../passes/create.ts';
import { memberPhoto } from '../passes/repo-member-photo.ts';
import { requireApprovedRelease } from '../templates/releases.ts';
import { scannerActor, withRole } from './actor.ts';
import { publishScan } from './live.ts';
import { openLiveSourceProof } from './live-provenance.ts';
import { getScanner } from './repo-device.ts';
import { candidateById } from './repo-lookup.ts';
import { resolveOutcome } from './resolve-outcome.ts';
import {
  beginCredentialTransfer,
  hub,
  kit,
  observeCancellation,
  photoFixture,
  screen,
  template,
} from './scan-hub-test-fixtures.ts';
import { codeOf, key, proofedScanActor } from './test-kit.ts';

describe('live credential tombstone provenance', () => {
  it.each(['live', 'test'] as const)(
    'omits a passless cross-mode hint when its original %s-mode refs become tombstoned',
    async (transferMode) => {
      const source = await kit.scanner({ templateIds: [template] });
      const monitor = await screen('monitor', [source.id]);
      const scanner = await getScanner(kit.env.DB, source.id);
      if (!scanner) throw new Error('Missing source scanner.');
      const actor = await proofedScanActor(
        kit.ctx,
        withRole(
          scannerActor(kit.ctx, scanner, 'live', 'cookie', {
            event: null,
            templateIds: [template],
          }),
          null,
        ),
      );
      const testPass = await kit.scanPass(
        template,
        { memberName: 'Other Mode Member' },
        { mode: 'test' },
      );
      if (!testPass.scanCode) throw new Error('Missing other-mode scan code.');
      const release = await requireApprovedRelease(
        kit.ctx,
        template,
        kit.org.id,
        transferMode,
        'apple',
      );
      const other = await createPassRow(jobCtxOf(kit), {
        orgId: kit.org.id,
        templateId: template,
        templateVersion: release.version,
        releaseId: release.id,
        releaseGeneration: release.generation,
        input: { memberName: 'Transfer Member' },
        holderEmail: null,
        serial: testPass.scanCode,
        source: 'manual',
        mode: transferMode,
        actor: { type: 'system', id: null },
        execution: { kind: 'system' },
      });
      const evaluation = await resolveOutcome(kit.ctx, actor, {
        input: codeOf(testPass),
        clientTs: kit.clock.now(),
        idempotencyKey: key(),
      });
      expect(evaluation.outcome).toMatchObject({ kind: 'refused', reason: 'test_pass' });
      expect(evaluation.evaluatedSnapshot).toBeNull();
      const context = evaluation.credentialContext;
      if (
        !context?.credentialTombstoneRefs.length ||
        !context.otherModeCredentialTombstoneRefs.length
      )
        throw new Error('Missing cross-mode input provenance.');
      publishScan(kit.ctx, actor, evaluation.outcome, null, context, 'camera');
      await kit.settle();
      const initial = (await hub().snapshot(monitor.attachment)).rows.find(
        (entry) => entry.scannerId === source.id,
      );
      if (!initial) throw new Error('Missing passless cross-mode event.');
      expect(initial).toMatchObject({ passId: null, holder: null, photoUrl: null });
      const sealed = await hub().sourceProof(initial.id);
      if (!sealed) throw new Error('Missing cross-mode source proof.');
      const proof = await openLiveSourceProof(kit.env, sealed);
      expect(proof?.passSnapshot).toBeNull();
      expect(proof?.credentialContext).toEqual(context);
      expect(JSON.stringify(initial)).not.toContain(testPass.scanCode);
      for (const ref of [
        ...context.credentialTombstoneRefs,
        ...context.otherModeCredentialTombstoneRefs,
      ])
        expect(JSON.stringify(initial)).not.toContain(ref);
      const finish = await beginCredentialTransfer(other.id);
      try {
        const stale = (await hub().snapshot(monitor.attachment)).rows.find(
          (entry) => entry.id === initial.id,
        );
        expect(stale).toBeUndefined();
      } finally {
        await finish();
      }
      expect(
        (await hub().snapshot(monitor.attachment)).rows.find((entry) => entry.id === initial.id),
      ).toBeUndefined();
    },
  );

  it('rechecks the original presented credential without invalidating unrelated explicit pass-id results', async () => {
    const fixture = await photoFixture();
    const pass = fixture.pass;
    const before = await candidateById(kit.env.DB, kit.org.id, pass.id);
    if (
      !pass.scanCode ||
      !before?.activeReleaseId ||
      before.activeReleaseGeneration === null ||
      !before.activeReleaseVersion
    )
      throw new Error('Missing scoped pass release or scan code.');
    // Retiring another pass's serial can tombstone this pass's presented scan code.
    const other = await createPassRow(jobCtxOf(kit), {
      orgId: kit.org.id,
      templateId: template,
      templateVersion: before.activeReleaseVersion,
      releaseId: before.activeReleaseId,
      releaseGeneration: before.activeReleaseGeneration,
      input: { memberName: 'Other Member' },
      holderEmail: null,
      serial: pass.scanCode,
      source: 'manual',
      mode: 'live',
      actor: { type: 'system', id: null },
      execution: { kind: 'system' },
    });
    const scanner = await getScanner(kit.env.DB, fixture.source.id);
    if (!scanner) throw new Error('Missing source scanner.');
    const actor = await proofedScanActor(
      kit.ctx,
      withRole(
        scannerActor(kit.ctx, scanner, 'live', 'cookie', {
          event: null,
          templateIds: [template],
        }),
        null,
      ),
    );
    const input = await resolveOutcome(kit.ctx, actor, {
      input: codeOf(pass),
      clientTs: kit.clock.now(),
      idempotencyKey: key(),
    });
    expect(input.outcome.kind).toBe('ready');
    if (!input.evaluatedSnapshot?.credentialTombstoneRefs.length || !input.credentialContext)
      throw new Error('Missing input tombstone refs.');
    publishScan(
      kit.ctx,
      actor,
      input.outcome,
      input.evaluatedSnapshot,
      input.credentialContext,
      'camera',
    );
    await kit.settle();
    const qRow = (await hub().snapshot(fixture.monitor.attachment)).rows.find(
      (entry) => entry.scannerId === fixture.source.id && entry.id !== fixture.event.id,
    );
    if (!qRow?.photoUrl) throw new Error('Missing input-authorized photo.');
    const explicit = await resolveOutcome(kit.ctx, actor, {
      input: { passId: pass.id, method: 'manual' },
      clientTs: kit.clock.now(),
      idempotencyKey: key(),
    });
    expect(explicit.outcome.kind).toBe('ready');
    expect(explicit.evaluatedSnapshot?.credentialTombstoneRefs).toEqual([]);
    publishScan(
      kit.ctx,
      actor,
      explicit.outcome,
      explicit.evaluatedSnapshot,
      explicit.credentialContext,
      'manual',
    );
    await kit.settle();
    const explicitRow = (await hub().snapshot(fixture.monitor.attachment)).rows.find(
      (entry) =>
        entry.scannerId === fixture.source.id &&
        entry.id !== fixture.event.id &&
        entry.id !== qRow.id,
    );
    if (!explicitRow?.photoUrl) throw new Error('Missing pass-id-authorized photo.');
    const qPath = qRow.photoUrl.replace('/api/v1/scan', '');
    const explicitPath = explicitRow.photoUrl.replace('/api/v1/scan', '');
    expect((await kit.get(fixture.monitor.headers, qPath)).status).toBe(200);
    expect((await kit.get(fixture.monitor.headers, explicitPath)).status).toBe(200);
    const sealed = await hub().sourceProof(qRow.id);
    if (!sealed) throw new Error('Missing input source proof.');
    const proof = await openLiveSourceProof(kit.env, sealed);
    const refs = proof?.passSnapshot?.credentialTombstoneRefs;
    if (!refs?.length) throw new Error('Missing sealed input provenance.');
    const explicitSealed = await hub().sourceProof(explicitRow.id);
    if (!explicitSealed) throw new Error('Missing pass-id source proof.');
    expect(
      (await openLiveSourceProof(kit.env, explicitSealed))?.passSnapshot?.credentialTombstoneRefs,
    ).toEqual([]);
    expect(JSON.stringify(proof)).not.toContain(pass.scanCode);
    expect(refs).toEqual(input.evaluatedSnapshot.credentialTombstoneRefs);
    expect(proof?.credentialContext).toEqual(input.credentialContext);
    for (const ref of [...refs, ...proof!.credentialContext.otherModeCredentialTombstoneRefs]) {
      expect(ref).toMatch(/^[a-f0-9]{64}$/);
      expect(JSON.stringify(qRow)).not.toContain(ref);
      expect(qRow.photoUrl).not.toContain(ref);
    }
    expect(JSON.stringify(qRow)).not.toContain(pass.scanCode);
    expect(qRow.photoUrl).not.toContain(pass.scanCode);
    const stored = await memberPhoto(kit.env.DB, kit.org.id, pass.id);
    if (!stored) throw new Error('Missing stored photo.');
    const originalGet = kit.env.BUCKET.get.bind(kit.env.BUCKET);
    const gate: { finish?: () => Promise<void> } = {};
    let opened = false;
    let cancelled = 0;
    const spy = vi.spyOn(kit.env.BUCKET, 'get').mockImplementation(async (objectKey, options) => {
      const object = await originalGet(objectKey, options);
      if (objectKey !== stored.r2_key || !object || gate.finish) return object;
      opened = true;
      gate.finish = await beginCredentialTransfer(other.id);
      return observeCancellation(object, () => {
        cancelled++;
      });
    });
    try {
      expect((await kit.get(fixture.monitor.headers, qPath)).status).toBe(404);
      expect(opened).toBe(true);
      expect(cancelled).toBe(1);
      const current = await candidateById(kit.env.DB, kit.org.id, pass.id);
      if (!current) throw new Error('Missing unchanged selected pass.');
      expect(current.pass.version).toBe(before.pass.version);
      expect(current.pass.credentialGeneration).toBe(before.pass.credentialGeneration);
      const rows = (await hub().snapshot(fixture.monitor.attachment)).rows;
      expect(rows.find((entry) => entry.id === qRow.id)).toMatchObject({
        passId: null,
        holder: null,
        photoUrl: null,
      });
      expect(rows.find((entry) => entry.id === explicitRow.id)).toMatchObject({ passId: pass.id });
      expect((await kit.get(fixture.monitor.headers, explicitPath)).status).toBe(200);
    } finally {
      spy.mockRestore();
      if (gate.finish) await gate.finish();
    }
    expect((await kit.get(fixture.monitor.headers, qPath)).status).toBe(404);
    expect((await kit.get(fixture.monitor.headers, explicitPath)).status).toBe(200);
  });
});
