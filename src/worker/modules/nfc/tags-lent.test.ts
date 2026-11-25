import { beforeAll, describe, expect, it } from 'vitest';
import { first, run } from '../../platform/db.ts';
import { insertType, type TypeSpec } from '../scan/tags-policy-test-fixtures.ts';
import { listTags, tagView } from './repo-tags.ts';
import { bindTag } from './tags.ts';
import { unbindTag } from './tags-admin.ts';
import { tagFixture } from './tags-test-fixtures.ts';

let f: Awaited<ReturnType<typeof tagFixture>>;
beforeAll(async () => {
  f = await tagFixture({ releases: true });
});

const refused = (promise: Promise<unknown>, code: string) =>
  expect(promise).rejects.toMatchObject({ code });

/** A fresh org with a loaner type (pass scope), a member type, and a pass. */
async function setup(loaner: TypeSpec = {}) {
  const t = await f.org();
  const visitor = await insertType(f.kit, t.org.id, { use: 'visitor', scopes: 'pass', ...loaner });
  const member = await insertType(f.kit, t.org.id, { use: 'member', perPass: 2 });
  const pass = await f.pass(t.org.id);
  return { t, visitor, member, pass, authority: await t.authority() };
}
const lend = async (s: Awaited<ReturnType<typeof setup>>, passId = s.pass.id) =>
  (
    await bindTag(f.kit.ctx, s.authority, {
      uid: f.nextUid(),
      passId,
      scope: 'pass',
      typeId: s.visitor,
    })
  ).tag;
const view = (s: Awaited<ReturnType<typeof setup>>, id: string) =>
  tagView(f.kit.env.DB, s.t.org.id, 'live', id);
const bindingOf = (tagId: string) =>
  first<{ end_cause: string | null; ended_by: string | null; ended_by_type: string | null }>(
    f.kit.env.DB,
    'SELECT end_cause, ended_by, ended_by_type FROM tag_bindings WHERE tag_id = ? ORDER BY rowid DESC',
    [tagId],
  );
const listed = async (
  s: Awaited<ReturnType<typeof setup>>,
  status: 'lent' | 'assigned' | 'spare',
) =>
  (await listTags(f.kit.env.DB, { orgId: s.t.org.id, mode: 'live', status, limit: 50 })).items.map(
    (t) => t.id,
  );

describe('lending a tag', () => {
  it('a tag of a visitor type is a loaner: pool, lent binding, state lent', async () => {
    const s = await setup();
    const tag = await lend(s);
    expect(tag).toMatchObject({
      pool: true,
      state: 'lent',
      binding: { lent: true, scope: 'pass' },
    });
    expect(await listed(s, 'lent')).toEqual([tag.id]);
    expect(await listed(s, 'assigned')).toEqual([]);
  });

  it('a tag of any other type is not: assigned, not pool, never in the lent filter', async () => {
    const s = await setup();
    const own = (
      await bindTag(f.kit.ctx, s.authority, {
        uid: f.nextUid(),
        passId: s.pass.id,
        scope: 'pass',
        typeId: s.member,
      })
    ).tag;
    const plain = (
      await bindTag(f.kit.ctx, s.authority, {
        uid: f.nextUid(),
        passId: s.pass.id,
        scope: 'pass',
        typeId: s.member,
      })
    ).tag;
    for (const t of [own, plain])
      expect(t).toMatchObject({ pool: false, state: 'assigned', binding: { lent: false } });
    expect(await listed(s, 'lent')).toEqual([]);
    expect((await listed(s, 'assigned')).sort()).toEqual([own.id, plain.id].sort());
  });

  it('the desk return ends the binding and the tag is a spare loaner again', async () => {
    const s = await setup();
    const tag = await lend(s);
    await unbindTag(f.kit.ctx, s.authority, tag.binding?.id ?? '');
    expect(await view(s, tag.id)).toMatchObject({ pool: true, state: 'spare', binding: null });
    expect(await listed(s, 'lent')).toEqual([]);
    expect(await listed(s, 'spare')).toEqual([tag.id]);
  });

  it('history keeps lent on the ended binding', async () => {
    const s = await setup();
    const tag = await lend(s);
    await run(f.kit.env.DB, "UPDATE passes SET status = 'voided' WHERE id = ?", [s.pass.id]);
    const { tagBindingHistory } = await import('./repo-tag-history.ts');
    const { items } = await tagBindingHistory(f.kit.env.DB, tag.id, 10);
    expect(items[0]).toMatchObject({ lent: true, endCause: 'pass_ended' });
  });
});

