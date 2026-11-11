import { describe, expect, it } from 'vitest';
import { makePass, materializeTemplateAssets } from '../../../../test/helpers/index.ts';
import { first, run } from '../../platform/db.ts';
import { approveAppleRelease } from '../passes/apple-release-test-fixtures.ts';
import { putMemberPhoto } from '../passes/member-photo.ts';
import { ICON_PNG } from '../passes/pass-test-fixtures.ts';
import { claimRemoval, releaseRemoval } from '../passes/repo-remove.ts';
import { makePng } from '../templates/package/fixtures.ts';
import { effectiveReleaseIdSql } from '../templates/repo-release-heads.ts';
import { noScopedReleaseSql } from '../templates/repo-releases.ts';
import { scannerActor, withRole } from './actor.ts';
import { publishScan } from './live.ts';
import { liveRecipient } from './live-auth.ts';
import { livePassCommitmentValid } from './live-pass-commitment.ts';
import { livePassSnapshot, openLiveSourceProof, sealLiveSourceProof } from './live-provenance.ts';
import { liveRowFor } from './live-render.ts';
import { getScanner } from './repo-device.ts';
import { candidateById } from './repo-lookup.ts';
import { setSetupWatchStmt } from './repo-setups-test-support.ts';
import { resolveOutcome } from './resolve-outcome.ts';
import { hub, kit, photoFixture, proven, publish, row, screen } from './scan-hub-test-fixtures.ts';
import { key, proofedScanActor } from './test-kit.ts';

