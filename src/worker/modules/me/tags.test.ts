import { beforeAll, describe, expect, it } from 'vitest';
import { expectProblem } from '../../../../test/helpers/denial.ts';
import { makeSession } from '../../../../test/helpers/index.ts';
import type { MyTag } from '../../../shared/contracts/me.ts';
import { createApp } from '../../app.ts';
import { denyAllStores } from '../../platform/auth.ts';
import { first, run } from '../../platform/db.ts';
import { createSessionStore } from '../auth/sessions.ts';
import { fakeLimiter } from '../auth/test-support.ts';
import { jobCtxOf } from '../delivery/delivery-test-fixtures.ts';
import { getHolderPass } from '../holders/repo.ts';
import { bindTag } from '../nfc/tags.ts';
import { restoreTag } from '../nfc/tags-admin.ts';
import { tagFixture } from '../nfc/tags-test-fixtures.ts';
import { startCredentialTransfer } from '../passes/credential-transfer.ts';
import { insertType } from '../scan/tags-policy-test-fixtures.ts';

let f: Awaited<ReturnType<typeof tagFixture>>;
let app: ReturnType<typeof createApp>;
beforeAll(async () => {
  f = await tagFixture({ releases: true });
  app = createApp({
    clock: f.kit.clock,
    stores: { ...denyAllStores, sessions: createSessionStore(f.kit.env, f.kit.clock) },
  });
});

const call = (path: string, headers: Record<string, string>, method = 'GET') =>
  app.request(`https://wallet.test/api/v1/me${path}`, { method, headers }, f.kit.env);

type Listed = { items: { id: string; tags: MyTag[] }[] };
async function tagsOf(headers: Record<string, string>, passId: string): Promise<MyTag[]> {
  const res = await call('/passes', headers);
  expect(res.status).toBe(200);
  return ((await res.json()) as Listed).items.find((p) => p.id === passId)?.tags ?? [];
}

/** An org with a holder who owns two passes in it, and an admin authority. */
async function setup() {
  const t = await f.org();
  const owner = await f.user();
  const session = await makeSession(f.kit.fx, { userId: owner.id });
  const pass = await f.kit.pass({ orgId: t.org.id, holderEmail: owner.primaryEmail });
  const second = await f.kit.pass({ orgId: t.org.id, holderEmail: owner.primaryEmail });
  for (const p of [pass, second])
    await run(f.kit.env.DB, 'UPDATE passes SET owner_user_id = ? WHERE id = ?', [owner.id, p.id]);
  return { t, owner, headers: session.headers, pass, second, authority: await t.authority() };
}

const bind = async (s: Awaited<ReturnType<typeof setup>>, passId: string, scope: 'pass' | 'user') =>
  (await bindTag(f.kit.ctx, s.authority, { uid: f.nextUid(), passId, scope })).tag;

describe('tags on my passes', () => {
  it('lists pass tags on their pass and account-wide tags on every pass of the org', async () => {
    const s = await setup();
    const own = await bind(s, s.pass.id, 'pass');
    const wide = await bind(s, s.second.id, 'user');
    const first = await tagsOf(s.headers, s.pass.id);
    expect(first.map((t) => [t.id, t.scope]).sort()).toEqual(
      [
        [own.id, 'pass'],
        [wide.id, 'user'],
      ].sort(),
    );
    expect((await tagsOf(s.headers, s.second.id)).map((t) => t.id)).toEqual([wide.id]);
    expect(first[0]).toEqual({
      id: expect.any(String),
      label: null,
      hint: expect.stringMatching(/^[0-9A-F]{4}$/),
      scope: expect.any(String),
      boundAt: expect.any(Number),
      lostAt: null,
    });
  });

  it('shows no tag data to another holder, and none of another org', async () => {
    const s = await setup();
    const mine = await bind(s, s.pass.id, 'pass');
    await bind(s, s.second.id, 'user');
    const other = await setup();
    const theirs = await bind(other, other.pass.id, 'pass');
    const res = await call('/passes', other.headers);
    const text = await res.text();
    expect(text).toContain(theirs.id);
    expect(text).not.toContain(mine.id);
    // The same person's passes in a second org carry only that org's account-wide tags.
    const t2 = await f.org();
    const here = await f.kit.pass({ orgId: t2.org.id, holderEmail: s.owner.primaryEmail });
    await run(f.kit.env.DB, 'UPDATE passes SET owner_user_id = ? WHERE id = ?', [
      s.owner.id,
      here.id,
    ]);
    expect(await tagsOf(s.headers, here.id)).toEqual([]);
    expect((await tagsOf(s.headers, s.pass.id)).length).toBe(2);
  });
});

