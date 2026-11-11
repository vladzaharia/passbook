import { describe, expect, it, vi } from 'vitest';
import { makeOrg } from '../../../../test/helpers/index.ts';
import { run } from '../../platform/db.ts';
import { putMemberPhoto } from '../passes/member-photo.ts';
import { memberPhoto } from '../passes/repo-member-photo.ts';
import { makePng } from '../templates/package/fixtures.ts';
import { assetGrantTokenHash } from './assets.ts';
import { verifyLiveTemplateSnapshot } from './live-template-snapshot.ts';
import { candidateById } from './repo-lookup.ts';
import { kit, observeCancellation, photoFixture } from './scan-hub-test-fixtures.ts';

describe('live photo open-to-commit fence', () => {
  it.each([
    'source-token',
    'recipient-token',
    'source-config',
    'recipient-config',
    'source-mode',
    'recipient-mode',
    'source-scope',
    'grant',
    'photo-key',
    'photo-version',
    'photo-hash',
    'photo-inclusion',
    'template-bytes',
  ] as const)('cancels the open R2 body when %s changes', async (change) => {
    const fixture = await photoFixture();
    const before = await candidateById(kit.env.DB, kit.org.id, fixture.pass.id);
    const stored = await memberPhoto(kit.env.DB, kit.org.id, fixture.pass.id);
    if (!before || !stored) throw new Error('Missing original photo authority.');
    const resolved = await verifyLiveTemplateSnapshot(
      kit.ctx,
      before,
      before.templateSnapshot,
      'commit',
    );
    const asset = resolved?.pinned.assets.find((entry) => entry.source.kind === 'r2');
    if (asset?.source.kind !== 'r2') throw new Error('Missing pinned R2 template asset.');
    const assetKey = asset.source.key;
    const assetObject = await kit.env.BUCKET.get(assetKey);
    if (!assetObject) throw new Error('Missing pinned template bytes.');
    const originalBytes = new Uint8Array(await assetObject.arrayBuffer());
    if (!originalBytes.length) throw new Error('Empty pinned template asset.');
    const grant = new URL(fixture.path, 'https://wallet.test').searchParams.get('g');
    const hash = await assetGrantTokenHash(grant ?? undefined);
    if (!hash) throw new Error('Missing live grant.');
    const originalGet = kit.env.BUCKET.get.bind(kit.env.BUCKET);
    let opened = false;
    let cancelled = 0;
    const spy = vi.spyOn(kit.env.BUCKET, 'get').mockImplementation(async (key, options) => {
      const object = await originalGet(key, options);
      if (key !== stored.r2_key || !object) return object;
      opened = true;
      if (change === 'source-token' || change === 'recipient-token') {
        const scanner = change === 'source-token' ? fixture.source.id : fixture.monitor.id;
        await run(
          kit.env.DB,
          'UPDATE scanners SET token_hash=?, updated_at=updated_at+1 WHERE id=?',
          [`replacement-${kit.ctx.ids.token()}`, scanner],
        );
      } else if (change === 'source-config' || change === 'recipient-config') {
        const scanner = change === 'source-config' ? fixture.source.id : fixture.monitor.id;
        await run(
          kit.env.DB,
          "UPDATE scanners SET time_zone = CASE time_zone WHEN 'UTC' THEN 'Europe/Paris' ELSE 'UTC' END WHERE id=?",
          [scanner],
        );
      } else if (change === 'source-mode' || change === 'recipient-mode') {
        const scanner = change === 'source-mode' ? fixture.source.id : fixture.monitor.id;
        await run(
          kit.env.DB,
          "UPDATE scanners SET mode='test', updated_at=updated_at+1 WHERE id=?",
          [scanner],
        );
      } else if (change === 'source-scope') {
        await run(
          kit.env.DB,
          'DELETE FROM scanner_templates WHERE scanner_id=? AND template_id=?',
          [fixture.source.id, fixture.pass.templateId],
        );
      } else if (change === 'grant') {
        await run(kit.env.DB, 'DELETE FROM scan_asset_grant_provenance WHERE token_hash=?', [hash]);
      } else if (change === 'template-bytes') {
        const changed = originalBytes.slice();
        changed[0] = originalBytes[0]! ^ 1;
        await kit.env.BUCKET.put(assetKey, changed);
      } else {
        const field = {
          'photo-key': ['r2_key', `${stored.r2_key}-replacement`],
          'photo-version': ['version', `${stored.version}-replacement`],
          'photo-hash': ['sha1', stored.sha1 === 'f'.repeat(40) ? 'e'.repeat(40) : 'f'.repeat(40)],
          'photo-inclusion': ['include_in_pass', stored.include_in_pass === 0 ? 1 : 0],
        }[change];
        await run(kit.env.DB, `UPDATE member_photos SET ${field[0]}=? WHERE pass_id=?`, [
          field[1]!,
          fixture.pass.id,
        ]);
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
      if (change === 'template-bytes') await kit.env.BUCKET.put(assetKey, originalBytes);
    }
    expect(opened).toBe(true);
    expect(cancelled).toBe(1);
    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({ code: 'ASSET_NOT_FOUND' });
    if (change.startsWith('photo-')) {
      const after = await candidateById(kit.env.DB, kit.org.id, fixture.pass.id);
      expect(after?.pass.id).toBe(before.pass.id);
      expect(after?.pass.version).toBe(before.pass.version);
      expect(after?.pass.imageGeneration).toBe(before.pass.imageGeneration + 1);
    }
  });

  it('does not open a foreign tenant photo with an otherwise valid local event and grant', async () => {
    const fixture = await photoFixture();
    const foreignOrg = await makeOrg(kit.fx, { name: 'Foreign photo tenant' });
    const foreignTemplate = await kit.scanTemplate(
      'Foreign photo',
      {
        actions: [{ id: 'check_in', label: 'Check in', kind: 'check_in' }],
      },
      { orgId: foreignOrg.id },
    );
    const foreign = await kit.scanPass(
      foreignTemplate,
      { memberName: 'Foreign confidential holder' },
      { orgId: foreignOrg.id },
    );
    const png = btoa(String.fromCharCode(...makePng(270, 270)));
    await putMemberPhoto(
      kit.ctx,
      { type: 'system', id: null },
      foreign.id,
      { png, includeInPass: false },
      null,
    );
    const foreignPhoto = await memberPhoto(kit.env.DB, foreignOrg.id, foreign.id);
    if (!foreignPhoto) throw new Error('Missing foreign image.');
    const originalGet = kit.env.BUCKET.get.bind(kit.env.BUCKET);
    let opened = false;
    const spy = vi.spyOn(kit.env.BUCKET, 'get').mockImplementation(async (key, options) => {
      if (key === foreignPhoto.r2_key) opened = true;
      return originalGet(key, options);
    });
    try {
      const path = fixture.path.replace(fixture.pass.id, foreign.id);
      expect(path).not.toBe(fixture.path);
      const response = await kit.get(fixture.monitor.headers, path);
      expect(response.status).toBe(404);
      expect(await response.json()).toMatchObject({ code: 'ASSET_NOT_FOUND' });
      expect(opened).toBe(false);
    } finally {
      spy.mockRestore();
    }
  });
});