describe('a lent tag opens this pass only', () => {
  it('refuses person scope for a loaner, even on an older type that allows both', async () => {
    const t = await f.org();
    const owner = await f.user();
    const legacy = await insertType(f.kit, t.org.id, { use: 'visitor', scopes: 'both' });
    const pass = await f.pass(t.org.id, { ownerUserId: owner.id });
    await refused(
      bindTag(f.kit.ctx, await t.authority(), {
        uid: f.nextUid(),
        passId: pass.id,
        scope: 'user',
        typeId: legacy,
      }),
      'TAG_TYPE_SCOPE',
    );
    const rows = await first<{ n: number }>(
      f.kit.env.DB,
      'SELECT count(*) AS n FROM tag_bindings WHERE pass_id = ?',
      [pass.id],
    );
    expect(rows?.n).toBe(0);
  });

  it('a pass-only type refuses person scope too', async () => {
    const t = await f.org();
    const owner = await f.user();
    const visitor = await insertType(f.kit, t.org.id, { use: 'visitor', scopes: 'pass' });
    const pass = await f.pass(t.org.id, { ownerUserId: owner.id });
    await refused(
      bindTag(f.kit.ctx, await t.authority(), {
        uid: f.nextUid(),
        passId: pass.id,
        scope: 'user',
        typeId: visitor,
      }),
      'TAG_TYPE_SCOPE',
    );
  });
});

describe('a lent tag ends with its pass', () => {
  it('void ends the binding as pass_ended by the system, and the tag is spare', async () => {
    const s = await setup();
    const tag = await lend(s);
    await run(f.kit.env.DB, "UPDATE passes SET status = 'voided' WHERE id = ?", [s.pass.id]);
    expect(await bindingOf(tag.id)).toEqual({
      end_cause: 'pass_ended',
      ended_by: 'passes',
      ended_by_type: 'system',
    });
    expect(await view(s, tag.id)).toMatchObject({ state: 'spare', binding: null });
  });

  it('remove ends it the same way', async () => {
    const s = await setup();
    const tag = await lend(s);
    await run(f.kit.env.DB, 'UPDATE passes SET removed_at = ? WHERE id = ?', [
      f.kit.clock.now(),
      s.pass.id,
    ]);
    expect(await bindingOf(tag.id)).toMatchObject({ end_cause: 'pass_ended' });
    expect(await view(s, tag.id)).toMatchObject({ state: 'spare' });
  });

  it('void leaves a member tag on the same pass alone, and no lost mark is set', async () => {
    const s = await setup();
    const loaner = await lend(s);
    const own = (
      await bindTag(f.kit.ctx, s.authority, {
        uid: f.nextUid(),
        passId: s.pass.id,
        scope: 'pass',
        typeId: s.member,
      })
    ).tag;
    const standard = (
      await bindTag(f.kit.ctx, s.authority, { uid: f.nextUid(), passId: s.pass.id, scope: 'pass' })
    ).tag;
    await run(f.kit.env.DB, "UPDATE passes SET status = 'voided' WHERE id = ?", [s.pass.id]);
    expect((await bindingOf(loaner.id))?.end_cause).toBe('pass_ended');
    expect((await bindingOf(own.id))?.end_cause).toBeNull();
    expect((await bindingOf(standard.id))?.end_cause).toBeNull();
    expect(
      (
        await first<{ lost_at: number | null }>(
          f.kit.env.DB,
          'SELECT lost_at FROM nfc_tags WHERE id = ?',
          [loaner.id],
        )
      )?.lost_at,
    ).toBeNull();
  });
});

describe('tenant isolation', () => {
  it("another org's loaner is not in this org's lists or views, and its pass voiding does not touch ours", async () => {
    const a = await setup();
    const b = await setup();
    const mine = await lend(a);
    const theirs = await lend(b);
    expect(await listed(a, 'lent')).toEqual([mine.id]);
    expect(await view(a, theirs.id)).toBeNull();
    await run(f.kit.env.DB, "UPDATE passes SET status = 'voided' WHERE id = ?", [b.pass.id]);
    expect((await bindingOf(theirs.id))?.end_cause).toBe('pass_ended');
    expect((await bindingOf(mine.id))?.end_cause).toBeNull();
    expect(await listed(a, 'lent')).toEqual([mine.id]);
  });

  it("another org's visitor type cannot make a loaner here", async () => {
    const a = await setup();
    const b = await setup();
    await refused(
      bindTag(f.kit.ctx, a.authority, {
        uid: f.nextUid(),
        passId: a.pass.id,
        scope: 'pass',
        typeId: b.visitor,
      }),
      'TAG_TYPE_NOT_FOUND',
    );
  });
});
