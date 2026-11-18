import { beforeAll, describe, expect, it } from 'vitest';
import { all, first, run } from '../../platform/db.ts';
import { jobCtxOf } from '../delivery/delivery-test-fixtures.ts';
import { getHolderPass } from '../holders/repo.ts';
import { startCredentialTransfer } from '../passes/credential-transfer.ts';
import { softDeletePassGranted } from '../passes/repo-pass-grants.ts';
import { getPass } from '../passes/repo-read-pass.ts';
import { bindTag } from './tags.ts';
import { reportTagLost, restoreTag } from './tags-admin.ts';
import { tagFixture } from './tags-test-fixtures.ts';

let f: Awaited<ReturnType<typeof tagFixture>>;
beforeAll(async () => {
  f = await tagFixture({ releases: true });
});

const system = { type: 'system', id: null } as const;
const rows = (passId: string) =>
  all<{ scope: string; pass_id: string; end_cause: string | null; ended_by: string | null }>(
    f.kit.env.DB,
    'SELECT scope, pass_id, end_cause, ended_by FROM tag_bindings WHERE pass_id = ? ORDER BY bound_at, id',
    [passId],
  );

async function transfer(
  passId: string,
  target: { holderEmail: string | null; ownerUserId: string | null },
) {
  const expected = await getHolderPass(f.kit.env.DB, passId, null);
  if (!expected) throw new Error('Missing pass');
  const result = await startCredentialTransfer(jobCtxOf(f.kit), system, passId, target, null, {
    kind: 'tenant-holder',
    expected,
  });
  expect(result.state).toBe('completed');
}

/** A real pass in a fresh org; with `owner` it is attached to a person who verified its address. */
async function setup(options: { owner?: boolean } = {}) {
  const t = await f.org();
  const owner = options.owner ? await f.user() : null;
  const pass = await f.kit.pass({
    orgId: t.org.id,
    holderEmail: owner?.primaryEmail ?? 'first@example.test',
  });
  if (owner) await attach(pass.id, owner.id);
  return { t, owner, pass, authority: await t.authority() };
}

const activeCount = async (tagId: string) =>
  (
    await first<{ n: number }>(
      f.kit.env.DB,
      'SELECT count(*) AS n FROM tag_bindings WHERE tag_id = ? AND ended_at IS NULL',
      [tagId],
    )
  )?.n;

const attach = (passId: string, userId: string) =>
  run(f.kit.env.DB, 'UPDATE passes SET owner_user_id = ? WHERE id = ?', [userId, passId]);

describe('a pass binding follows its pass', () => {
  it('ends when the pass is reassigned, with the cause holder_changed', async () => {
    const { pass, authority } = await setup();
    await bindTag(f.kit.ctx, authority, { uid: f.nextUid(), passId: pass.id, scope: 'pass' });
    await transfer(pass.id, { holderEmail: 'second@example.test', ownerUserId: null });
    expect(await rows(pass.id)).toEqual([
      { scope: 'pass', pass_id: pass.id, end_cause: 'holder_changed', ended_by: 'transfer' },
    ]);
  });

  it('ends when the pass is unassigned', async () => {
    const { pass, authority } = await setup();
    await bindTag(f.kit.ctx, authority, { uid: f.nextUid(), passId: pass.id, scope: 'pass' });
    await transfer(pass.id, { holderEmail: null, ownerUserId: null });
    expect((await rows(pass.id))[0]?.end_cause).toBe('holder_changed');
  });

  it('ends on a credential transfer to the same address when the owner goes', async () => {
    const { pass, owner, authority } = await setup({ owner: true });
    await bindTag(f.kit.ctx, authority, { uid: f.nextUid(), passId: pass.id, scope: 'pass' });
    await transfer(pass.id, { holderEmail: 'first@example.test', ownerUserId: null });
    expect(owner).not.toBeNull();
    expect((await rows(pass.id))[0]?.end_cause).toBe('holder_changed');
  });

  it('is kept when a waiting pass is attached to its person, by a sign-in or by a transfer', async () => {
    for (const how of ['sign-in', 'transfer'] as const) {
      const t = await f.org();
      const owner = await f.user();
      const pass = await f.kit.pass({ orgId: t.org.id, holderEmail: owner.primaryEmail });
      const authority = await t.authority();
      await bindTag(f.kit.ctx, authority, { uid: f.nextUid(), passId: pass.id, scope: 'pass' });
      // The person already holds another pass in the org, with a tag for all their passes.
      const home = await f.pass(t.org.id, { ownerUserId: owner.id });
      const person = await bindTag(f.kit.ctx, authority, {
        uid: f.nextUid(),
        passId: home.id,
        scope: 'user',
      });
      if (how === 'sign-in') await attach(pass.id, owner.id);
      else await transfer(pass.id, { holderEmail: owner.primaryEmail, ownerUserId: owner.id });
      expect(await rows(pass.id), how).toEqual([
        { scope: 'pass', pass_id: pass.id, end_cause: null, ended_by: null },
      ]);
      expect(
        (
          await first<{ owner_user_id: string }>(
            f.kit.env.DB,
            'SELECT owner_user_id FROM passes WHERE id = ?',
            [pass.id],
          )
        )?.owner_user_id,
        how,
      ).toBe(owner.id);
      expect(await activeCount(person.tag.id), how).toBe(1);
    }
  });

  it('ends when the pass is deleted', async () => {
    const { pass, authority } = await setup();
    await bindTag(f.kit.ctx, authority, { uid: f.nextUid(), passId: pass.id, scope: 'pass' });
    const row = await getPass(f.kit.env.DB, pass.id);
    if (!row) throw new Error('Missing pass');
    expect(await softDeletePassGranted(f.kit.ctx, row, authority)).toBe(true);
    expect((await rows(pass.id))[0]?.end_cause).toBe('pass_deleted');
  });
});

