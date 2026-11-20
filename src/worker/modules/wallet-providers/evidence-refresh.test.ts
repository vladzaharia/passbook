// M4: the refresh job selects only what still matters, so dead rows never hold back live heads.
import { describe, expect, it } from 'vitest';
import { run } from '../../platform/db.ts';
import { setupSamsungCallbacks } from './callbacks-test-fixtures.ts';
import { selectExpiringSamsungEvidence } from './repo-samsung-evidence-refresh.ts';

type Kit = Awaited<ReturnType<typeof setupSamsungCallbacks>>;

async function expireAt(t: Kit, at: number) {
  const id = t.samsungRelease?.candidateId;
  if (!id) throw new Error('Missing candidate');
  await run(
    t.kit.env.DB,
    'UPDATE wallet_provider_projection_evidence SET verified_at = ?, expires_at = ? WHERE candidate_id = ?',
    [at - 300_000, at, id],
  );
  return id;
}

describe('the evidence refresh selection', () => {
  it('skips suspended orgs and rotated accounts, so a live head is selected with a limit of one', async () => {
    const dead = await setupSamsungCallbacks();
    const rotated = await setupSamsungCallbacks();
    const live = await setupSamsungCallbacks();
    const now = live.kit.clock.now();
    const deadId = await expireAt(dead, 1_000);
    const rotatedId = await expireAt(rotated, 1_500);
    const liveId = await expireAt(live, 2_000);
    await run(dead.kit.env.DB, "UPDATE orgs SET status = 'suspended' WHERE id = ?", [
      dead.kit.org.id,
    ]);
    await run(
      rotated.kit.env.DB,
      'UPDATE wallet_provider_accounts SET authority_epoch = authority_epoch + 1 WHERE id = ?',
      [rotated.operation.accountId],
    );
    const picked = await selectExpiringSamsungEvidence(live.kit.env.DB, now, 1);
    expect(picked.map((c) => c.id)).toEqual([liveId]);
    const all = (await selectExpiringSamsungEvidence(live.kit.env.DB, now, 50)).map((c) => c.id);
    expect(all).toContain(liveId);
    expect(all).not.toContain(deadId);
    expect(all).not.toContain(rotatedId);
  });
});