describe('live authority revocation', () => {
  it('does not revive a retained grant after a same-clock removal claim is rolled back', async () => {
    const fixture = await photoFixture();
    const before = await candidateById(kit.env.DB, kit.org.id, fixture.pass.id);
    const sealed = await hub().sourceProof(fixture.event.id);
    if (!before || !sealed) throw new Error('Missing lifecycle fixture.');
    expect((await openLiveSourceProof(kit.env, sealed))?.passSnapshot?.lifecycleGeneration).toBe(
      before.pass.lifecycleGeneration,
    );
    expect((await kit.get(fixture.monitor.headers, fixture.path)).status).toBe(200);
    const now = kit.clock.now();
    const state = { at: now, message: null, priorStatus: before.pass.status };
    const generation = await claimRemoval(kit.env.DB, fixture.pass.id, state, {
      pass: before.pass,
      generation: before.pass.lifecycleGeneration,
      now,
    });
    if (generation === null) throw new Error('Removal claim failed.');
    try {
      expect((await kit.get(fixture.monitor.headers, fixture.path)).status).toBe(404);
      const removed = (await hub().snapshot(fixture.monitor.attachment)).rows.find(
        (entry) => entry.id === fixture.event.id,
      );
      expect(removed).toMatchObject({ passId: null, holder: null, photoUrl: null });
    } finally {
      await releaseRemoval(kit.env.DB, fixture.pass.id, { pass: before.pass, state, generation });
    }
    const restored = await candidateById(kit.env.DB, kit.org.id, fixture.pass.id);
    if (!restored) throw new Error('Missing restored pass.');
    expect(kit.clock.now()).toBe(now);
    expect(restored.pass.removedAt).toBeNull();
    expect(restored.pass.version).toBe(before.pass.version);
    expect(restored.pass.lifecycleGeneration).toBeGreaterThan(generation);
    expect((await kit.get(fixture.monitor.headers, fixture.path)).status).toBe(404);
    const stale = (await hub().snapshot(fixture.monitor.attachment)).rows.find(
      (entry) => entry.id === fixture.event.id,
    );
    expect(stale).toMatchObject({ passId: null, holder: null, photoUrl: null });
    const event = row(fixture.source.id, { passId: fixture.pass.id });
    await publish(event);
    const fresh = (await hub().snapshot(fixture.monitor.attachment)).rows.find(
      (entry) => entry.id === event.id,
    );
    if (!fresh?.photoUrl) throw new Error('Missing fresh lifecycle-authorized photo.');
    expect(
      (await kit.get(fixture.monitor.headers, fresh.photoUrl.replace('/api/v1/scan', ''))).status,
    ).toBe(200);
  });

  it('bounds and validates the original Wallet authority before computing its commitment', async () => {
    const fixture = await photoFixture();
    const candidate = await candidateById(kit.env.DB, kit.org.id, fixture.pass.id);
    if (!candidate?.passJsonSnapshot) throw new Error('Missing Wallet snapshot.');
    const wallet = JSON.parse(candidate.passJsonSnapshot) as Record<string, unknown>;
    let nested: unknown = 'leaf';
    for (let depth = 0; depth < 100; depth++) nested = { nested };
    const invalid = [
      null,
      '{',
      JSON.stringify({ ...wallet, serialNumber: 'different-serial' }),
      JSON.stringify({ ...wallet, serialNumber: undefined }),
      JSON.stringify({ ...wallet, passTypeIdentifier: 'pass.invalid' }),
      JSON.stringify({ ...wallet, teamIdentifier: 'OTHERTEAM' }),
      JSON.stringify({ ...wallet, oversized: 'x'.repeat(4 * 1024 * 1024) }),
      JSON.stringify({ ...wallet, oversized: 'x'.repeat(2_000_001) }),
      JSON.stringify({ ...wallet, oversized: 'é'.repeat(1_000_001) }),
    ];
    for (const passJsonSnapshot of invalid) {
      const damaged = { ...candidate, passJsonSnapshot };
      const snapshot = await livePassSnapshot(kit.env, damaged);
      expect(snapshot.passCommitment).toBeNull();
      expect(await livePassCommitmentValid(kit.env, damaged, snapshot.passCommitment)).toBe(false);
    }
    for (const passJsonSnapshot of [
      JSON.stringify({ ...wallet, nested }),
      JSON.stringify({ ...wallet, manyNodes: Array.from({ length: 100_001 }, () => 0) }),
    ]) {
      const valid = { ...candidate, passJsonSnapshot };
      const snapshot = await livePassSnapshot(kit.env, valid);
      expect(snapshot.passCommitment).toBeTruthy();
      expect(await livePassCommitmentValid(kit.env, valid, snapshot.passCommitment)).toBe(true);
    }
    for (const damaged of [
      { ...candidate, identityPassTypeIdentifier: null },
      { ...candidate, identityTeamIdentifier: null },
      { ...candidate, walletVersion: null },
      { ...candidate, walletVersion: 0 },
      { ...candidate, walletVersion: candidate.pass.version + 1 },
      { ...candidate, transferPending: true },
      { ...candidate, pass: { ...candidate.pass, credentialGeneration: 0 } },
    ]) {
      expect((await livePassSnapshot(kit.env, damaged)).passCommitment).toBeNull();
    }
  });
  it('binds legacy Wallet-row personalization as exact opaque bytes', async () => {
    const fixture = await photoFixture();
    const candidate = await candidateById(kit.env.DB, kit.org.id, fixture.pass.id);
    if (!candidate?.passJsonSnapshot) throw new Error('Missing Wallet snapshot.');
    const values = [null, '', '{', '[]', 'null', '{"memberName":"different"}'];
    const commitments = new Set<string>();
    for (const versionPersonalization of values) {
      const legacy = { ...candidate, versionPersonalization };
      const snapshot = await livePassSnapshot(kit.env, legacy);
      if (!snapshot.passCommitment) throw new Error('Missing legacy pass commitment.');
      expect(await livePassCommitmentValid(kit.env, legacy, snapshot.passCommitment)).toBe(true);
      expect(snapshot).not.toHaveProperty('versionPersonalization');
      commitments.add(snapshot.passCommitment);
    }
    expect(commitments.size).toBe(values.length);
    const versions = [null, '', 'legacy-wallet-version'];
    const versionCommitments = new Set<string>();
    for (const walletTemplateVersion of versions) {
      const legacy = { ...candidate, walletTemplateVersion };
      const snapshot = await livePassSnapshot(kit.env, legacy);
      if (!snapshot.passCommitment) throw new Error('Missing legacy version commitment.');
      expect(snapshot.walletTemplateVersion).toBe(walletTemplateVersion);
      expect(await livePassCommitmentValid(kit.env, legacy, snapshot.passCommitment)).toBe(true);
      versionCommitments.add(snapshot.passCommitment);
    }
    expect(versionCommitments.size).toBe(versions.length);
  });

  it('captures the commitment inputs before the first asynchronous yield', async () => {
    const fixture = await photoFixture();
    const candidate = await candidateById(kit.env.DB, kit.org.id, fixture.pass.id);
    if (!candidate?.passJsonSnapshot) throw new Error('Missing Wallet snapshot.');
    const original = {
      ...candidate,
      credentialTombstoneRefs: ['a'.repeat(64)],
      otherModeCredentialTombstoneRefs: ['b'.repeat(64)],
    };
    const expected = await livePassSnapshot(kit.env, original);
    expect(expected.passCommitment).toBeTruthy();
    const mutable = structuredClone(original);
    const pending = livePassSnapshot(kit.env, mutable);
    mutable.pass.personalization.memberName = 'Changed after evaluation';
    mutable.pass.serial = 'changed-serial';
    mutable.passJsonSnapshot = '{}';
    mutable.activeReleaseId = 'changed-release';
    mutable.credentialTombstoneRefs[0] = 'c'.repeat(64);
    mutable.otherModeCredentialTombstoneRefs[0] = 'd'.repeat(64);
    expect(await pending).toEqual(expected);
    expect(await livePassCommitmentValid(kit.env, original, expected.passCommitment)).toBe(true);
    expect(
      await livePassCommitmentValid(
        kit.env,
        { ...original, credentialTombstoneRefs: [] },
        expected.passCommitment,
      ),
    ).toBe(false);
    expect(
      await livePassCommitmentValid(
        kit.env,
        { ...original, otherModeCredentialTombstoneRefs: [] },
        expected.passCommitment,
      ),
    ).toBe(false);
    expect(await livePassCommitmentValid(kit.env, mutable, expected.passCommitment)).toBe(false);
  });

  it('does not replace an evaluated display version with a different current projection', async () => {
    const fixture = await photoFixture();
    const recipient = await liveRecipient(kit.ctx, fixture.monitor.attachment);
    const entry = await proven(row(fixture.source.id, { passId: fixture.pass.id }));
    const proof = await openLiveSourceProof(kit.env, entry.sourceProof);
    const candidate = await candidateById(kit.env.DB, kit.org.id, fixture.pass.id);
    if (!recipient || !proof?.passSnapshot || !candidate)
      throw new Error('Missing display lineage fixture.');
    expect(proof.passSnapshot.displayTemplateVersion).toBe(candidate.displayTemplateVersion);
    expect(await liveRowFor(kit.ctx, recipient, entry)).toMatchObject({ passId: fixture.pass.id });
    const substituted = await sealLiveSourceProof(kit.env, {
      ...proof,
      passSnapshot: { ...proof.passSnapshot, displayTemplateVersion: 'different-display-version' },
    });
    const substitutedRow = { ...entry, sourceProof: substituted };
    expect(await liveRowFor(kit.ctx, recipient, substitutedRow)).toMatchObject({
      passId: null,
      holder: null,
      photoUrl: null,
    });
  });

  it('keeps a legacy pass pinned to its issued policy instead of an unapproved draft', async () => {
    const id = await kit.scanTemplate(
      'Legacy pinned policy',
      {
        actions: [{ id: 'check_in', label: 'Check in', kind: 'check_in' }],
      },
      { releaseModes: [] },
    );
    const pinned = await kit.registry.resolve(id);
    const pass = await makePass(kit.fx, {
      orgId: kit.org.id,
      template: pinned,
      personalization: { memberName: 'Legacy Member' },
    });
    const identity = await first<{ pass_type_identifier: string; team_identifier: string }>(
      kit.env.DB,
      `SELECT s.pass_type_identifier, s.team_identifier FROM passes p
       JOIN signing_identities s ON s.id = p.identity_id WHERE p.id = ?`,
      [pass.id],
    );
    if (!identity) throw new Error('Missing legacy signing identity.');
    await run(kit.env.DB, 'UPDATE pass_versions SET pass_json = ? WHERE pass_id = ?', [
      JSON.stringify({
        ...pinned.passJson,
        serialNumber: pass.serial,
        passTypeIdentifier: identity.pass_type_identifier,
        teamIdentifier: identity.team_identifier,
      }),
      pass.id,
    ]);
    await run(kit.env.DB, 'UPDATE passes SET display_title = ? WHERE id = ?', [
      'Legacy Member',
      pass.id,
    ]);
    const png = btoa(String.fromCharCode(...makePng(270, 270)));
    await putMemberPhoto(
      kit.ctx,
      { type: 'system', id: null },
      pass.id,
      { png, includeInPass: false },
      null,
    );
    const manifest = structuredClone(pinned.manifest);
    manifest.inputs.properties!.memberName = { type: 'string', 'x-scan': 'hidden' };
    manifest.scan!.display = { v: 1, header: {}, photo: { minRole: 'desk' } };
    const draft = kit.registry.add({
      id,
      orgId: pinned.orgId,
      version: 'unapproved-draft',
      manifest,
      passJson: pinned.passJson,
      assets: { 'icon.png': ICON_PNG },
    });
    const draftAssets = await materializeTemplateAssets(kit.fx, draft, kit.registry);
    await run(
      kit.env.DB,
      `INSERT INTO template_versions
      (template_id, version, manifest, pass_json, assets, created_at, build_key)
      VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [
        id,
        draft.version,
        JSON.stringify(manifest),
        JSON.stringify(draft.passJson),
        JSON.stringify(draftAssets),
        kit.clock.now(),
        'incompatible-draft-build',
      ],
    );
    await run(
      kit.env.DB,
      'UPDATE templates SET active_version = ?, updated_at = updated_at + 1 WHERE id = ?',
      [draft.version, id],
    );
    const source = await kit.scanner({ settings: { acceptAllTemplates: true } });
    const monitor = await screen('monitor', [source.id]);
    const device = await getScanner(kit.env.DB, source.id);
    if (!device) throw new Error('Missing legacy source scanner.');
    const actor = await proofedScanActor(
      kit.ctx,
      withRole(
        scannerActor(kit.ctx, device, 'live', 'cookie', { event: null, templateIds: [] }),
        null,
      ),
    );
    const evaluation = await resolveOutcome(kit.ctx, actor, {
      input: { passId: pass.id, method: 'manual' },
      clientTs: kit.clock.now(),
      idempotencyKey: key(),
    });
    expect(evaluation.outcome.kind).toBe('ready');
    const releaseScope = {
      templateIdSql: 'p.template_id',
      orgIdSql: 'p.org_id',
      modeSql: 'p.mode',
      providerSql: "'apple'",
    };
    const releaseStateSql = `SELECT (${noScopedReleaseSql(releaseScope)}) AS absent,
      (${effectiveReleaseIdSql(releaseScope)}) AS active FROM passes p WHERE p.id = ?`;
    expect(await first(kit.env.DB, releaseStateSql, [pass.id])).toEqual({
      absent: 1,
      active: null,
    });
    const candidate = await candidateById(kit.env.DB, kit.org.id, pass.id);
    if (!candidate) throw new Error('Missing legacy pass candidate.');
    expect(candidate.pass.releaseId).toBeNull();
    expect(candidate).toMatchObject({
      activeTemplateVersion: pinned.version,
      activeReleaseId: null,
      activeReleaseGeneration: null,
      activeReleaseVersion: null,
      activeReleaseCandidateHash: null,
    });
    publishScan(
      kit.ctx,
      actor,
      evaluation.outcome,
      evaluation.evaluatedSnapshot,
      evaluation.credentialContext,
      'manual',
    );
    await kit.settle();
    const projection = (await hub().snapshot(monitor.attachment)).rows.find(
      (entry) => entry.scannerId === source.id,
    );
    if (!projection?.photoUrl) throw new Error('Missing pinned legacy photo.');
    expect(projection).toMatchObject({ passId: pass.id, holder: 'Legacy Member' });
    const path = projection.photoUrl.replace('/api/v1/scan', '');
    expect((await kit.get(monitor.headers, path)).status).toBe(200);
    const sealed = await hub().sourceProof(projection.id);
    if (!sealed) throw new Error('Missing legacy source proof.');
    expect((await openLiveSourceProof(kit.env, sealed))?.passSnapshot).toMatchObject({
      passReleaseId: null,
      activeTemplateVersion: pinned.version,
      activeReleaseId: null,
      activeReleaseGeneration: null,
      activeReleaseVersion: null,
      activeReleaseCandidateHash: null,
    });
    const approved = await approveAppleRelease(kit, { templateId: id, version: draft.version });
    expect(await first(kit.env.DB, releaseStateSql, [pass.id])).toEqual({
      absent: 0,
      active: approved.id,
    });
    expect((await kit.get(monitor.headers, path)).status).toBe(404);
    const stale = (await hub().snapshot(monitor.attachment)).rows.find(
      (entry) => entry.id === projection.id,
    );
    expect(stale).toMatchObject({ passId: null, holder: null, photoUrl: null });
    const reevaluated = await resolveOutcome(kit.ctx, actor, {
      input: { passId: pass.id, method: 'manual' },
      clientTs: kit.clock.now(),
      idempotencyKey: key(),
    });
    publishScan(
      kit.ctx,
      actor,
      reevaluated.outcome,
      reevaluated.evaluatedSnapshot,
      reevaluated.credentialContext,
      'manual',
    );
    await kit.settle();
    const current = (await hub().snapshot(monitor.attachment)).rows.find(
      (entry) => entry.scannerId === source.id && entry.id !== projection.id,
    );
    expect(current).toMatchObject({ passId: null, holder: null, photoUrl: null });
    // Archiving makes the head ineligible, but immutable scoped history must not reopen fallback.
    await run(
      kit.env.DB,
      "UPDATE templates SET status = 'archived', updated_at = updated_at + 1 WHERE id = ?",
      [id],
    );
    expect(await first(kit.env.DB, releaseStateSql, [pass.id])).toEqual({
      absent: 0,
      active: null,
    });
    expect((await kit.get(monitor.headers, path)).status).toBe(404);
    const archived = (await hub().snapshot(monitor.attachment)).rows.find(
      (entry) => entry.id === projection.id,
    );
    expect(archived).toMatchObject({ passId: null, holder: null, photoUrl: null });
  });

  it('removes an unwatched source from catch-up and denies its retained grant', async () => {
    const fixture = await photoFixture();
    expect((await kit.get(fixture.monitor.headers, fixture.path)).status).toBe(200);
    await setSetupWatchStmt(kit.env.DB, kit.org.id, fixture.monitor.id, {
      scannerIds: [],
      allOrg: false,
    }).run();
    expect((await hub().snapshot(fixture.monitor.attachment)).rows).toEqual([]);
    expect((await kit.get(fixture.monitor.headers, fixture.path)).status).toBe(404);
  });

  it.each(['revoked', 'expired', 'rotated'] as const)(
    'omits the event and denies a live grant when the source is %s',
    async (change) => {
      const fixture = await photoFixture();
      expect((await kit.get(fixture.monitor.headers, fixture.path)).status).toBe(200);
      if (change === 'revoked') {
        await run(kit.env.DB, 'UPDATE scanners SET revoked_at = ? WHERE id = ?', [
          kit.clock.now(),
          fixture.source.id,
        ]);
      } else if (change === 'expired') {
        await run(kit.env.DB, 'UPDATE scanners SET expires_at = ? WHERE id = ?', [
          kit.clock.now(),
          fixture.source.id,
        ]);
      } else {
        await run(
          kit.env.DB,
          'UPDATE scanners SET token_hash = ?, updated_at = updated_at + 1 WHERE id = ?',
          ['rotated-source-token', fixture.source.id],
        );
      }
      expect((await kit.get(fixture.monitor.headers, fixture.path)).status).toBe(404);
      const row = (await hub().snapshot(fixture.monitor.attachment)).rows.find(
        (item) => item.id === fixture.event.id,
      );
      expect(row).toBeUndefined();
    },
  );

  it('rejects a revoked recipient before returning history or a photo', async () => {
    const fixture = await photoFixture();
    expect((await kit.get(fixture.monitor.headers, fixture.path)).status).toBe(200);
    await run(kit.env.DB, 'UPDATE scanners SET revoked_at = ? WHERE id = ?', [
      kit.clock.now(),
      fixture.monitor.id,
    ]);
    expect(await liveRecipient(kit.ctx, fixture.monitor.attachment)).toBeNull();
    expect((await hub().snapshot(fixture.monitor.attachment)).rows).toEqual([]);
    const response = await kit.get(fixture.monitor.headers, fixture.path);
    expect(response.status).toBe(401);
    expect(await response.json()).toMatchObject({ code: 'SCANNER_REVOKED' });
  });
});