describe('a user binding follows its person', () => {
  async function twoPasses() {
    const s = await setup({ owner: true });
    const second = await f.kit.pass({
      orgId: s.t.org.id,
      holderEmail: s.owner?.primaryEmail,
    });
    await attach(second.id, s.owner?.id ?? '');
    const bound = await bindTag(f.kit.ctx, s.authority, {
      uid: f.nextUid(),
      passId: s.pass.id,
      scope: 'user',
    });
    return { ...s, second, bound };
  }
  const anchor = async (tagId: string) =>
    (await first<{ pass_id: string; end_cause: string | null }>(
      f.kit.env.DB,
      'SELECT pass_id, end_cause FROM tag_bindings WHERE tag_id = ? ORDER BY bound_at DESC, id DESC',
      [tagId],
    )) ?? { pass_id: '', end_cause: null };

  it('re-anchors to the oldest other pass of the owner when the anchor changes hands, then ends no_passes', async () => {
    const { pass, second, bound } = await twoPasses();
    await transfer(pass.id, { holderEmail: 'new@example.test', ownerUserId: null });
    expect(await anchor(bound.tag.id)).toEqual({ pass_id: second.id, end_cause: null });
    await transfer(second.id, { holderEmail: 'new2@example.test', ownerUserId: null });
    const last = await anchor(bound.tag.id);
    expect(last.end_cause).toBe('no_passes');
  });

  it('stays on its anchor while the person still owns it, even if the address changes', async () => {
    const { pass, owner, bound } = await twoPasses();
    await run(
      f.kit.env.DB,
      "INSERT INTO user_emails (email, user_id, verified_via, verified_at) VALUES ('alt@example.test', ?, 'admin', 1)",
      [owner?.id ?? ''],
    );
    await transfer(pass.id, { holderEmail: 'alt@example.test', ownerUserId: owner?.id ?? null });
    expect(await anchor(bound.tag.id)).toEqual({ pass_id: pass.id, end_cause: null });
    expect((await rows(pass.id)).filter((r) => r.scope === 'pass')).toEqual([]);
  });

  it('re-anchors or ends when the anchor pass is deleted', async () => {
    const { pass, second, authority, bound } = await twoPasses();
    for (const [id, expected] of [
      [pass.id, { pass_id: second.id, end_cause: null }],
      [second.id, { pass_id: second.id, end_cause: 'no_passes' }],
    ] as const) {
      const row = await getPass(f.kit.env.DB, id);
      if (!row) throw new Error('Missing pass');
      expect(await softDeletePassGranted(f.kit.ctx, row, authority)).toBe(true);
      expect(await anchor(bound.tag.id)).toEqual(expected);
    }
  });

  it('cannot be re-anchored across org, mode or owner, or edited once ended', async () => {
    const { t, pass, owner, second, bound } = await twoPasses();
    const stranger = await f.user();
    const other = await f.org();
    const targets = {
      org: await f.pass(other.org.id, { ownerUserId: owner?.id ?? null }),
      mode: await f.pass(t.org.id, { ownerUserId: owner?.id ?? null, mode: 'test' }),
      owner: await f.pass(t.org.id, { ownerUserId: stranger.id }),
    };
    const move = (to: string) =>
      run(
        f.kit.env.DB,
        'UPDATE tag_bindings SET pass_id = ? WHERE tag_id = ? AND ended_at IS NULL',
        [to, bound.tag.id],
      );
    for (const target of Object.values(targets))
      await expect(move(target.id)).rejects.toThrow(/tag_binding_reanchor/);
    await move(second.id);
    await expect(
      run(f.kit.env.DB, "UPDATE tag_bindings SET scope = 'pass', user_id = NULL WHERE tag_id = ?", [
        bound.tag.id,
      ]),
    ).rejects.toThrow(/tag_binding_immutable/);
    await run(
      f.kit.env.DB,
      "UPDATE tag_bindings SET ended_at = 5, ended_by_type = 'user', ended_by = 'x', end_cause = 'admin' WHERE tag_id = ?",
      [bound.tag.id],
    );
    await expect(
      run(f.kit.env.DB, 'UPDATE tag_bindings SET pass_id = ? WHERE tag_id = ?', [
        pass.id,
        bound.tag.id,
      ]),
    ).rejects.toThrow(/tag_binding_immutable/);
  });
});

describe('a lost tag after the pass changed hands', () => {
  it('is not restored onto the new holder', async () => {
    const { pass, authority } = await setup();
    const { tag } = await bindTag(f.kit.ctx, authority, {
      uid: f.nextUid(),
      passId: pass.id,
      scope: 'pass',
    });
    await reportTagLost(f.kit.ctx, authority, tag.id);
    await transfer(pass.id, { holderEmail: 'second@example.test', ownerUserId: null });
    await expect(restoreTag(f.kit.ctx, authority, tag.id)).rejects.toMatchObject({
      code: 'TAG_HOLDER_CHANGED',
    });
    expect(await rows(pass.id)).toEqual([expect.objectContaining({ end_cause: 'lost' })]);
  });
});
