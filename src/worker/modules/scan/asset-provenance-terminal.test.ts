import { beforeAll, describe, expect, it, vi } from 'vitest';
import type { ScanManifest } from '../../../passkit/types.ts';
import { run } from '../../platform/db.ts';
import { ensureCredentialRefKeyset } from '../passes/credential-keyset.ts';
import { putMemberPhoto } from '../passes/member-photo.ts';
import { memberPhoto } from '../passes/repo-member-photo.ts';
import { makePng } from '../templates/package/fixtures.ts';
import { assetActorFor, observeCancellation } from './asset-test-fixtures.ts';
import { assetGrantValid, mintAssetGrant } from './assets.ts';
import { candidateById } from './repo-lookup.ts';
import { type ScanKit, setupScanKit } from './test-kit.ts';

const system = { type: 'system' as const, id: null };
const photoBytes = makePng(270, 270);
const encodedPhoto = btoa(String.fromCharCode(...photoBytes));
const scan: ScanManifest = {
  actions: [{ id: 'check_in', label: 'Check in', kind: 'check_in' }],
  display: { v: 1, header: {}, photo: { minRole: 'door' } },
};
let kit: ScanKit, templateId: string;
beforeAll(async () => {
  kit = await setupScanKit();
  await ensureCredentialRefKeyset(kit.env.DB, kit.env);
  templateId = await kit.scanTemplate('Asset capability provenance', scan);
});
async function expectMissing(response: Response) {
  expect(response.status).toBe(404);
  expect(await response.json()).toMatchObject({ code: 'ASSET_NOT_FOUND' });
}

describe('scanner asset capability provenance', () => {
  it('fences a terminal NULL-CSRF credential through the post-open fence', async () => {
    const terminal = await kit.scanner({ kind: 'terminal', templateIds: [templateId] });
    const actor = await assetActorFor(kit, terminal);
    const pass = await kit.scanPass(templateId);
    await putMemberPhoto(
      kit.ctx,
      system,
      pass.id,
      { png: encodedPhoto, includeInPass: false },
      null,
    );
    const candidate = await candidateById(kit.env.DB, kit.org.id, pass.id);
    const photo = await memberPhoto(kit.env.DB, kit.org.id, pass.id);
    if (!candidate || !photo) throw new Error('Terminal photo fixture missing');
    expect(actor.scannerCsrfProof).toBeNull();
    const token = await mintAssetGrant(
      kit.ctx,
      actor,
      candidate,
      candidate.connectionGeneration,
      candidate.activeTemplateVersion,
      undefined,
      true,
      'commit',
    );
    expect(
      await assetGrantValid(
        kit.ctx,
        actor,
        candidate,
        candidate.connectionGeneration,
        token,
        undefined,
        'commit',
        true,
      ),
    ).toBe(true);
    const originalGet = kit.env.BUCKET.get.bind(kit.env.BUCKET);
    let opened = false;
    let cancelled = 0;
    const spy = vi.spyOn(kit.env.BUCKET, 'get').mockImplementation(async (key, options) => {
      const object = await originalGet(key, options);
      if (key !== photo.r2_key || !object) return object;
      opened = true;
      // A terminal never has a CSRF secret (CHECK constraint); its credential moves by token.
      await run(
        kit.env.DB,
        'UPDATE scanners SET token_hash=?, updated_at=updated_at+1 WHERE id=?',
        ['f'.repeat(64), terminal.id],
      );
      return observeCancellation(object, () => cancelled++);
    });
    let response: Response;
    try {
      response = await kit.get(terminal.headers, `/passes/${pass.id}/assets/member.png?g=${token}`);
    } finally {
      spy.mockRestore();
    }
    expect(opened).toBe(true);
    expect(cancelled).toBe(1);
    await expectMissing(response);
    expect(
      await assetGrantValid(
        kit.ctx,
        actor,
        candidate,
        candidate.connectionGeneration,
        token,
        undefined,
        'commit',
        true,
      ),
    ).toBe(false);
  });
});
