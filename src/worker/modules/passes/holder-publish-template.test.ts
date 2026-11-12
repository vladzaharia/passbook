// The device (holder) publish grant re-signs only while the pass's template is not deleted.
import { beforeAll, describe, expect, it } from 'vitest';
import { run } from '../../platform/db.ts';
import { devicePrincipal } from '../apple/repo-credential.ts';
import { type Kit, setupKit } from './pass-test-fixtures.ts';
import type { Pass } from './repo.ts';
import { getPass } from './repo-read-pass.ts';
import { casConnector } from './repo-write-publish-connector.ts';

let kit: Kit;
beforeAll(async () => {
  kit = await setupKit();
});

const holderWrite = (pass: Pass) =>
  casConnector(kit.ctx, {
    id: pass.id,
    expectedVersion: pass.version,
    expectedPass: {
      ...pass,
      imageGeneration: 0,
      credentialKeysetCommitment: '',
      credentialRefs: [],
      removalMessage: null,
      removalPriorStatus: null,
      removalPublishedGeneration: null,
    },
    release: undefined,
    requireNoReleaseHistory: false,
    set: { next_sync_at: null },
    bumpVersion: true,
    holder: devicePrincipal(pass),
  });

const setStatus = (status: string) =>
  run(kit.env.DB, 'UPDATE templates SET status = ? WHERE id = ?', [status, kit.template.id]);

describe('holder publish grant and template status', () => {
  it('commits on an active and on an archived template', async () => {
    const active = await kit.pass();
    expect(await holderWrite(active)).toBe(active.version + 1);
    const archived = await kit.pass();
    await setStatus('archived');
    try {
      expect(await holderWrite(archived)).toBe(archived.version + 1);
    } finally {
      await setStatus('active');
    }
  });

  it('is refused on a deleted template and leaves the pass as it was', async () => {
    const pass = await kit.pass();
    await setStatus('deleted');
    try {
      expect(await holderWrite(pass)).toBeNull();
    } finally {
      await setStatus('active');
    }
    expect((await getPass(kit.env.DB, pass.id))?.version).toBe(pass.version);
  });
});
