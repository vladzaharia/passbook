import { expect, it } from 'vitest';
import { first, run } from '../../platform/db.ts';
import { jobCtxOf } from '../delivery/delivery-test-fixtures.ts';
import { putMemberPhoto } from '../passes/member-photo.ts';
import { makePng } from '../templates/package/fixtures.ts';
import { grantInsertConfirmed } from './asset-grant-results.ts';
import { assetActorFor } from './asset-test-fixtures.ts';
import { confirmAssetGrantToken } from './assets.ts';
import { buildCard, cardAssetStmt, cardAssets } from './dto.ts';
import { knownPhotoUrl } from './member-photo.ts';
import { prepareAssetGrantInsertion } from './repo-asset-grants.ts';
import { candidateById } from './repo-lookup.ts';
import { CHECK_IN, kit } from './repo-lookup-release-test-fixtures.ts';
import { foundOf } from './resolve.ts';
import { evaluate } from './resolve-evaluate.ts';

export function registerLookupReleaseSnapshotGrantCase() {
  it('prepares card and photo grants without persisting or disclosing their tokens', async () => {
    const templateId = await kit.scanTemplate('Deferred scanner grants', {
      actions: [CHECK_IN],
      display: { v: 1, header: {}, photo: { minRole: 'door' } },
    });
    const pass = await kit.scanPass(templateId);
    await putMemberPhoto(
      jobCtxOf(kit),
      { type: 'system', id: null },
      pass.id,
      {
        png: btoa(String.fromCharCode(...makePng(270, 270))),
        includeInPass: true,
      },
      null,
    );
    // The DTO reprojects identity; its grant must still bind the unmodified candidate pass.
    await run(kit.env.DB, 'UPDATE passes SET display_title=? WHERE id=?', [
      'Unprojected database title',
      pass.id,
    ]);
    const scanner = await kit.scanner({ templateIds: [templateId] });
    const actor = await assetActorFor(kit, scanner);
    const candidate = await candidateById(kit.env.DB, kit.org.id, pass.id);
    if (!candidate) throw new Error('Missing evaluated candidate');
    const before = await first<{ n: number }>(
      kit.env.DB,
      'SELECT count(*) AS n FROM scan_asset_grant_provenance',
    );
    const found = await foundOf(kit.ctx, candidate, actor);
    if (!found) throw new Error('Missing evaluated pass');
    expect(found).not.toHaveProperty('photoGrant');
    expect(found).not.toHaveProperty('photoUrl');
    expect(candidate).not.toHaveProperty('photoGrant');
    const evaluated = await evaluate(
      kit.ctx,
      actor,
      { passId: pass.id, method: 'manual' },
      {},
      {
        credentialKeysetCommitment: candidate.credentialKeysetCommitment,
        credentialTombstoneRefs: candidate.credentialTombstoneRefs,
        otherModeCredentialTombstoneRefs: candidate.otherModeCredentialTombstoneRefs,
      },
      { candidateRead: { candidates: [candidate] } },
    );
    if (evaluated.stop) throw new Error('Unexpected stopped evaluation');
    expect(evaluated.found).not.toHaveProperty('photoGrant');
    expect(evaluated.found).not.toHaveProperty('photoUrl');
    expect(found.pass.displayTitle).not.toBe(candidate.pass.displayTitle);
    const photo = await knownPhotoUrl(
      kit.ctx,
      actor,
      candidate,
      found.template,
      found.activePolicy,
    );
    if (!photo) throw new Error('Missing deferred photo grant');
    const assetResult = await cardAssetStmt(kit.env.DB, found).all();
    const assetNames = await cardAssets(kit.ctx, found, assetResult);
    if (!assetNames) throw new Error('Missing card asset snapshot');
    expect(assetNames).not.toContain('thumbnail@3x.png');
    const built = await buildCard(kit.ctx, actor, {
      found,
      assetNames,
      grantPurpose: 'read',
      reads: { gates: [], lastScans: [] },
      display: {
        v: 1,
        screen: 'ready',
        templateVersion: found.template.version,
        variant: null,
        identity: { holder: '', initials: '', photo: null },
        header: { icon: null, title: null, titleLines: 1, meta: null, chips: [] },
        panels: [],
        notes: { staff: null, refused: null },
      },
    });
    if (!built) throw new Error('Missing deferred pass-view grant');
    expect(built.card.passView).not.toHaveProperty('assetGrant');
    expect(built.card.passView.assetNames).not.toContain('thumbnail@3x.png');
    expect(photo).not.toHaveProperty('url');
    for (const plan of [built.passViewGrant, photo.grant]) {
      expect(plan).not.toHaveProperty('token');
      expect(confirmAssetGrantToken(plan, undefined)).toBeNull();
      expect(plan.guard).not.toHaveProperty('snapshot');
      const serialized = JSON.stringify(plan);
      for (const secret of [pass.authToken, pass.downloadToken, pass.scanCode]) {
        if (secret) expect(serialized).not.toContain(secret);
      }
      expect(
        await first(
          kit.env.DB,
          'SELECT token_hash FROM scan_asset_grant_provenance WHERE token_hash=?',
          [plan.tokenHash],
        ),
      ).toBeNull();
    }
    expect(
      await first(kit.env.DB, 'SELECT count(*) AS n FROM scan_asset_grant_provenance'),
    ).toEqual(before);
    const prepareInsert = await prepareAssetGrantInsertion(
      kit.ctx,
      built.passViewGrant,
      undefined,
      candidate,
    );
    const inserts = prepareInsert(kit.clock.now(), undefined);
    const results = await kit.env.DB.batch(inserts);
    expect(grantInsertConfirmed(results)).toBe(true);
    const token = confirmAssetGrantToken(built.passViewGrant, results);
    if (!token) throw new Error('Confirmed grant token missing');
    expect(token).toMatch(/^[A-Za-z0-9_-]{54}$/);
    expect(JSON.stringify(built.passViewGrant)).not.toContain(token);
    expect(confirmAssetGrantToken(built.passViewGrant, results)).toBeNull();
    const path = `${built.card.passView.assetBaseUrl}icon.png?g=${token}`.replace(
      '/api/v1/scan',
      '',
    );
    expect((await kit.get(scanner.headers, path)).status).toBe(200);

    const stale = await buildCard(kit.ctx, actor, {
      found,
      assetNames,
      grantPurpose: 'read',
      reads: { gates: [], lastScans: [] },
      display: built.card.display,
    });
    if (!stale) throw new Error('Missing second pass-view grant');
    await putMemberPhoto(
      kit.ctx,
      { type: 'system', id: null },
      pass.id,
      {
        png: btoa(String.fromCharCode(...makePng(270, 270))),
        includeInPass: true,
      },
      null,
    );
    expect(
      await cardAssets(kit.ctx, found, await cardAssetStmt(kit.env.DB, found).all()),
    ).toBeNull();
    const prepareStaleInsert = await prepareAssetGrantInsertion(
      kit.ctx,
      stale.passViewGrant,
      undefined,
      candidate,
    );
    const staleInserts = prepareStaleInsert(kit.clock.now(), undefined);
    await expect(kit.env.DB.batch(staleInserts)).rejects.toThrow();
    expect(
      await first(
        kit.env.DB,
        'SELECT token_hash FROM scan_asset_grant_provenance WHERE token_hash=?',
        [stale.passViewGrant.tokenHash],
      ),
    ).toBeNull();
  });
}
