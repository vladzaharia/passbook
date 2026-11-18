import { beforeAll, describe, expect, it } from 'vitest';
import { all, first, run } from '../../platform/db.ts';
import { tagRef } from './tag-ref.ts';
import { bindTag } from './tags.ts';
import { tagFixture } from './tags-test-fixtures.ts';

let f: Awaited<ReturnType<typeof tagFixture>>;
beforeAll(async () => {
  f = await tagFixture();
});

const active = (tagId: string) =>
  all<{ id: string; scope: string; pass_id: string }>(
    f.kit.env.DB,
    'SELECT id, scope, pass_id FROM tag_bindings WHERE tag_id = ? AND ended_at IS NULL',
    [tagId],
  );
const refused = async (promise: Promise<unknown>, code: string) =>
  expect(promise).rejects.toMatchObject({ code });

describe('bindTag', () => {
  it('creates the tag and binds it to a pass, storing a ref and a hint but never the UID', async () => {
    const t = await f.org();
    const pass = await f.pass(t.org.id);
    const uid = f.nextUid();
    const { status, tag } = await bindTag(f.kit.ctx, await t.authority(), {
      uid,
      passId: pass.id,
      scope: 'pass',
    });
    expect(status).toBe('bound');
    expect(tag).toMatchObject({ kind: 'uid', assurance: 'basic', state: 'assigned' });
    expect(tag.binding).toMatchObject({ scope: 'pass', passId: pass.id, boundByName: null });
    const { ref, hint } = await tagRef(f.kit.env, t.org.id, 'live', uid);
    const row = await first<{ tag_ref: string; hint: string }>(
      f.kit.env.DB,
      'SELECT tag_ref, hint FROM nfc_tags WHERE id = ?',
      [tag.id],
    );
    expect(row).toEqual({ tag_ref: ref, hint });
    const stored = JSON.stringify(
      await all(f.kit.env.DB, 'SELECT * FROM nfc_tags WHERE id = ?', [tag.id]),
    );
    expect(stored).not.toContain(uid);
    expect(
      (
        await first<{ n: number }>(
          f.kit.env.DB,
          "SELECT count(*) AS n FROM audit_log WHERE action = 'tag.bind' AND target_id = ?",
          [tag.id],
        )
      )?.n,
    ).toBe(1);
  });

  it('is off until the org turns tags on', async () => {
    const t = await f.org({ enabled: false });
    const pass = await f.pass(t.org.id);
    await refused(
      bindTag(f.kit.ctx, await t.authority(), { uid: f.nextUid(), passId: pass.id, scope: 'pass' }),
      'TAGS_OFF',
    );
  });

  it('answers already_bound without a write, and replaces for the same holder', async () => {
    const t = await f.org();
    const owner = await f.user();
    const a = await f.pass(t.org.id, { ownerUserId: owner.id });
    const b = await f.pass(t.org.id, { ownerUserId: owner.id });
    const authority = await t.authority();
    const uid = f.nextUid();
    const first1 = await bindTag(f.kit.ctx, authority, { uid, passId: a.id, scope: 'pass' });
    expect((await bindTag(f.kit.ctx, authority, { uid, passId: a.id, scope: 'pass' })).status).toBe(
      'already_bound',
    );
    const second = await bindTag(f.kit.ctx, authority, { uid, passId: b.id, scope: 'pass' });
    expect(second.status).toBe('replaced');
    expect((await active(first1.tag.id)).map((r) => r.pass_id)).toEqual([b.id]);
    const ended = await first<{ end_cause: string }>(
      f.kit.env.DB,
      'SELECT end_cause FROM tag_bindings WHERE tag_id = ? AND ended_at IS NOT NULL',
      [first1.tag.id],
    );
    expect(ended?.end_cause).toBe('replaced');
    expect((await bindTag(f.kit.ctx, authority, { uid, passId: b.id, scope: 'user' })).status).toBe(
      'replaced',
    );
  });

  it('refuses another holder unless the tag is moved', async () => {
    const t = await f.org();
    const [a, b] = [await f.pass(t.org.id), await f.pass(t.org.id)];
    const authority = await t.authority();
    const uid = f.nextUid();
    const bound = await bindTag(f.kit.ctx, authority, { uid, passId: a.id, scope: 'pass' });
    await refused(
      bindTag(f.kit.ctx, authority, { uid, passId: b.id, scope: 'pass' }),
      'TAG_HELD_BY_OTHER',
    );
    const moved = await bindTag(f.kit.ctx, authority, {
      uid,
      passId: b.id,
      scope: 'pass',
      move: true,
    });
    expect(moved.status).toBe('moved');
    expect((await active(bound.tag.id)).map((r) => r.pass_id)).toEqual([b.id]);
  });

  it('commits one of two concurrent binds of the same tag', async () => {
    const t = await f.org();
    const [a, b] = [await f.pass(t.org.id), await f.pass(t.org.id)];
    const authority = await t.authority();
    const uid = f.nextUid();
    const results = await Promise.allSettled([
      bindTag(f.kit.ctx, authority, { uid, passId: a.id, scope: 'pass' }),
      bindTag(f.kit.ctx, authority, { uid, passId: b.id, scope: 'pass' }),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const lost = results.find((r) => r.status === 'rejected');
    expect(lost).toMatchObject({ reason: { code: 'TAG_HELD_BY_OTHER' } });
    const { ref } = await tagRef(f.kit.env, t.org.id, 'live', uid);
    const tags = await all<{ id: string }>(
      f.kit.env.DB,
      'SELECT id FROM nfc_tags WHERE tag_ref = ?',
      [ref],
    );
    expect(tags).toHaveLength(1);
    expect(await active(tags[0]?.id ?? '')).toHaveLength(1);
  });

  it('keeps a test tag and a live tag of one UID apart', async () => {
    const t = await f.org();
    const [live, test] = [await f.pass(t.org.id), await f.pass(t.org.id, { mode: 'test' })];
    const uid = f.nextUid();
    const a = await bindTag(f.kit.ctx, await t.authority('live'), {
      uid,
      passId: live.id,
      scope: 'pass',
    });
    const b = await bindTag(f.kit.ctx, await t.authority('test'), {
      uid,
      passId: test.id,
      scope: 'pass',
    });
    expect(a.tag.id).not.toBe(b.tag.id);
    expect(a.tag.hint).not.toBe('');
    await refused(
      bindTag(f.kit.ctx, await t.authority('live'), {
        uid: f.nextUid(),
        passId: test.id,
        scope: 'pass',
      }),
      'PASS_NOT_FOUND',
    );
  });
});

describe('limits', () => {
  it('allows 4 tags per pass and refuses the 5th', async () => {
    const t = await f.org();
    const pass = await f.pass(t.org.id);
    const authority = await t.authority();
    for (let i = 0; i < 4; i++)
      await bindTag(f.kit.ctx, authority, { uid: f.nextUid(), passId: pass.id, scope: 'pass' });
    await refused(
      bindTag(f.kit.ctx, authority, { uid: f.nextUid(), passId: pass.id, scope: 'pass' }),
      'TAG_BINDING_LIMIT',
    );
  });

  it('allows 4 tags per person in an org and mode and refuses the 5th', async () => {
    const t = await f.org();
    const owner = await f.user();
    const passes = [
      await f.pass(t.org.id, { ownerUserId: owner.id }),
      await f.pass(t.org.id, { ownerUserId: owner.id }),
    ];
    const authority = await t.authority();
    for (let i = 0; i < 4; i++)
      await bindTag(f.kit.ctx, authority, {
        uid: f.nextUid(),
        passId: passes[i % 2]?.id ?? '',
        scope: 'user',
      });
    await refused(
      bindTag(f.kit.ctx, authority, {
        uid: f.nextUid(),
        passId: passes[0]?.id ?? '',
        scope: 'user',
      }),
      'TAG_BINDING_LIMIT',
    );
    // Pass bindings count apart from user bindings.
    await bindTag(f.kit.ctx, authority, {
      uid: f.nextUid(),
      passId: passes[0]?.id ?? '',
      scope: 'pass',
    });
  });
});

describe('user scope', () => {
  it('is refused for a waiting pass and for a pass the user does not own', async () => {
    const t = await f.org();
    const owner = await f.user();
    const other = await f.user();
    const waiting = await f.pass(t.org.id, { holderEmail: 'wait@example.com' });
    await refused(
      bindTag(f.kit.ctx, await t.authority(), {
        uid: f.nextUid(),
        passId: waiting.id,
        scope: 'user',
      }),
      'TAG_NO_ACCOUNT',
    );
    // The trigger refuses what the service would not offer.
    const owned = await f.pass(t.org.id, { ownerUserId: owner.id });
    const { ref, hint } = await tagRef(f.kit.env, t.org.id, 'live', f.nextUid());
    await run(
      f.kit.env.DB,
      "INSERT INTO nfc_tags (id, org_id, mode, tag_ref, kind, hint, created_at) VALUES ('raw-1', ?, 'live', ?, 'uid', ?, 1)",
      [t.org.id, ref, hint],
    );
    const insert = (user: string, pass: string) =>
      run(
        f.kit.env.DB,
        `INSERT INTO tag_bindings (id, tag_id, scope, pass_id, user_id, source, bound_at, bound_by_type, bound_by)
         VALUES (?, 'raw-1', 'user', ?, ?, 'admin', 1, 'user', 'x')`,
        [`b-${user}-${pass}`.slice(0, 40), pass, user],
      );
    await expect(insert(other.id, owned.id)).rejects.toThrow(/tag_binding_owner/);
    await expect(insert(other.id, waiting.id)).rejects.toThrow(/tag_binding_owner/);
    await insert(owner.id, owned.id);
  });

  it('refuses a binding across orgs and modes, and to a retired tag', async () => {
    const a = await f.org();
    const b = await f.org();
    const passB = await f.pass(b.org.id);
    const testPass = await f.pass(a.org.id, { mode: 'test' });
    const { ref, hint } = await tagRef(f.kit.env, a.org.id, 'live', f.nextUid());
    await run(
      f.kit.env.DB,
      "INSERT INTO nfc_tags (id, org_id, mode, tag_ref, kind, hint, created_at) VALUES ('raw-2', ?, 'live', ?, 'uid', ?, 1)",
      [a.org.id, ref, hint],
    );
    const insert = (pass: string) =>
      run(
        f.kit.env.DB,
        `INSERT INTO tag_bindings (id, tag_id, scope, pass_id, source, bound_at, bound_by_type, bound_by)
         VALUES (?, 'raw-2', 'pass', ?, 'admin', 1, 'user', 'x')`,
        [`b-${pass}`.slice(0, 40), pass],
      );
    await expect(insert(passB.id)).rejects.toThrow(/tag_binding_tenant/);
    await expect(insert(testPass.id)).rejects.toThrow(/tag_binding_tenant/);
    await run(f.kit.env.DB, "UPDATE nfc_tags SET status = 'retired' WHERE id = 'raw-2'");
    await expect(insert((await f.pass(a.org.id)).id)).rejects.toThrow(/tag_retired/);
  });

  it('refuses a sun tag until a later package opens it', async () => {
    const t = await f.org();
    const { ref, hint } = await tagRef(f.kit.env, t.org.id, 'live', f.nextUid());
    await expect(
      run(
        f.kit.env.DB,
        "INSERT INTO nfc_tags (id, org_id, mode, tag_ref, kind, hint, created_at) VALUES ('raw-3', ?, 'live', ?, 'sun', ?, 1)",
        [t.org.id, ref, hint],
      ),
    ).rejects.toThrow(/tag_kind_unsupported/);
  });
});
