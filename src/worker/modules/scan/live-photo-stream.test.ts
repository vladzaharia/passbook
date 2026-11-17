import { describe, expect, it, vi } from 'vitest';
import { expectProblem } from '../../../../test/helpers/denial.ts';
import { persistTemplate } from '../../../../test/helpers/index.ts';
import { run } from '../../platform/db.ts';
import { approveAppleRelease } from '../passes/apple-release-test-fixtures.ts';
import { ICON_PNG } from '../passes/pass-test-fixtures.ts';
import { memberPhoto } from '../passes/repo-member-photo.ts';
import { claimRemoval, releaseRemoval } from '../passes/repo-remove.ts';
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
  /** The bucket read of the photo runs `change` while the object is open; returns the response. */
  async function openWith(
    fixture: Awaited<ReturnType<typeof photoFixture>>,
    change: () => Promise<void>,
  ) {
    const stored = await memberPhoto(kit.env.DB, kit.org.id, fixture.pass.id);
    if (!stored) throw new Error('Missing stored photo fixture.');
    const originalGet = kit.env.BUCKET.get.bind(kit.env.BUCKET);
    let opened = false;
    let cancelled = 0;
    const spy = vi.spyOn(kit.env.BUCKET, 'get').mockImplementation(async (key, options) => {
      const object = await originalGet(key, options);
      if (key !== stored.r2_key || !object) return object;
      opened = true;
      await change();
      return observeCancellation(object, () => {
        cancelled++;
      });
    });
    try {
      return { response: await kit.get(fixture.monitor.headers, fixture.path), opened, cancelled };
    } finally {
      spy.mockRestore();
    }
  }

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
        await expectProblem(
          await kit.get(fixture.monitor.headers, fixture.path),
          404,
          'ASSET_NOT_FOUND',
        );
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
    // The transfer bumped the credential generation: the old event stays redacted for good.
    await expectProblem(
      await kit.get(fixture.monitor.headers, fixture.path),
      404,
      'ASSET_NOT_FOUND',
    );
  });

  it('keeps the event and withholds only the photo after an image-row update', async () => {
    const fixture = await photoFixture();
    const before = await candidateById(kit.env.DB, kit.org.id, fixture.pass.id);
    const stored = await memberPhoto(kit.env.DB, kit.org.id, fixture.pass.id);
    if (!before || !stored) throw new Error('Missing image lineage fixture.');
    expect((await hub().ringRow(fixture.event.id))?.gen?.image).toBe(before.pass.imageGeneration);
    expect((await kit.get(fixture.monitor.headers, fixture.path)).status).toBe(200);
    await run(kit.env.DB, 'UPDATE member_photos SET updated_at = updated_at WHERE pass_id = ?', [
      fixture.pass.id,
    ]);
    const after = await candidateById(kit.env.DB, kit.org.id, fixture.pass.id);
    expect(after?.pass.imageGeneration).toBe(before.pass.imageGeneration + 1);
    let opened = false;
    const originalGet = kit.env.BUCKET.get.bind(kit.env.BUCKET);
    const spy = vi.spyOn(kit.env.BUCKET, 'get').mockImplementation(async (key, options) => {
      if (key === stored.r2_key) opened = true;
      return originalGet(key, options);
    });
    try {
      await expectProblem(
        await kit.get(fixture.monitor.headers, fixture.path),
        404,
        'ASSET_NOT_FOUND',
      );
      expect(opened).toBe(false);
    } finally {
      spy.mockRestore();
    }
    const kept = (await hub().snapshot(fixture.monitor.attachment)).rows.find(
      (entry) => entry.id === fixture.event.id,
    );
    expect(kept).toMatchObject({ passId: fixture.pass.id, photoUrl: null });
    const event = row(fixture.source.id, { passId: fixture.pass.id });
    await publish(event);
    const fresh = (await hub().snapshot(fixture.monitor.attachment)).rows.find(
      (entry) => entry.id === event.id,
    );
    if (!fresh?.photoUrl) throw new Error('Missing fresh image-authorized photo.');
    expect(
      (await kit.get(fixture.monitor.headers, fresh.photoUrl.replace('/api/v1/scan', ''))).status,
    ).toBe(200);
  });

  it('keeps showing the pass after content-only changes to its Wallet row', async () => {
    const fixture = await photoFixture();
    const before = await candidateById(kit.env.DB, kit.org.id, fixture.pass.id);
    if (!before?.versionPersonalization) throw new Error('Missing Wallet-row provenance.');
    await run(
      kit.env.DB,
      `UPDATE pass_versions SET personalization = json_set(personalization, '$.memberName', ?)
      WHERE pass_id = ? AND version = ?`,
      ['Different Wallet-row member', fixture.pass.id, before.walletVersion],
    );
    expect((await kit.get(fixture.monitor.headers, fixture.path)).status).toBe(200);
    expect(
      (await hub().snapshot(fixture.monitor.attachment)).rows.find(
        (entry) => entry.id === fixture.event.id,
      ),
    ).toMatchObject({ passId: fixture.pass.id });
  });

  it.each([
    ['missing', null],
    ['serial', '$.serialNumber'],
    ['pass type', '$.passTypeIdentifier'],
    ['team', '$.teamIdentifier'],
  ] as const)(
    'withholds a new event whose %s wallet identity is damaged',
    async (_damage, field) => {
      const fixture = await photoFixture();
      await run(
        kit.env.DB,
        field === null
          ? 'UPDATE pass_versions SET pass_json = NULL WHERE pass_id = ?'
          : `UPDATE pass_versions SET pass_json = json_set(pass_json, '${field}', 'incorrect-identity') WHERE pass_id = ?`,
        [fixture.pass.id],
      );
      const event = row(fixture.source.id, { passId: fixture.pass.id });
      await expect(publish(event)).rejects.toThrow('The source pass cannot be shown.');
      expect(
        (await hub().snapshot(fixture.monitor.attachment)).rows.find(
          (entry) => entry.id === event.id,
        ),
      ).toBeUndefined();
    },
  );

  it('serves monitor photos without exposing a photo-version cache validator', async () => {
    const fixture = await photoFixture();
    const response = await kit.get(fixture.monitor.headers, fixture.path);
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('private, no-store');
    expect(response.headers.get('etag')).toBeNull();
  });

  // The candidate's templateRevision is the org's config_revision: not door authority (R8).
  it.each(['org rename', 'org suspend-resume', 'source revoked'] as const)(
    'keeps an opened photo stream through %s during the object read',
    async (change) => {
      const fixture = await photoFixture();
      const { response, opened } = await openWith(fixture, async () => {
        if (change === 'org rename')
          await run(kit.env.DB, "UPDATE orgs SET name = name || ' (renamed)' WHERE id = ?", [
            kit.org.id,
          ]);
        else if (change === 'org suspend-resume')
          for (const status of ['suspended', 'active'])
            await run(kit.env.DB, 'UPDATE orgs SET status = ? WHERE id = ?', [status, kit.org.id]);
        else
          await run(kit.env.DB, 'UPDATE scanners SET revoked_at = ? WHERE id = ?', [
            kit.clock.now(),
            fixture.source.id,
          ]);
      });
      expect(opened).toBe(true);
      expect(response.status).toBe(200);
      expect((await response.arrayBuffer()).byteLength).toBeGreaterThan(0);
    },
  );

  it.each([
    'watch',
    'monitor',
    'transfer-pending',
    'removal-rollback',
    'image-generation',
    'release',
  ] as const)(
    'cancels an opened photo stream if %s authority changes during the object read',
    async (change) => {
      const fixture = await photoFixture();
      if (change === 'release') {
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
      const transfer: { finish?: () => Promise<void> } = {};
      const result = await openWith(fixture, async () => {
        if (change === 'watch') {
          await setSetupWatchStmt(kit.env.DB, kit.org.id, fixture.monitor.id, {
            scannerIds: [],
            allOrg: false,
          }).run();
        } else if (change === 'release') {
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
          await run(
            kit.env.DB,
            'UPDATE member_photos SET updated_at = updated_at WHERE pass_id = ?',
            [fixture.pass.id],
          );
        } else {
          await run(kit.env.DB, 'UPDATE scanners SET revoked_at = ? WHERE id = ?', [
            kit.clock.now(),
            fixture.monitor.id,
          ]);
        }
      });
      if (transfer.finish) await transfer.finish();
      expect(result.opened).toBe(true);
      expect(result.cancelled).toBe(1);
      expect(result.response.status).toBe(404);
      expect(await result.response.json()).toMatchObject({ code: 'ASSET_NOT_FOUND' });
    },
  );
});
