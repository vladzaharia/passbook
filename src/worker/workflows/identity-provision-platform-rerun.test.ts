import { afterEach, describe, expect, it, vi } from 'vitest';
import { startPlatformProvision } from '../modules/identities/run-start.ts';
import { run } from '../platform/db.ts';
import { fakeStep, harness } from './identity-provision-test-fixtures.ts';

afterEach(() => vi.restoreAllMocks());

describe('platform provision: second run', () => {
  it('L6: reuses the half-built row key, so a lost order response is adopted and nothing is ordered twice', async () => {
    const h = await harness('root-rerun');
    await run(h.env.DB, "DELETE FROM identity_runs WHERE target_id LIKE 'platform:%'");
    await run(h.env.DB, "DELETE FROM signing_identities WHERE org_id IS NULL AND id <> 'platform'");

    h.apple.dropNext = 'createCertificate';
    const first = await startPlatformProvision(h.kit.ctx, { slot: 'root', createdBy: null });
    expect((await h.start(first.runId, fakeStep({ retries: 0 }))).state).not.toBe('succeeded');
    expect(h.apple.count('createCertificate')).toBe(1);

    const second = await startPlatformProvision(h.kit.ctx, { slot: 'root', createdBy: null });
    expect(second.runId).not.toBe(first.runId);
    expect(await h.start(second.runId)).toEqual({ state: 'succeeded' });
    expect(h.apple.count('createCertificate')).toBe(1);
  });
});
