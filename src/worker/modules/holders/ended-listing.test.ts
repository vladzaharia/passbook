// An ended pass waiting for its holder's address is listed read-only: sign-in never transfers it.
import { describe, expect, it } from 'vitest';
import { first, run } from '../../platform/db.ts';
import { signInMagicLink } from '../auth/service.ts';
import { jobCtxOf } from '../delivery/delivery-test-fixtures.ts';
import { listMyPasses } from '../me/service.ts';
import { setupKit } from '../passes/pass-test-fixtures.ts';

const sign = { ipPrefix: null, userAgent: null };
const email = () => `ended-${Math.random().toString(36).slice(2)}@example.test`;
const row = (db: D1Database, id: string) =>
  first<{ owner_user_id: string | null; download_token: string; link_generation: number }>(
    db,
    'SELECT owner_user_id, download_token, link_generation FROM passes WHERE id = ?',
    [id],
  );

describe('an ended pass before the first sign-in', () => {
  it('lists read-only after sign-in, with its link, devices and bundles untouched', async () => {
    const kit = await setupKit();
    const e = email();
    const live = await kit.pass({ holderEmail: e });
    const ended = await kit.pass({ holderEmail: e });
    await run(kit.env.DB, "UPDATE passes SET status = 'voided' WHERE id = ?", [ended.id]);
    const before = await row(kit.env.DB, ended.id);
    const ctx = jobCtxOf(kit);
    const { userId } = await signInMagicLink(ctx, e, sign);
    const after = await row(kit.env.DB, ended.id);
    expect(after).toEqual(before);
    expect(after?.owner_user_id).toBeNull();
    expect((await row(kit.env.DB, live.id))?.owner_user_id).toBe(userId);
    const mine = await listMyPasses(ctx, userId, { limit: 50 });
    const listed = mine.items.find((p) => p.id === ended.id);
    expect(listed).toMatchObject({ readOnly: true, status: 'voided', downloadUrl: null });
    expect(mine.items.find((p) => p.id === live.id)?.readOnly).toBe(false);
    for (const t of ['registrations', 'bundle_passes']) {
      const n = await first<{ n: number }>(
        kit.env.DB,
        `SELECT COUNT(*) AS n FROM ${t} WHERE pass_id = ?`,
        [ended.id],
      );
      expect(n?.n).toBe(0);
    }
  });

  it('lists a removed pass only once its removal is published, never a joined card', async () => {
    const kit = await setupKit();
    const e = email();
    const claimed = await kit.pass({ holderEmail: e });
    const published = await kit.pass({ holderEmail: e });
    await run(kit.env.DB, 'UPDATE passes SET removed_at = 1 WHERE id = ?', [claimed.id]);
    await run(kit.env.DB, "UPDATE passes SET status = 'voided', removed_at = 1 WHERE id = ?", [
      published.id,
    ]);
    await run(
      kit.env.DB,
      'UPDATE passes SET removal_published_generation = lifecycle_generation WHERE id = ?',
      [published.id],
    );
    const ctx = jobCtxOf(kit);
    const { userId } = await signInMagicLink(ctx, e, sign);
    const ids = (await listMyPasses(ctx, userId, { limit: 50 })).items.map((p) => p.id);
    expect(ids).toContain(published.id);
    expect(ids).not.toContain(claimed.id);
  });

  it('refuses an attach that lands between a removal claim and its publish', async () => {
    const kit = await setupKit();
    const e = email();
    const claimed = await kit.pass({ holderEmail: e });
    await run(kit.env.DB, 'UPDATE passes SET removed_at = 1 WHERE id = ?', [claimed.id]);
    const before = await row(kit.env.DB, claimed.id);
    await signInMagicLink(jobCtxOf(kit), e, sign);
    expect(await row(kit.env.DB, claimed.id)).toEqual(before);
  });
});
