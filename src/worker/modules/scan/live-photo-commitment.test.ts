import { describe, expect, it, vi } from 'vitest';
import { run } from '../../platform/db.ts';
import { memberPhoto } from '../passes/repo-member-photo.ts';
import { livePassCommitment, livePassCommitmentValid } from './live-pass-commitment.ts';
import { livePassSnapshot, openLiveSourceProof } from './live-provenance.ts';
import { type Candidate, candidateById } from './repo-lookup.ts';
import { hub, kit, observeCancellation, photoFixture } from './scan-hub-test-fixtures.ts';

async function photoCandidate(passId: string): Promise<Candidate> {
  const candidate = await candidateById(kit.env.DB, kit.org.id, passId);
  if (!candidate?.assetPhoto || !candidate.templateSnapshot)
    throw new Error('Missing photo authority fixture.');
  return candidate;
}

async function replaceAndRestorePhotoVersion(passId: string, version: string) {
  await run(kit.env.DB, 'UPDATE member_photos SET version = ? WHERE pass_id = ?', [
    `temporary-${version}`,
    passId,
  ]);
  await run(kit.env.DB, 'UPDATE member_photos SET version = ? WHERE pass_id = ?', [
    version,
    passId,
  ]);
}

describe('live photo authority commitment', () => {
  it('binds each exact photo field and distinguishes no photo from a present photo', async () => {
    const fixture = await photoFixture();
    const candidate = await photoCandidate(fixture.pass.id);
    const photo = candidate.assetPhoto!;
    const commitment = await livePassCommitment(kit.env, candidate);
    expect(commitment).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(await livePassCommitmentValid(kit.env, candidate, commitment)).toBe(true);

    const changed = [
      { ...photo, key: `${photo.key}-different` },
      { ...photo, version: `${photo.version}-different` },
      { ...photo, sha1: photo.sha1 === 'f'.repeat(40) ? 'e'.repeat(40) : 'f'.repeat(40) },
      { ...photo, includeInPass: photo.includeInPass === 0 ? 1 : 0 },
    ];
    for (const assetPhoto of changed) {
      const current = { ...candidate, assetPhoto };
      expect(current.pass.imageGeneration).toBe(candidate.pass.imageGeneration);
      expect(await livePassCommitmentValid(kit.env, current, commitment)).toBe(false);
    }
    const absent = { ...candidate, assetPhoto: null };
    const absentCommitment = await livePassCommitment(kit.env, absent);
    expect(absentCommitment).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(await livePassCommitmentValid(kit.env, absent, absentCommitment)).toBe(true);
    expect(await livePassCommitmentValid(kit.env, absent, commitment)).toBe(false);
    expect(await livePassCommitmentValid(kit.env, candidate, absentCommitment)).toBe(false);
  });

  it('rejects missing and malformed photo lineage rather than treating it as absent', async () => {
    const fixture = await photoFixture();
    const candidate = await photoCandidate(fixture.pass.id);
    const photo = candidate.assetPhoto!;
    const commitment = await livePassCommitment(kit.env, candidate);
    const getter = { ...photo };
    Object.defineProperty(getter, 'key', { enumerable: true, get: () => photo.key });
    const malformed: unknown[] = [
      undefined,
      false,
      [],
      {},
      { ...photo, key: '' },
      { ...photo, version: '' },
      { ...photo, sha1: 'f'.repeat(39) },
      { ...photo, sha1: 'F'.repeat(40) },
      { ...photo, includeInPass: -1 },
      { ...photo, includeInPass: true },
      { ...photo, includeInPass: null },
      getter,
    ];
    for (const assetPhoto of malformed) {
      const invalid = { ...candidate, assetPhoto } as Candidate;
      expect(await livePassCommitment(kit.env, invalid)).toBeNull();
      expect(await livePassCommitmentValid(kit.env, invalid, commitment)).toBe(false);
    }
    const missing: Partial<Candidate> = { ...candidate };
    delete missing.assetPhoto;
    expect(await livePassCommitment(kit.env, missing as Candidate)).toBeNull();
    expect(await livePassCommitmentValid(kit.env, missing as Candidate, commitment)).toBe(false);
    const getterSnapshot = { ...candidate };
    Object.defineProperty(getterSnapshot, 'assetPhoto', { get: () => photo });
    expect(await livePassCommitment(kit.env, getterSnapshot)).toBeNull();
    expect(await livePassCommitmentValid(kit.env, getterSnapshot, commitment)).toBe(false);
    for (const imageGeneration of [-1, 0.5, Number.NaN, Number.MAX_SAFE_INTEGER + 1]) {
      const invalid = { ...candidate, pass: { ...candidate.pass, imageGeneration } };
      expect(await livePassCommitment(kit.env, invalid)).toBeNull();
      expect(await livePassCommitmentValid(kit.env, invalid, commitment)).toBe(false);
    }
  });

  it('binds every live output source field, including absent versus present optional values', async () => {
    const fixture = await photoFixture();
    const candidate = await photoCandidate(fixture.pass.id);
    const pass = candidate.pass;
    const commitment = await livePassCommitment(kit.env, candidate);
    expect(await livePassCommitmentValid(kit.env, candidate, commitment)).toBe(true);
    const changed = (value: string | null) =>
      value === 'changed-value' ? 'other-value' : 'changed-value';
    const changes: Partial<Candidate['pass']>[] = [
      { externalId: changed(pass.externalId) },
      { displayTitle: changed(pass.displayTitle) },
      { displaySubtitle: changed(pass.displaySubtitle) },
      { createdAt: pass.createdAt + 1 },
      { modifiedAt: pass.modifiedAt + 1 },
      { modifiedCollision: !pass.modifiedCollision },
      { objectSize: (pass.objectSize ?? 0) + 1 },
      { syncErrorCode: changed(pass.syncErrorCode) },
      { refreshRequestedAt: (pass.refreshRequestedAt ?? 0) + 1 },
      { lastRefreshedAt: (pass.lastRefreshedAt ?? 0) + 1 },
      { contentHash: changed(pass.contentHash) },
      {
        fieldSources: {
          ...pass.fieldSources,
          liveTest: pass.fieldSources.liveTest === 'manual' ? 'connection' : 'manual',
        },
      },
    ];
    for (const fields of changes)
      expect(
        await livePassCommitmentValid(
          kit.env,
          { ...candidate, pass: { ...pass, ...fields } },
          commitment,
        ),
      ).toBe(false);
    const alternatives: Candidate[] = [
      {
        ...candidate,
        lookupHash: candidate.lookupHash === 'a'.repeat(64) ? 'b'.repeat(64) : 'a'.repeat(64),
      },
      {
        ...candidate,
        checkInRules: { mode: candidate.checkInRules?.mode === 'daily' ? 'single' : 'daily' },
      },
      { ...candidate, hasPhoto: !candidate.hasPhoto },
      { ...candidate, passPersonalizationSnapshot: `${candidate.passPersonalizationSnapshot} ` },
      { ...candidate, fieldSourcesSnapshot: `${candidate.fieldSourcesSnapshot} ` },
      { ...candidate, passJson: `${candidate.passJson ?? ''} ` },
      { ...candidate, passJsonSnapshot: `${candidate.passJsonSnapshot} ` },
    ];
    for (const changedCandidate of alternatives)
      expect(await livePassCommitmentValid(kit.env, changedCandidate, commitment)).toBe(false);
    const noLookup = { ...candidate, lookupHash: undefined } as unknown as Candidate;
    const nullLookup = { ...candidate, lookupHash: null };
    expect(
      await livePassCommitmentValid(
        kit.env,
        nullLookup,
        await livePassCommitment(kit.env, noLookup),
      ),
    ).toBe(false);
    const noRules = { ...candidate, checkInRules: undefined };
    expect(
      await livePassCommitmentValid(
        kit.env,
        { ...candidate, checkInRules: {} },
        await livePassCommitment(kit.env, noRules),
      ),
    ).toBe(false);
    const malformed = { ...candidate, checkInRules: null } as unknown as Candidate;
    expect(await livePassCommitment(kit.env, malformed)).toBeNull();
    expect(await livePassCommitmentValid(kit.env, malformed, commitment)).toBe(false);
  });

  it('captures output metadata before yielding without retaining it in the proof', async () => {
    const fixture = await photoFixture();
    const candidate = await photoCandidate(fixture.pass.id);
    candidate.pass.displayTitle = 'private-live-title-marker';
    const pending = livePassSnapshot(kit.env, candidate);
    candidate.pass.displayTitle = 'changed-live-title-marker';
    const snapshot = await pending;
    expect(JSON.stringify(structuredClone(snapshot))).not.toContain('private-live-title-marker');
    expect(await livePassCommitmentValid(kit.env, candidate, snapshot.passCommitment)).toBe(false);
    candidate.pass.displayTitle = 'private-live-title-marker';
    expect(await livePassCommitmentValid(kit.env, candidate, snapshot.passCommitment)).toBe(true);
  });

  it('captures the photo, generation, original ordered credential context, template and KEK before yielding', async () => {
    const fixture = await photoFixture();
    const candidate = await photoCandidate(fixture.pass.id);
    const photo = candidate.assetPhoto!;
    const template = candidate.templateSnapshot!;
    const originalPhoto = { ...photo };
    const originalGeneration = candidate.pass.imageGeneration;
    const originalTemplate = template.raw;
    const sameMode = ['a'.repeat(64), 'c'.repeat(64)];
    const otherMode = ['b'.repeat(64)];
    const originalSameMode = [...sameMode];
    const originalOtherMode = [...otherMode];
    candidate.credentialTombstoneRefs = sameMode;
    candidate.otherModeCredentialTombstoneRefs = otherMode;
    const originalKeyset = candidate.credentialKeysetCommitment;
    const keyA = btoa(String.fromCharCode(...new Uint8Array(32).fill(1)));
    const keyB = btoa(String.fromCharCode(...new Uint8Array(32).fill(2)));
    const env = { KEK_V1: keyA };
    Object.defineProperty(env, 'SESSION_CSRF_SECRET', {
      enumerable: true,
      get: () => {
        throw new Error('Unrelated secret was read.');
      },
    });

    const pending = livePassSnapshot(env, candidate);
    photo.key = 'changed-key';
    photo.version = 'changed-version';
    photo.sha1 = originalPhoto.sha1 === 'f'.repeat(40) ? 'e'.repeat(40) : 'f'.repeat(40);
    photo.includeInPass = originalPhoto.includeInPass === 0 ? 1 : 0;
    candidate.pass.imageGeneration++;
    sameMode[0] = 'd'.repeat(64);
    otherMode[0] = 'f'.repeat(64);
    candidate.credentialKeysetCommitment = 'e'.repeat(64);
    template.raw += ' ';
    env.KEK_V1 = keyB;
    const snapshot = await pending;
    expect(snapshot.imageGeneration).toBe(originalGeneration);
    expect(snapshot.credentialTombstoneRefs).toEqual(originalSameMode);
    expect(snapshot.otherModeCredentialTombstoneRefs).toEqual(originalOtherMode);
    expect(snapshot.credentialKeysetCommitment).toBe(originalKeyset);
    expect(
      await livePassCommitmentValid({ KEK_V1: keyA }, candidate, snapshot.passCommitment),
    ).toBe(false);

    Object.assign(photo, originalPhoto);
    candidate.pass.imageGeneration = originalGeneration;
    sameMode.splice(0, sameMode.length, ...originalSameMode);
    otherMode.splice(0, otherMode.length, ...originalOtherMode);
    candidate.credentialTombstoneRefs = sameMode;
    candidate.otherModeCredentialTombstoneRefs = otherMode;
    candidate.credentialKeysetCommitment = originalKeyset;
    template.raw = originalTemplate;
    expect(
      await livePassCommitmentValid({ KEK_V1: keyA }, candidate, snapshot.passCommitment),
    ).toBe(true);
    expect(await livePassCommitmentValid(env, candidate, snapshot.passCommitment)).toBe(false);
    candidate.credentialTombstoneRefs = [...sameMode].reverse();
    expect(
      await livePassCommitmentValid({ KEK_V1: keyA }, candidate, snapshot.passCommitment),
    ).toBe(false);
    candidate.credentialTombstoneRefs = sameMode;
    candidate.otherModeCredentialTombstoneRefs = sameMode;
    expect(
      await livePassCommitmentValid({ KEK_V1: keyA }, candidate, snapshot.passCommitment),
    ).toBe(false);
    candidate.otherModeCredentialTombstoneRefs = otherMode;
    candidate.credentialKeysetCommitment = 'e'.repeat(64);
    expect(
      await livePassCommitmentValid({ KEK_V1: keyA }, candidate, snapshot.passCommitment),
    ).toBe(false);
    candidate.credentialKeysetCommitment = originalKeyset;

    env.KEK_V1 = keyA;
    const validating = livePassCommitmentValid(env, candidate, snapshot.passCommitment);
    candidate.assetPhoto = null;
    env.KEK_V1 = keyB;
    expect(await validating).toBe(true);
    expect(
      await livePassCommitmentValid({ KEK_V1: keyA }, candidate, snapshot.passCommitment),
    ).toBe(false);

    candidate.assetPhoto = photo;
    const wallet = candidate.passJsonSnapshot;
    Object.defineProperty(candidate, 'passJsonSnapshot', {
      enumerable: true,
      get: () => {
        env.KEK_V1 = keyB;
        return wallet;
      },
    });
    env.KEK_V1 = keyA;
    const sideEffectCommitment = await livePassCommitment(env, candidate);
    expect(env.KEK_V1).toBe(keyB);
    expect(await livePassCommitmentValid({ KEK_V1: keyA }, candidate, sideEffectCommitment)).toBe(
      true,
    );
    env.KEK_V1 = keyA;
    expect(await livePassCommitmentValid(env, candidate, sideEffectCommitment)).toBe(true);
    expect(env.KEK_V1).toBe(keyB);
  });

  it('keeps photo lineage private and never revives a published proof after photo ABA', async () => {
    const fixture = await photoFixture();
    const before = await photoCandidate(fixture.pass.id);
    const photo = before.assetPhoto!;
    const sealed = await hub().sourceProof(fixture.event.id);
    if (!sealed) throw new Error('Missing live proof.');
    const proof = await openLiveSourceProof(kit.env, sealed);
    if (!proof?.passSnapshot) throw new Error('Missing live pass proof.');
    expect(await livePassCommitmentValid(kit.env, before, proof.passSnapshot.passCommitment)).toBe(
      true,
    );
    const rows = await hub().snapshot(fixture.monitor.attachment);
    const publicRow = rows.rows.find((entry) => entry.id === fixture.event.id);
    if (!publicRow) throw new Error('Missing live row.');
    const privateValues = [
      photo.key,
      photo.version,
      photo.sha1,
      before.pass.authToken,
      before.pass.downloadToken,
      before.pass.scanCode,
      fixture.source.token,
      fixture.source.headers['x-csrf-token'],
      fixture.monitor.token,
      fixture.monitor.headers['x-csrf-token'],
    ].filter((value): value is string => !!value);
    for (const value of privateValues) {
      expect(JSON.stringify(proof)).not.toContain(value);
      expect(JSON.stringify(publicRow)).not.toContain(value);
      expect(sealed).not.toContain(value);
    }
    expect(JSON.stringify(proof.passSnapshot)).not.toMatch(/assetPhoto|includeInPass|sha1/);
    expect((await kit.get(fixture.monitor.headers, fixture.path)).status).toBe(200);
    await replaceAndRestorePhotoVersion(fixture.pass.id, photo.version);
    const after = await photoCandidate(fixture.pass.id);
    expect(after.assetPhoto).toEqual(photo);
    expect(after.pass.imageGeneration).toBe(before.pass.imageGeneration + 2);
    expect(await livePassCommitmentValid(kit.env, after, proof.passSnapshot.passCommitment)).toBe(
      false,
    );
    let opened = false;
    const originalGet = kit.env.BUCKET.get.bind(kit.env.BUCKET);
    const spy = vi.spyOn(kit.env.BUCKET, 'get').mockImplementation(async (key, options) => {
      if (key === photo.key) opened = true;
      return originalGet(key, options);
    });
    try {
      expect((await kit.get(fixture.monitor.headers, fixture.path)).status).toBe(404);
      expect(opened).toBe(false);
    } finally {
      spy.mockRestore();
    }
    const stale = (await hub().snapshot(fixture.monitor.attachment)).rows.find(
      (entry) => entry.id === fixture.event.id,
    );
    expect(stale).toMatchObject({ passId: null, holder: null, photoUrl: null });
  });

  it('cancels an open stream and rejects later reads when an original output field changes', async () => {
    const fixture = await photoFixture();
    const before = await photoCandidate(fixture.pass.id);
    const sealed = await hub().sourceProof(fixture.event.id);
    const proof = sealed ? await openLiveSourceProof(kit.env, sealed) : null;
    if (!proof?.passSnapshot) throw new Error('Missing live source proof.');
    const replacement =
      before.pass.displayTitle === 'changed-title' ? 'other-title' : 'changed-title';
    const originalGet = kit.env.BUCKET.get.bind(kit.env.BUCKET);
    let opened = 0;
    let cancelled = 0;
    const spy = vi.spyOn(kit.env.BUCKET, 'get').mockImplementation(async (key, options) => {
      const object = await originalGet(key, options);
      if (key !== before.assetPhoto!.key || !object) return object;
      opened++;
      await run(kit.env.DB, 'UPDATE passes SET display_title = ? WHERE id = ?', [
        replacement,
        fixture.pass.id,
      ]);
      return observeCancellation(object, () => {
        cancelled++;
      });
    });
    try {
      expect((await kit.get(fixture.monitor.headers, fixture.path)).status).toBe(404);
      expect(opened).toBe(1);
      expect(cancelled).toBe(1);
      expect((await kit.get(fixture.monitor.headers, fixture.path)).status).toBe(404);
      expect(opened).toBe(1);
    } finally {
      spy.mockRestore();
    }
    const after = await photoCandidate(fixture.pass.id);
    expect(after.pass.displayTitle).toBe(replacement);
    expect(after.pass.version).toBe(before.pass.version);
    expect(after.pass.revision).toBe(before.pass.revision);
    expect(after.pass.imageGeneration).toBe(before.pass.imageGeneration);
    expect(await livePassCommitmentValid(kit.env, after, proof.passSnapshot.passCommitment)).toBe(
      false,
    );
    const stale = (await hub().snapshot(fixture.monitor.attachment)).rows.find(
      (entry) => entry.id === fixture.event.id,
    );
    expect(stale).toMatchObject({ passId: null, holder: null, photoUrl: null });
  });

  it('cancels an opened stream if the original photo goes A→B→A during the read', async () => {
    const fixture = await photoFixture();
    const before = await photoCandidate(fixture.pass.id);
    const stored = await memberPhoto(kit.env.DB, kit.org.id, fixture.pass.id);
    if (!stored) throw new Error('Missing photo row.');
    const originalGet = kit.env.BUCKET.get.bind(kit.env.BUCKET);
    let opened = false;
    let cancelled = 0;
    const spy = vi.spyOn(kit.env.BUCKET, 'get').mockImplementation(async (key, options) => {
      const object = await originalGet(key, options);
      if (key !== stored.r2_key || !object) return object;
      opened = true;
      await replaceAndRestorePhotoVersion(fixture.pass.id, stored.version);
      return observeCancellation(object, () => {
        cancelled++;
      });
    });
    let response: Response;
    try {
      response = await kit.get(fixture.monitor.headers, fixture.path);
    } finally {
      spy.mockRestore();
    }
    expect(opened).toBe(true);
    expect(cancelled).toBe(1);
    expect(response.status).toBe(404);
    const after = await photoCandidate(fixture.pass.id);
    expect(after.assetPhoto).toEqual(before.assetPhoto);
    expect(after.pass.imageGeneration).toBe(before.pass.imageGeneration + 2);
    expect((await kit.get(fixture.monitor.headers, fixture.path)).status).toBe(404);
  });
});
