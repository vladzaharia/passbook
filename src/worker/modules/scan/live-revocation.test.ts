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
import { getScanner } from './repo-device.ts';
import { candidateById } from './repo-lookup.ts';
import { setSetupWatchStmt } from './repo-setups-test-support.ts';
import { resolveOutcome } from './resolve-outcome.ts';
import { hub, kit, photoFixture, publish, row, screen } from './scan-hub-test-fixtures.ts';
import { key, proofedScanActor } from './test-kit.ts';

describe('live authority revocation', () => {
  it('does not revive a retained grant after a same-clock removal claim is rolled back', async () => {
    const fixture = await photoFixture();
    const before = await candidateById(kit.env.DB, kit.org.id, fixture.pass.id);
    const stored = await hub().ringRow(fixture.event.id);
    if (!before || !stored) throw new Error('Missing lifecycle fixture.');
    expect(stored.gen?.lifecycle).toBe(before.pass.lifecycleGeneration);
    expect((await kit.get(fixture.monitor.headers, fixture.path)).status).toBe(200);
    const now = kit.clock.now();
    const state = { at: now, message: null, priorStatus: before.pass.status };
    const generation = await claimRemoval(kit.ctx, fixture.pass.id, state, {
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
    expect(await hub().ringRow(projection.id)).toMatchObject({ release: null });
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
    // The pass stays on its own version (the head is another build): the screen shows the scan as
    // the device card does, with the head's policy hiding the name and the desk-only photo.
    expect(reevaluated.outcome.kind).toBe('ready');
    expect(JSON.stringify(reevaluated.outcome.card)).not.toContain('Legacy Member');
    expect(current).toMatchObject({ passId: pass.id, holder: null, photoUrl: null });
    expect(JSON.stringify(current)).not.toContain('Legacy Member');
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
    'keeps the scan and its photo for the recipient when the source is %s afterwards',
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
      // The row is re-checked against the recipient, not the source scanner: the scan happened.
      expect((await kit.get(fixture.monitor.headers, fixture.path)).status).toBe(200);
      const shown = (await hub().snapshot(fixture.monitor.attachment)).rows.find(
        (item) => item.id === fixture.event.id,
      );
      expect(shown).toMatchObject({ passId: fixture.pass.id });
      // A source revoked before its next event can no longer publish.
      if (change === 'revoked') await expect(publish(row(fixture.source.id))).resolves.toBe(false);
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