describe('report lost', () => {
  it('refuses a lent tag: it belongs to the desk', async () => {
    const s = await setup();
    const typeId = await insertType(f.kit, s.t.org.id, { use: 'visitor', scopes: 'pass' });
    const { tag } = await bindTag(f.kit.ctx, s.authority, {
      uid: f.nextUid(),
      passId: s.pass.id,
      scope: 'pass',
      typeId,
    });
    const res = await call(`/tags/${tag.id}/lost`, s.headers, 'POST');
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({
      code: 'TAG_LENT',
      detail: 'This tag belongs to the desk. Hand it back there.',
    });
    const row = await first<{ lost_at: number | null }>(
      f.kit.env.DB,
      'SELECT lost_at FROM nfc_tags WHERE id = ?',
      [tag.id],
    );
    expect(row?.lost_at).toBeNull();
    expect((await tagsOf(s.headers, s.pass.id)).map((t) => t.id)).toEqual([tag.id]);
  });

  it('ends a pass binding, marks the tag, audits it, and lists it as lost', async () => {
    const s = await setup();
    const tag = await bind(s, s.pass.id, 'pass');
    const res = await call(`/tags/${tag.id}/lost`, s.headers, 'POST');
    expect(res.status).toBe(200);
    const row = await first<{ lost_at: number | null; lost_by: string | null }>(
      f.kit.env.DB,
      'SELECT lost_at, lost_by FROM nfc_tags WHERE id = ?',
      [tag.id],
    );
    expect(row).toEqual({ lost_at: expect.any(Number), lost_by: s.owner.id });
    expect(
      await first(
        f.kit.env.DB,
        "SELECT 1 FROM audit_log WHERE action = 'tag.lost' AND target_id = ? AND actor_id = ?",
        [tag.id, s.owner.id],
      ),
    ).not.toBeNull();
    const [listed] = await tagsOf(s.headers, s.pass.id);
    expect(listed).toMatchObject({ id: tag.id, lostAt: row?.lost_at });
    // A retry is the same answer.
    expect((await call(`/tags/${tag.id}/lost`, s.headers, 'POST')).status).toBe(200);
  });

  it('ends a user binding through its anchor pass, and an admin can restore it', async () => {
    const s = await setup();
    const tag = await bind(s, s.second.id, 'user');
    expect((await call(`/tags/${tag.id}/lost`, s.headers, 'POST')).status).toBe(200);
    for (const id of [s.pass.id, s.second.id])
      expect((await tagsOf(s.headers, id)).map((t) => [t.id, t.lostAt !== null])).toEqual([
        [tag.id, true],
      ]);
    const restored = await restoreTag(f.kit.ctx, s.authority, tag.id);
    expect(restored.state).toBe('assigned');
    expect((await tagsOf(s.headers, s.pass.id)).map((t) => t.lostAt)).toEqual([null]);
  });

  it('drops a lost tag from the list after 30 days', async () => {
    const s = await setup();
    const tag = await bind(s, s.pass.id, 'pass');
    await call(`/tags/${tag.id}/lost`, s.headers, 'POST');
    await run(f.kit.env.DB, 'UPDATE nfc_tags SET lost_at = ? WHERE id = ?', [
      f.kit.clock.now() - 31 * 86_400_000,
      tag.id,
    ]);
    expect(await tagsOf(s.headers, s.pass.id)).toEqual([]);
  });

  it('is refused for a tag that is not the caller’s', async () => {
    const s = await setup();
    const theirs = await setup();
    const pass = await bind(theirs, theirs.pass.id, 'pass');
    const wide = await bind(theirs, theirs.second.id, 'user');
    for (const tag of [pass, wide])
      await expectProblem(
        await call(`/tags/${tag.id}/lost`, s.headers, 'POST'),
        404,
        'TAG_NOT_FOUND',
      );
    const stillBound = await first<{ n: number }>(
      f.kit.env.DB,
      'SELECT count(*) AS n FROM tag_bindings WHERE ended_at IS NULL AND tag_id IN (?, ?)',
      [pass.id, wide.id],
    );
    expect(stillBound?.n).toBe(2);
    await expectProblem(
      await call(`/tags/${crypto.randomUUID()}/lost`, s.headers, 'POST'),
      404,
      'TAG_NOT_FOUND',
    );
    expect((await call(`/tags/${pass.id}/lost`, {}, 'POST')).status).toBe(401);
  });

  it('does not answer a new owner’s retry for a tag the old holder lost', async () => {
    const s = await setup();
    const tag = await bind(s, s.pass.id, 'pass');
    expect((await call(`/tags/${tag.id}/lost`, s.headers, 'POST')).status).toBe(200);
    const next = await f.user();
    const nextSession = await makeSession(f.kit.fx, { userId: next.id });
    const expected = await getHolderPass(f.kit.env.DB, s.pass.id, null);
    if (!expected) throw new Error('Missing pass');
    const moved = await startCredentialTransfer(
      jobCtxOf(f.kit),
      { type: 'system', id: null },
      s.pass.id,
      { holderEmail: next.primaryEmail, ownerUserId: next.id },
      null,
      { kind: 'tenant-holder', expected },
    );
    expect(moved.state).toBe('completed');
    await expectProblem(
      await call(`/tags/${tag.id}/lost`, nextSession.headers, 'POST'),
      404,
      'TAG_NOT_FOUND',
    );
  });

  it('is rate limited per holder', async () => {
    const s = await setup();
    const tag = await bind(s, s.pass.id, 'pass');
    const limited = createApp({
      clock: f.kit.clock,
      stores: { ...denyAllStores, sessions: createSessionStore(f.kit.env, f.kit.clock) },
    });
    const env = { ...f.kit.env, RL_REFRESH: fakeLimiter(1) as unknown as RateLimit };
    const post = () =>
      limited.request(
        `https://wallet.test/api/v1/me/tags/${tag.id}/lost`,
        { method: 'POST', headers: s.headers },
        env,
      );
    expect((await post()).status).toBe(200);
    expect((await post()).status).toBe(429);
  });
});

describe('a lost end without an actor', () => {
  it('is refused, so a tag is never left unmarked', async () => {
    const s = await setup();
    const tag = await bind(s, s.pass.id, 'pass');
    await expect(
      run(
        f.kit.env.DB,
        "UPDATE tag_bindings SET ended_at = 1, end_cause = 'lost' WHERE tag_id = ? AND ended_at IS NULL",
        [tag.id],
      ),
    ).rejects.toThrow(/tag_lost_needs_actor/);
  });
});
