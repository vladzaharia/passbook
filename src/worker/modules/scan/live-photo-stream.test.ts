import { runInDurableObject } from 'cloudflare:test';
import { describe, expect, it, vi } from 'vitest';
import { persistTemplate } from '../../../../test/helpers/index.ts';
import { first, run } from '../../platform/db.ts';
import { approveAppleRelease } from '../passes/apple-release-test-fixtures.ts';
import { ICON_PNG } from '../passes/pass-test-fixtures.ts';
import { memberPhoto } from '../passes/repo-member-photo.ts';
import { claimRemoval, releaseRemoval } from '../passes/repo-remove.ts';
import { livePassSnapshot, openLiveSourceProof } from './live-provenance.ts';
import { candidateById } from './repo-lookup.ts';
import { setSetupWatchStmt } from './repo-setups-test-support.ts';
import {
  beginCredentialTransfer,
  hub,
  kit,
  observeCancellation,
  photoFixture,
  publish,
  row,
  template,
} from './scan-hub-test-fixtures.ts';

describe('live photo streams', () => {
  it('denies identity and a retained photo before opening while transfer is pending', async () => {
    const fixture = await photoFixture();
    expect((await kit.get(fixture.monitor.headers, fixture.path)).status).toBe(200);
    const stored = await memberPhoto(kit.env.DB, kit.org.id, fixture.pass.id);
    if (!stored) throw new Error('Missing stored photo fixture.');
    const finish = await beginCredentialTransfer(fixture.pass.id);
    try {
      const originalGet = kit.env.BUCKET.get.bind(kit.env.BUCKET);
      let opened = false;
      const spy = vi.spyOn(kit.env.BUCKET, 'get').mockImplementation(async (key, options) => {
        if (key === stored.r2_key) opened = true;
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
    } finally {
      await finish();
    }
    expect((await kit.get(fixture.monitor.headers, fixture.path)).status).toBe(404);
  });

  it('rejects a retained event when the persisted Wallet-row personalization changes in place', async () => {
    const fixture = await photoFixture();
    const before = await candidateById(kit.env.DB, kit.org.id, fixture.pass.id);
    const sealed = await hub().sourceProof(fixture.event.id);
    if (!before?.versionPersonalization || !sealed)
      throw new Error('Missing Wallet-row provenance.');
    const proof = await openLiveSourceProof(kit.env, sealed);
    if (!proof?.passSnapshot) throw new Error('Missing sealed pass snapshot.');
    expect(JSON.stringify(proof.passSnapshot)).not.toContain(before.versionPersonalization);
    expect((await kit.get(fixture.monitor.headers, fixture.path)).status).toBe(200);
    const now = kit.clock.now();
    await run(
      kit.env.DB,
      `UPDATE pass_versions SET personalization = json_set(personalization, '$.memberName', ?)
      WHERE pass_id = ? AND version = ?`,
      ['Different Wallet-row member', fixture.pass.id, before.walletVersion],
    );
    const after = await candidateById(kit.env.DB, kit.org.id, fixture.pass.id);
    if (!after) throw new Error('Missing modified Wallet candidate.');
    expect(after.walletVersion).toBe(before.walletVersion);
    expect(after.pass.version).toBe(before.pass.version);
    expect(after.passJsonSnapshot).toBe(before.passJsonSnapshot);
    expect(after.versionPersonalization).not.toBe(before.versionPersonalization);
    expect(kit.clock.now()).toBe(now);
    expect((await kit.get(fixture.monitor.headers, fixture.path)).status).toBe(404);
    const stale = (await hub().snapshot(fixture.monitor.attachment)).rows.find(
      (entry) => entry.id === fixture.event.id,
    );
    expect(stale).toMatchObject({ passId: null, holder: null, photoUrl: null });
  });

  it('rejects a retained photo before opening after an identical image-row update', async () => {
    const fixture = await photoFixture();
    const before = await candidateById(kit.env.DB, kit.org.id, fixture.pass.id);
    const stored = await memberPhoto(kit.env.DB, kit.org.id, fixture.pass.id);
    if (!before || !stored) throw new Error('Missing image lineage fixture.');
    const sealed = await hub().sourceProof(fixture.event.id);
    if (!sealed) throw new Error('Missing image lineage proof.');
    const proof = await openLiveSourceProof(kit.env, sealed);
    expect(proof?.passSnapshot?.imageGeneration).toBe(before.pass.imageGeneration);
    expect((await kit.get(fixture.monitor.headers, fixture.path)).status).toBe(200);
    await run(kit.env.DB, 'UPDATE member_photos SET updated_at = updated_at WHERE pass_id = ?', [
      fixture.pass.id,
    ]);
    const after = await candidateById(kit.env.DB, kit.org.id, fixture.pass.id);
    expect(after?.pass.imageGeneration).toBe(before.pass.imageGeneration + 1);
    expect(await memberPhoto(kit.env.DB, kit.org.id, fixture.pass.id)).toEqual(stored);
    let opened = false;
    const originalGet = kit.env.BUCKET.get.bind(kit.env.BUCKET);
    const spy = vi.spyOn(kit.env.BUCKET, 'get').mockImplementation(async (key, options) => {
      if (key === stored.r2_key) opened = true;
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

  it('cancels an open stream and keeps its source proof stale after same-clock signing identity ABA', async () => {
    const fixture = await photoFixture();
    const identity = await first<{ pass_type_identifier: string; revision: number }>(
      kit.env.DB,
      'SELECT pass_type_identifier, revision FROM signing_identities WHERE id = ?',
      [fixture.pass.identityId],
    );
    const stored = await memberPhoto(kit.env.DB, kit.org.id, fixture.pass.id);
    const sealed = await hub().sourceProof(fixture.event.id);
    if (!identity || !stored || !sealed) throw new Error('Missing signing identity fixture.');
    expect((await openLiveSourceProof(kit.env, sealed))?.passSnapshot?.identityRevision).toBe(
      identity.revision,
    );
    expect((await kit.get(fixture.monitor.headers, fixture.path)).status).toBe(200);
    const now = kit.clock.now();
    const originalGet = kit.env.BUCKET.get.bind(kit.env.BUCKET);
    let opened = false;
    let cancelled = 0;
    const spy = vi.spyOn(kit.env.BUCKET, 'get').mockImplementation(async (key, options) => {
      const object = await originalGet(key, options);
      if (key !== stored.r2_key || !object) return object;
      opened = true;
      try {
        await run(
          kit.env.DB,
          'UPDATE signing_identities SET pass_type_identifier = ? WHERE id = ?',
          [`${identity.pass_type_identifier}.temporary`, fixture.pass.identityId],
        );
      } finally {
        await run(
          kit.env.DB,
          'UPDATE signing_identities SET pass_type_identifier = ? WHERE id = ?',
          [identity.pass_type_identifier, fixture.pass.identityId],
        );
      }
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
    expect(kit.clock.now()).toBe(now);
    const after = await first<{ pass_type_identifier: string; revision: number }>(
      kit.env.DB,
      'SELECT pass_type_identifier, revision FROM signing_identities WHERE id = ?',
      [fixture.pass.identityId],
    );
    expect(after?.pass_type_identifier).toBe(identity.pass_type_identifier);
    expect(after?.revision).toBeGreaterThan(identity.revision);
    const stale = (await hub().snapshot(fixture.monitor.attachment)).rows.find(
      (entry) => entry.id === fixture.event.id,
    );
    expect(stale).toMatchObject({ passId: null, holder: null, photoUrl: null });
    const event = row(fixture.source.id, { passId: fixture.pass.id });
    await publish(event);
    const fresh = (await hub().snapshot(fixture.monitor.attachment)).rows.find(
      (entry) => entry.id === event.id,
    );
    if (!fresh?.photoUrl) throw new Error('Missing fresh identity-authorized photo.');
    expect(
      (await kit.get(fixture.monitor.headers, fresh.photoUrl.replace('/api/v1/scan', ''))).status,
    ).toBe(200);
  });

  it.each([
    ['missing', null],
    ['serial', '$.serialNumber'],
    ['pass type', '$.passTypeIdentifier'],
    ['team', '$.teamIdentifier'],
  ] as const)('redacts %s wallet identity before opening the photo', async (_damage, field) => {
    const fixture = await photoFixture();
    expect((await kit.get(fixture.monitor.headers, fixture.path)).status).toBe(200);
    const stored = await memberPhoto(kit.env.DB, kit.org.id, fixture.pass.id);
    if (!stored) throw new Error('Missing stored photo fixture.');
    await run(
      kit.env.DB,
      field === null
        ? 'UPDATE pass_versions SET pass_json = NULL WHERE pass_id = ?'
        : `UPDATE pass_versions SET pass_json = json_set(pass_json, '${field}', 'incorrect-identity') WHERE pass_id = ?`,
      [fixture.pass.id],
    );
    const originalGet = kit.env.BUCKET.get.bind(kit.env.BUCKET);
    let opened = false;
    const spy = vi.spyOn(kit.env.BUCKET, 'get').mockImplementation(async (key, options) => {
      if (key === stored.r2_key) opened = true;
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
    // Without a matching Wallet identity there is no pass commitment, so a new event for this
    // pass cannot be sealed (publishScan skips it) and nothing new reaches the screen.
    const damaged = await candidateById(kit.env.DB, kit.org.id, fixture.pass.id);
    if (!damaged) throw new Error('Missing damaged pass candidate.');
    expect((await livePassSnapshot(kit.env, damaged)).passCommitment).toBeNull();
    const event = row(fixture.source.id, { passId: fixture.pass.id });
    await expect(publish(event)).rejects.toThrow('Invalid live source authority');
    const fresh = (await hub().snapshot(fixture.monitor.attachment)).rows.find(
      (entry) => entry.id === event.id,
    );
    expect(fresh).toBeUndefined();
  });

  it('serves monitor photos without exposing a photo-version cache validator', async () => {
    const fixture = await photoFixture();
    const response = await kit.get(fixture.monitor.headers, fixture.path);
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('private, no-store');
    expect(response.headers.get('etag')).toBeNull();
  });

  it.each([
    'watch',
    'monitor',
    'source',
    'pass',
    'proof',
    'cancel-rejects',
    'wallet-voided',
    'wallet-expired',
    'wallet-serial',
    'wallet-pass-type',
    'wallet-team',
    'wallet-missing',
    'wallet-personalization',
    'transfer-pending',
    'removal-rollback',
    'image-generation',
    'org-revision',
    'template-revision',
    'policy',
  ] as const)(
    'cancels an opened photo stream if %s authority changes during the object read',
    async (change) => {
      const fixture = await photoFixture();
      const stored = await memberPhoto(kit.env.DB, kit.org.id, fixture.pass.id);
      if (!stored) throw new Error('Missing stored photo fixture.');
      if (change === 'policy') {
        const pinned = await kit.registry.resolve(template);
        const manifest = structuredClone(pinned.manifest);
        manifest.scan!.display = { v: 1, header: {}, photo: { minRole: 'desk' } };
        const active = kit.registry.add({
          id: template,
          orgId: pinned.orgId,
          version: 'stream-policy-v2',
          manifest,
          passJson: pinned.passJson,
          assets: { 'icon.png': ICON_PNG },
        });
        await persistTemplate(kit.fx, active, { registry: kit.registry });
      }
      const originalGet = kit.env.BUCKET.get.bind(kit.env.BUCKET);
      let opened = false;
      let cancelled = 0;
      const transfer: { finish?: () => Promise<void> } = {};
      const spy = vi.spyOn(kit.env.BUCKET, 'get').mockImplementation(async (key, options) => {
        const object = await originalGet(key, options);
        if (key !== stored.r2_key || !object) return object;
        opened = true;
        if (change === 'watch' || change === 'cancel-rejects') {
          await setSetupWatchStmt(kit.env.DB, kit.org.id, fixture.monitor.id, {
            scannerIds: [],
            allOrg: false,
          }).run();
        } else if (change === 'proof') {
          await runInDurableObject(hub(), async (_object, state) => state.storage.delete('recent'));
        } else if (change === 'policy') {
          await approveAppleRelease(kit, { templateId: template, version: 'stream-policy-v2' });
        } else if (change === 'transfer-pending') {
          transfer.finish = await beginCredentialTransfer(fixture.pass.id);
        } else if (change === 'removal-rollback') {
          const candidate = await candidateById(kit.env.DB, kit.org.id, fixture.pass.id);
          if (!candidate) throw new Error('Missing removal candidate.');
          const now = kit.clock.now();
          const state = { at: now, message: null, priorStatus: candidate.pass.status };
          const generation = await claimRemoval(kit.ctx, fixture.pass.id, state, {
            pass: candidate.pass,
            generation: candidate.pass.lifecycleGeneration,
            now,
          });
          if (generation === null) throw new Error('Removal claim failed.');
          await releaseRemoval(kit.env.DB, fixture.pass.id, {
            pass: candidate.pass,
            state,
            generation,
          });
        } else if (change === 'image-generation') {
          const before = await candidateById(kit.env.DB, kit.org.id, fixture.pass.id);
          if (!before) throw new Error('Missing image generation.');
          await run(
            kit.env.DB,
            'UPDATE member_photos SET updated_at = updated_at WHERE pass_id = ?',
            [fixture.pass.id],
          );
          const after = await candidateById(kit.env.DB, kit.org.id, fixture.pass.id);
          expect(after?.pass.imageGeneration).toBe(before.pass.imageGeneration + 1);
        } else if (change === 'wallet-personalization') {
          await run(
            kit.env.DB,
            `UPDATE pass_versions SET personalization = json_set(personalization, '$.memberName', ?)
            WHERE pass_id = ? AND version = (SELECT max(version) FROM pass_versions
              WHERE pass_id = ? AND pass_json IS NOT NULL)`,
            ['Changed after open', fixture.pass.id, fixture.pass.id],
          );
        } else if (change === 'wallet-missing') {
          await run(kit.env.DB, 'UPDATE pass_versions SET pass_json = NULL WHERE pass_id = ?', [
            fixture.pass.id,
          ]);
        } else if (
          change === 'wallet-voided' ||
          change === 'wallet-expired' ||
          change === 'wallet-serial' ||
          change === 'wallet-pass-type' ||
          change === 'wallet-team'
        ) {
          const updates = {
            'wallet-voided': "json_set(pass_json, '$.voided', json('true'))",
            'wallet-expired': "json_set(pass_json, '$.expirationDate', '2000-01-01T00:00:00Z')",
            'wallet-serial': "json_set(pass_json, '$.serialNumber', 'different-serial')",
            'wallet-pass-type': "json_set(pass_json, '$.passTypeIdentifier', 'pass.invalid.type')",
            'wallet-team': "json_set(pass_json, '$.teamIdentifier', 'INVALIDTEAM')",
          };
          const value = updates[change];
          await run(
            kit.env.DB,
            `UPDATE pass_versions SET pass_json = ${value}
             WHERE pass_id = ? AND version = (
               SELECT max(version) FROM pass_versions WHERE pass_id = ? AND pass_json IS NOT NULL
             )`,
            [fixture.pass.id, fixture.pass.id],
          );
        } else if (change === 'org-revision') {
          // access_revision moves with status (timestamps are not authority).
          for (const status of ['suspended', 'active'])
            await run(kit.env.DB, 'UPDATE orgs SET status = ? WHERE id = ?', [status, kit.org.id]);
        } else if (change === 'template-revision') {
          // The candidate's templateRevision is the org's config_revision.
          await run(kit.env.DB, "UPDATE orgs SET name = name || ' (renamed)' WHERE id = ?", [
            kit.org.id,
          ]);
        } else if (change === 'source' || change === 'monitor') {
          await run(kit.env.DB, 'UPDATE scanners SET revoked_at = ? WHERE id = ?', [
            kit.clock.now(),
            change === 'source' ? fixture.source.id : fixture.monitor.id,
          ]);
        } else {
          await run(
            kit.env.DB,
            'UPDATE passes SET link_generation = link_generation + 1 WHERE id = ?',
            [fixture.pass.id],
          );
        }
        return observeCancellation(object, () => {
          cancelled++;
          if (change === 'cancel-rejects') throw new Error('Cancellation failed');
        });
      });
      let response: Response;
      try {
        response = await kit.get(fixture.monitor.headers, fixture.path);
      } finally {
        spy.mockRestore();
        if (transfer.finish) await transfer.finish();
      }
      expect(opened).toBe(true);
      expect(cancelled).toBe(1);
      expect(response.status).toBe(404);
      expect(await response.json()).toMatchObject({ code: 'ASSET_NOT_FOUND' });
    },
  );
});
