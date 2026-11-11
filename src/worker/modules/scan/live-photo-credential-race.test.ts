import { describe, expect, it, vi } from 'vitest';
import { jobCtxOf } from '../delivery/delivery-test-fixtures.ts';
import { createPassRow } from '../passes/create.ts';
import { memberPhoto } from '../passes/repo-member-photo.ts';
import { scannerActor, withRole } from './actor.ts';
import { publishScan } from './live.ts';
import { openLiveSourceProof } from './live-provenance.ts';
import { getScanner } from './repo-device.ts';
import { photoAcquisition, traceLiveD1 } from './repo-live-photo-d1-trace-test-fixtures.ts';
import { candidateById } from './repo-lookup.ts';
import { readScannerScope } from './repo-scope.ts';
import { resolveOutcome } from './resolve-outcome.ts';
import {
  beginCredentialTransfer,
  hub,
  kit,
  photoFixture,
  template,
} from './scan-hub-test-fixtures.ts';
import { bindScanningSession } from './scanning-workspace.ts';
import { codeOf, key, proofedScanActor } from './test-kit.ts';

describe('live photo submitted-credential acquisition', () => {
  it('keeps the originally published input refs when a competing credential retires before R2 opens', async () => {
    const fixture = await photoFixture();
    const candidate = await candidateById(kit.env.DB, kit.org.id, fixture.pass.id);
    const scanner = await getScanner(kit.env.DB, fixture.source.id);
    if (
      !candidate?.activeReleaseId ||
      candidate.activeReleaseGeneration === null ||
      !candidate.activeReleaseVersion ||
      !scanner ||
      !fixture.pass.scanCode
    )
      throw new Error('Missing released credential fixture.');
    const competing = await createPassRow(jobCtxOf(kit), {
      orgId: kit.org.id,
      templateId: template,
      templateVersion: candidate.activeReleaseVersion,
      releaseId: candidate.activeReleaseId,
      releaseGeneration: candidate.activeReleaseGeneration,
      input: { memberName: 'Independent credential holder' },
      holderEmail: null,
      serial: fixture.pass.scanCode,
      source: 'manual',
      mode: 'live',
      actor: { type: 'system', id: null },
      execution: { kind: 'system' },
    });
    const scope = await readScannerScope(kit.env.DB, scanner, scanner.staffId);
    const raw = scannerActor(kit.ctx, scanner, 'live', 'cookie', scope);
    await bindScanningSession(kit.ctx, raw);
    const source = await proofedScanActor(kit.ctx, withRole(raw, null));
    const evaluation = await resolveOutcome(kit.ctx, source, {
      input: codeOf(fixture.pass),
      clientTs: kit.clock.now(),
      idempotencyKey: key(),
    });
    if (
      !evaluation.evaluatedSnapshot ||
      !evaluation.credentialContext?.credentialTombstoneRefs.length
    )
      throw new Error('Missing presented-credential evidence.');
    publishScan(
      kit.ctx,
      source,
      evaluation.outcome,
      evaluation.evaluatedSnapshot,
      evaluation.credentialContext,
      'camera',
    );
    await kit.settle();
    const projection = (await hub().snapshot(fixture.monitor.attachment)).rows.find(
      (entry) => entry.scannerId === fixture.source.id && entry.id !== fixture.event.id,
    );
    if (!projection?.photoUrl) throw new Error('Missing credential-authorized live photo.');
    const sealed = await hub().sourceProof(projection.id);
    const proof = sealed ? await openLiveSourceProof(kit.env, sealed) : null;
    expect(proof?.credentialContext).toEqual(evaluation.credentialContext);
    expect(proof?.passSnapshot?.credentialTombstoneRefs).toEqual(
      evaluation.credentialContext.credentialTombstoneRefs,
    );
    const stored = await memberPhoto(kit.env.DB, kit.org.id, fixture.pass.id);
    if (!stored) throw new Error('Missing original photo.');
    const originalDb = kit.env.DB;
    const originalGet = kit.env.BUCKET.get.bind(kit.env.BUCKET);
    let opened = false;
    let raced = false;
    const transfer: { finish?: () => Promise<void> } = {};
    const trace = traceLiveD1(originalDb, async (statements, results) => {
      if (!raced && photoAcquisition(statements)) {
        raced = true;
        transfer.finish = await beginCredentialTransfer(competing.id);
      }
      return results;
    });
    const spy = vi.spyOn(kit.env.BUCKET, 'get').mockImplementation(async (objectKey, options) => {
      if (objectKey === stored.r2_key) opened = true;
      return originalGet(objectKey, options);
    });
    Object.assign(kit.env, { DB: trace.db });
    try {
      const response = await kit.get(
        fixture.monitor.headers,
        projection.photoUrl.replace('/api/v1/scan', ''),
      );
      expect(raced).toBe(true);
      expect(response.status).toBe(404);
      expect(await response.json()).toMatchObject({ code: 'ASSET_NOT_FOUND' });
      expect(opened).toBe(false);
    } finally {
      Object.assign(kit.env, { DB: originalDb });
      spy.mockRestore();
      if (transfer.finish) await transfer.finish();
    }
    const after = await candidateById(kit.env.DB, kit.org.id, fixture.pass.id);
    expect(after?.pass.credentialGeneration).toBe(candidate.pass.credentialGeneration);
    expect(after?.pass.imageGeneration).toBe(candidate.pass.imageGeneration);
    expect(
      (await kit.get(fixture.monitor.headers, projection.photoUrl.replace('/api/v1/scan', '')))
        .status,
    ).toBe(404);
  });
});
