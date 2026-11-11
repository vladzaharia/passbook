import { beforeAll, describe, expect, it } from 'vitest';
import { editSessionAuthority } from '../../../../test/helpers/index.ts';
import { run } from '../../platform/db.ts';
import { ensureCredentialRefKeyset } from '../passes/credential-keyset.ts';
import { build, fixture, planFor } from './asset-bind-authority-scenarios-test-fixtures.ts';
import { grantInsertConfirmed } from './asset-grant-results.ts';
import { actionExtra, stored } from './repo-asset-bind-authority-test-fixtures.ts';
import { candidateById } from './repo-lookup.ts';
import { type ScanKit, setupScanKit, startScanCredentialTransfer } from './test-kit.ts';

let kit: ScanKit;

beforeAll(async () => {
  kit = await setupScanKit();
  await ensureCredentialRefKeyset(kit.env.DB, kit.env);
});

describe('asset grant D1 bind budget authority', () => {
  it('skips an optional photo grant after an exact photo ABA', async () => {
    const f = await fixture(kit);
    const photo = f.candidate.assetPhoto;
    if (!photo) throw new Error('Missing photo');
    const plan = await planFor(kit, f, 'scanner');
    const required = {
      sql: `p.image_generation IS ? AND EXISTS (
        SELECT 1 FROM member_photos m WHERE m.pass_id=p.id AND m.org_id=p.org_id
          AND m.version IS ? AND m.r2_key IS ?/* scan-ephemeral-asset-photo-key */
          AND m.sha1 IS ? AND m.include_in_pass IS ?)`,
      params: [
        f.candidate.pass.imageGeneration,
        photo.version,
        photo.key,
        photo.sha1,
        photo.includeInPass,
      ],
    };
    const pending = await build(kit, plan, f.candidate, actionExtra(f.candidate), required);
    await run(kit.env.DB, 'UPDATE member_photos SET version = ? WHERE pass_id = ?', [
      'other',
      f.candidate.pass.id,
    ]);
    await run(kit.env.DB, 'UPDATE member_photos SET version = ? WHERE pass_id = ?', [
      photo.version,
      f.candidate.pass.id,
    ]);
    const current = await candidateById(kit.env.DB, kit.org.id, f.candidate.pass.id);
    expect(current?.assetPhoto).toEqual(photo);
    expect(current?.pass.imageGeneration).toBeGreaterThan(f.candidate.pass.imageGeneration);
    expect(grantInsertConfirmed(await kit.env.DB.batch(pending.statements))).toBe(false);
    expect(await stored(kit, plan)).toBeNull();
  });

  it.each(['pass transfer', 'session roles', 'recipient CSRF', 'source CSRF'] as const)(
    'rejects stale %s authority between preparation and the batch',
    async (change) => {
      const f = await fixture(kit);
      const extra = actionExtra(f.candidate);
      const plan = await planFor(kit, f, 'admin');
      const pending = await build(kit, plan, f.candidate, extra);
      if (change === 'pass transfer') await startScanCredentialTransfer(kit, f.candidate.pass.id);
      if (change === 'session roles')
        await editSessionAuthority(
          kit.env.DB,
          `UPDATE sessions SET roles = '["user","admin"]' WHERE id_hash = ?`,
          [f.auth.sessionId],
        );
      if (change === 'recipient CSRF' || change === 'source CSRF')
        await run(
          kit.env.DB,
          'UPDATE scanners SET csrf_secret = ?, updated_at = updated_at + 1 WHERE id = ?',
          ['changed', change === 'recipient CSRF' ? f.device.id : f.sourceDevice.id],
        );
      await expect(kit.env.DB.batch(pending.statements)).rejects.toThrow(
        /scan_asset_authority_failed/,
      );
      expect(await stored(kit, plan)).toBeNull();
    },
  );

  it('rejects an altered original candidate and an exact photo ABA', async () => {
    const f = await fixture(kit);
    const extra = actionExtra(f.candidate);
    const stale = await planFor(kit, f, 'admin');
    const altered = { ...f.candidate, pass: { ...f.candidate.pass, downloadToken: 'different' } };
    const differentCandidate = await build(kit, stale, altered, extra);
    await expect(kit.env.DB.batch(differentCandidate.statements)).rejects.toThrow(
      /scan_asset_authority_failed/,
    );
    expect(await stored(kit, stale)).toBeNull();
    const photo = await planFor(kit, f, 'admin');
    const pending = await build(kit, photo, f.candidate, extra);
    await run(kit.env.DB, 'UPDATE member_photos SET version = ? WHERE pass_id = ?', [
      'other',
      f.candidate.pass.id,
    ]);
    await run(kit.env.DB, 'UPDATE member_photos SET version = ? WHERE pass_id = ?', [
      f.candidate.assetPhoto!.version,
      f.candidate.pass.id,
    ]);
    const current = await candidateById(kit.env.DB, kit.org.id, f.candidate.pass.id);
    expect(current?.assetPhoto).toEqual(f.candidate.assetPhoto);
    expect(current?.pass.imageGeneration).toBeGreaterThan(f.candidate.pass.imageGeneration);
    await expect(kit.env.DB.batch(pending.statements)).rejects.toThrow(
      /scan_asset_authority_failed/,
    );
    expect(await stored(kit, photo)).toBeNull();
  });
});
