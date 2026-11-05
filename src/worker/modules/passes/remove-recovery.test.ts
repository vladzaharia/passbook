import { beforeAll, describe, expect, it } from 'vitest';
import { fakeAuth } from '../../../../test/helpers/index.ts';
import { createApp } from '../../app.ts';
import { first, run } from '../../platform/db.ts';
import { removePass, restorePass } from './remove.ts';
import { getPass } from './repo.ts';
import { claimRestore, getRemoval, reinstateRemoval, removalVersion } from './repo-remove.ts';
import { type Kit, setupKit } from './test-kit.ts';

const ORIGIN = 'https://wallet.test';
const fake = fakeAuth(ORIGIN);
let kit: Kit;
let app: ReturnType<typeof createApp>;
const actor = { type: 'user' as const, id: null };

beforeAll(async () => {
  kit = await setupKit();
  app = createApp({ stores: fake.stores });
});

const versions = async (id: string) =>
  (
    await first<{ n: number }>(
      kit.env.DB,
      'SELECT count(*) AS n FROM pass_versions WHERE pass_id = ?',
      [id],
    )
  )?.n;

describe('remove after a crash between the claim and the publish', () => {
  it('publishes the removal version on the next remove, once', async () => {
    const pass = await kit.pass();
    // The claim landed, the publish never ran.
    await run(
      kit.env.DB,
      "UPDATE passes SET removed_at = ?, removal_message = 'Moved', removal_prior_status = 'active' WHERE id = ?",
      [kit.clock.now(), pass.id],
    );
    expect(await removalVersion(kit.env.DB, pass.id)).toBeNull();
    const out = await removePass(kit.ctx, actor, pass.id, {}, null);
    expect(out.status).toBe('voided');
    expect(await removalVersion(kit.env.DB, pass.id)).toBe(2);
    // A third remove changes nothing.
    await removePass(kit.ctx, actor, pass.id, {}, null);
    expect(await versions(pass.id)).toBe(2);
  });
});

describe('restore claims the removal', () => {
  it('only one of two concurrent restores publishes', async () => {
    const pass = await kit.pass();
    await removePass(kit.ctx, actor, pass.id, {}, null);
    const before = await versions(pass.id);
    await Promise.all([
      restorePass(kit.ctx, actor, pass.id, null),
      restorePass(kit.ctx, actor, pass.id, null),
    ]);
    expect(await versions(pass.id)).toBe((before ?? 0) + 1);
    expect((await getPass(kit.env.DB, pass.id))?.removedAt).toBeNull();
  });

  it('claimRestore matches the removal it read; a newer removal survives', async () => {
    const pass = await kit.pass();
    await removePass(kit.ctx, actor, pass.id, {}, null);
    const first = await getRemoval(kit.env.DB, pass.id);
    expect(first).not.toBeNull();
    if (!first) return;
    expect(await claimRestore(kit.env.DB, pass.id, first.at)).toBe(true);
    // Removed again before the first restore's rollback runs.
    await run(
      kit.env.DB,
      "UPDATE passes SET removed_at = ?, removal_prior_status = 'active' WHERE id = ?",
      [first.at + 1000, pass.id],
    );
    expect(await claimRestore(kit.env.DB, pass.id, first.at)).toBe(false);
    await reinstateRemoval(kit.env.DB, pass.id, first);
    expect((await getRemoval(kit.env.DB, pass.id))?.at).toBe(first.at + 1000);
  });

  it('a failed restore puts the removal back', async () => {
    const pass = await kit.pass();
    await removePass(kit.ctx, actor, pass.id, { message: 'Bye' }, null);
    await run(
      kit.env.DB,
      "CREATE TRIGGER versions_block BEFORE INSERT ON pass_versions BEGIN SELECT RAISE(ABORT, 'blocked'); END",
    );
    try {
      await expect(restorePass(kit.ctx, actor, pass.id, null)).rejects.toThrow();
    } finally {
      await run(kit.env.DB, 'DROP TRIGGER versions_block');
    }
    expect((await getRemoval(kit.env.DB, pass.id))?.message).toBe('Bye');
  });

  it('the app route restores once', async () => {
    const pass = await kit.pass();
    await removePass(kit.ctx, actor, pass.id, {}, null);
    const res = await app.request(
      `${ORIGIN}/api/v1/passes/${pass.id}/restore`,
      {
        method: 'POST',
        headers: { ...fake.admin(), 'content-type': 'application/json' },
        body: '{}',
      },
      kit.env,
    );
    expect(res.status).toBe(200);
  });
});

describe('removal progress after the ledger is purged', () => {
  it('reads the removal version from the version row', async () => {
    const pass = await kit.pass();
    await removePass(kit.ctx, actor, pass.id, {}, null);
    await run(kit.env.DB, "DELETE FROM pass_events WHERE pass_id = ? AND kind = 'pass.removed'", [
      pass.id,
    ]);
    const res = await app.request(
      `${ORIGIN}/api/v1/passes/${pass.id}/devices`,
      { headers: fake.admin() },
      kit.env,
    );
    const body = (await res.json()) as { removal: { version: number } | null };
    expect(body.removal?.version).toBe(2);
  });
});

describe('versions carry their source', () => {
  it('lists remove and restore on the detail', async () => {
    const pass = await kit.pass();
    await removePass(kit.ctx, actor, pass.id, {}, null);
    await restorePass(kit.ctx, actor, pass.id, null);
    const res = await app.request(
      `${ORIGIN}/api/v1/passes/${pass.id}`,
      { headers: fake.admin() },
      kit.env,
    );
    const body = (await res.json()) as { versions: { version: number; source: string | null }[] };
    expect(body.versions.map((v) => [v.version, v.source]).sort()).toEqual([
      [1, null],
      [2, 'remove'],
      [3, 'restore'],
    ]);
  });
});

describe('the list filters removed passes', () => {
  it('status=removed lists them and status=voided leaves them out', async () => {
    const removed = await kit.pass();
    const voided = await kit.pass();
    await removePass(kit.ctx, actor, removed.id, {}, null);
    await app.request(
      `${ORIGIN}/api/v1/passes/${voided.id}/void`,
      {
        method: 'POST',
        headers: { ...fake.admin(), 'content-type': 'application/json' },
        body: '{}',
      },
      kit.env,
    );
    const ids = async (status: string) =>
      (
        (await (
          await app.request(
            `${ORIGIN}/api/v1/passes?limit=200&status=${status}`,
            { headers: fake.admin() },
            kit.env,
          )
        ).json()) as { items: { id: string }[] }
      ).items.map((p) => p.id);
    const gone = await ids('removed');
    expect(gone).toContain(removed.id);
    expect(gone).not.toContain(voided.id);
    const v = await ids('voided');
    expect(v).toContain(voided.id);
    expect(v).not.toContain(removed.id);
  });
});
