import { beforeAll, describe, expect, it } from 'vitest';
import type { Tag, TagBinding } from '../../../shared/contracts/nfc-tags.ts';
import { first, run } from '../../platform/db.ts';
import { type EnrollFixture, enrollFixture } from '../scan/tags-enroll-test-fixtures.ts';

let f: EnrollFixture;
beforeAll(async () => {
  f = await enrollFixture();
});

const db = () => f.kit.env.DB;
const body = async <T>(r: Response) => (await r.json()) as T;
const code = async (r: Response) => (await body<{ code: string }>(r)).code;
const audits = async (action: string, targetId: string) =>
  (
    await first<{ n: number }>(
      db(),
      'SELECT count(*) AS n FROM audit_log WHERE action = ? AND target_id = ?',
      [action, targetId],
    )
  )?.n;
const activeCount = async (tagId: string) =>
  (
    await first<{ n: number }>(
      db(),
      'SELECT count(*) AS n FROM tag_bindings WHERE tag_id = ? AND ended_at IS NULL',
      [tagId],
    )
  )?.n;

/** A tag bound on a scanner, by the person or by the pass. */
async function bound(options: { owner?: boolean; binding?: 'pass' | 'user' } = {}) {
  const desk = await f.desk({ tags: { assign: 'desk', assignAll: 'desk' } });
  const p = await f.pass({ owner: options.owner ?? false });
  const read = f.read();
  const response = await f.bind(desk, {
    binding: options.binding ?? 'pass',
    tag: read,
    card: p.card,
  });
  expect(response.status, await response.clone().text()).toBe(200);
  const { bindingId } = await body<{ bindingId: string }>(response);
  const tagId = (
    await first<{ tag_id: string }>(db(), 'SELECT tag_id FROM tag_bindings WHERE id = ?', [
      bindingId,
    ])
  )?.tag_id;
  if (!tagId) throw new Error('No tag.');
  return { ...p, bindingId, tagId, read };
}

/** Another pass of the same owner. */
async function secondPass(ownerId: string | null) {
  const owner = await first<{ primary_email: string }>(
    db(),
    'SELECT primary_email FROM users WHERE id = ?',
    [ownerId],
  );
  const pass = await f.kit.scanPass(f.tpl, {}, { holderEmail: owner?.primary_email ?? null });
  await run(db(), 'UPDATE passes SET owner_user_id = ? WHERE id = ?', [ownerId, pass.id]);
  return pass;
}

const change = (bindingId: string, req: object, who = f.operator) =>
  f.nfc(who.headers, 'PATCH', `/bindings/${bindingId}`, req);

describe('change what a tag works with', () => {
  it('widens a pass tag to the holder, and narrows a person tag to the pass', async () => {
    const b = await bound({ owner: true });
    const wide = await change(b.bindingId, { binding: 'user' });
    expect(wide.status, await wide.clone().text()).toBe(200);
    const tag = await body<Tag>(wide);
    expect(tag.binding).toMatchObject({
      scope: 'user',
      userId: b.ownerId,
      holderName: 'Jane Owner',
    });
    expect(tag.binding?.id).not.toBe(b.bindingId);
    expect(await activeCount(b.tagId)).toBe(1);
    const ended = await first<{ end_cause: string }>(
      db(),
      'SELECT end_cause FROM tag_bindings WHERE id = ?',
      [b.bindingId],
    );
    expect(ended?.end_cause).toBe('replaced');
    expect(await audits('tag.rebind', b.tagId)).toBe(1);

    // Narrow to a second pass of the same owner, then to the anchor when none is named.
    const second = await secondPass(b.ownerId);
    const narrow = await change(tag.binding?.id ?? '', { binding: 'pass', passId: second.id });
    expect(narrow.status, await narrow.clone().text()).toBe(200);
    const narrowed = await body<Tag>(narrow);
    expect(narrowed.binding).toMatchObject({ scope: 'pass', passId: second.id });
    expect(await audits('tag.rebind', b.tagId)).toBe(2);
    const wideAgain = await body<Tag>(
      await change(narrowed.binding?.id ?? '', { binding: 'user' }),
    );
    const anchor = await change(wideAgain.binding?.id ?? '', { binding: 'pass' });
    expect((await body<Tag>(anchor)).binding).toMatchObject({ scope: 'pass' });
  });

  it('needs a holder account to widen, refuses another holder’s pass, and leaves an unchanged scope alone', async () => {
    const b = await bound();
    const noAccount = await change(b.bindingId, { binding: 'user' });
    expect(noAccount.status).toBe(422);
    expect(await code(noAccount)).toBe('TAG_NO_ACCOUNT');
    const other = await f.pass();
    const held = await change(b.bindingId, { binding: 'pass', passId: other.pass.id });
    expect(held.status).toBe(409);
    expect(await code(held)).toBe('TAG_HELD_BY_OTHER');
    const same = await change(b.bindingId, { binding: 'pass' });
    expect(same.status).toBe(200);
    expect((await body<Tag>(same)).binding?.id).toBe(b.bindingId);
    expect(await audits('tag.rebind', b.tagId)).toBe(0);
  });

  it('checks the capability, the org and that the binding is still active', async () => {
    const b = await bound({ owner: true });
    expect((await change(b.bindingId, { binding: 'user' }, f.reader)).status).toBe(403);
    expect((await change(b.bindingId, { binding: 'user' }, f.stranger)).status).toBe(404);
    expect((await f.nfc({}, 'PATCH', `/bindings/${b.bindingId}`, { binding: 'user' })).status).toBe(
      401,
    );
    expect(
      (
        await f.nfc(
          f.operator.headers,
          'PATCH',
          `/bindings/${b.bindingId}`,
          { binding: 'user' },
          'test',
        )
      ).status,
    ).toBe(404);
    expect((await change(b.bindingId, { binding: 'everyone' })).status).toBe(422);
    expect((await f.nfc(f.operator.headers, 'DELETE', `/bindings/${b.bindingId}`)).status).toBe(
      200,
    );
    expect((await change(b.bindingId, { binding: 'user' })).status).toBe(404);
    expect(await activeCount(b.tagId)).toBe(0);
  });
});

describe('undo on remove', () => {
  const remove = (bindingId: string, who = f.operator) =>
    f.nfc(who.headers, 'DELETE', `/bindings/${bindingId}`);
  const put = (
    passId: string,
    tagId: string,
    binding: 'pass' | 'user' = 'pass',
    who = f.operator,
  ) => f.nfc(who.headers, 'POST', `/passes/${passId}/tags`, { tagId, binding });

  it('puts a removed tag back within ten minutes, once', async () => {
    const b = await bound();
    expect((await remove(b.bindingId)).status).toBe(200);
    f.kit.clock.advance(9 * 60_000);
    const back = await put(b.pass.id, b.tagId);
    expect(back.status, await back.clone().text()).toBe(200);
    const tag = await body<Tag>(back);
    expect(tag).toMatchObject({ id: b.tagId, state: 'assigned' });
    expect(tag.binding).toMatchObject({ scope: 'pass', passId: b.pass.id, source: 'admin' });
    // A second Undo finds the tag where it was.
    expect((await put(b.pass.id, b.tagId)).status).toBe(200);
    expect(await activeCount(b.tagId)).toBe(1);
    expect(await audits('tag.bind', b.tagId)).toBe(2);
  });

  it('puts a person tag back for the same person, on whichever of their passes the admin is on', async () => {
    const b = await bound({ owner: true, binding: 'user' });
    expect((await remove(b.bindingId)).status).toBe(200);
    const back = await put(b.pass.id, b.tagId, 'user');
    expect(back.status, await back.clone().text()).toBe(200);
    expect((await body<Tag>(back)).binding).toMatchObject({ scope: 'user', userId: b.ownerId });
  });

  it('refuses after ten minutes, for another admin, for another pass, and when the tag was not removed', async () => {
    const b = await bound();
    expect((await remove(b.bindingId)).status).toBe(200);
    const elsewhere = await f.pass();
    const wrongPass = await put(elsewhere.pass.id, b.tagId);
    expect(wrongPass.status).toBe(403);
    expect(await code(wrongPass)).toBe('TAG_UNDO_EXPIRED');
    const other = await f.member(f.kit.org.id, ['pass_operator']);
    expect(await code(await put(b.pass.id, b.tagId, 'pass', other))).toBe('TAG_UNDO_EXPIRED');
    f.kit.clock.advance(10 * 60_000 + 1);
    const late = await put(b.pass.id, b.tagId);
    expect(late.status).toBe(403);
    expect(await code(late)).toBe('TAG_UNDO_EXPIRED');
    expect(await activeCount(b.tagId)).toBe(0);
  });

  it('is refused when the tag meanwhile went to someone else', async () => {
    const b = await bound();
    expect((await remove(b.bindingId)).status).toBe(200);
    const desk = await f.desk();
    const taker = await f.pass();
    const res = await f.bind(desk, { binding: 'pass', tag: b.read, card: taker.card });
    expect(res.status).toBe(200);
    const back = await put(b.pass.id, b.tagId);
    expect(back.status).toBe(409);
    expect(await code(back)).toBe('TAG_ALREADY_ASSIGNED');
  });

  it('checks the capability and the org', async () => {
    const b = await bound();
    expect((await remove(b.bindingId)).status).toBe(200);
    expect((await put(b.pass.id, b.tagId, 'pass', f.reader)).status).toBe(403);
    expect((await put(b.pass.id, b.tagId, 'pass', f.stranger)).status).toBe(404);
    expect((await put(b.pass.id, b.tagId, 'pass', f.outsider)).status).toBe(404);
    expect(
      (await f.nfc({}, 'POST', `/passes/${b.pass.id}/tags`, { tagId: b.tagId, binding: 'pass' }))
        .status,
    ).toBe(401);
    expect((await put(b.pass.id, 'no-such-tag')).status).toBe(404);
    const strangerPass = await f.pass();
    expect((await put(strangerPass.pass.id, b.tagId, 'pass', f.stranger)).status).toBe(404);
  });
});

describe('history', () => {
  beforeAll(async () => {
    await run(db(), "UPDATE users SET name = 'Pat Operator' WHERE id = ?", [f.operator.user.id]);
  });

  it('lists every binding newest first, ended ones too, and the changes to the tag', async () => {
    const b = await bound({ owner: true });
    const wide = await body<Tag>(await change(b.bindingId, { binding: 'user' }));
    expect(
      (await f.nfc(f.operator.headers, 'DELETE', `/bindings/${wide.binding?.id}`)).status,
    ).toBe(200);
    expect(
      (await f.nfc(f.operator.headers, 'PATCH', `/tags/${b.tagId}`, { label: 'Spare' })).status,
    ).toBe(200);
    expect((await f.nfc(f.operator.headers, 'POST', `/tags/${b.tagId}/retire`)).status).toBe(200);
    for (const who of [f.operator, f.reader]) {
      const res = await f.nfc(who.headers, 'GET', `/tags/${b.tagId}/history`);
      expect(res.status).toBe(200);
      const page = await body<{
        items: TagBinding[];
        nextCursor: string | null;
        events: { action: string; actorName: string | null }[];
      }>(res);
      expect(page.items.map((i) => [i.scope, i.endCause])).toEqual([
        ['user', 'admin'],
        ['pass', 'replaced'],
      ]);
      expect(page.items[1]).toMatchObject({
        id: b.bindingId,
        source: 'scanner',
        endedAt: expect.any(Number),
      });
      expect(page.nextCursor).toBeNull();
      expect(page.events.map((e) => e.action).sort()).toEqual(['retire', 'update']);
      expect(page.events[0]?.actorName).toBe('Pat Operator');
    }
  });

  it('pages, and answers another org or mode as not found', async () => {
    const b = await bound();
    expect((await f.nfc(f.stranger.headers, 'GET', `/tags/${b.tagId}/history`)).status).toBe(404);
    expect((await f.nfc(f.outsider.headers, 'GET', `/tags/${b.tagId}/history`)).status).toBe(404);
    expect(
      (await f.nfc(f.operator.headers, 'GET', `/tags/${b.tagId}/history`, undefined, 'test'))
        .status,
    ).toBe(404);
    expect((await f.nfc(f.operator.headers, 'GET', '/tags/nope/history')).status).toBe(404);
    expect((await f.nfc({}, 'GET', `/tags/${b.tagId}/history`)).status).toBe(401);
    const res = await body<{ items: unknown[]; nextCursor: string | null }>(
      await f.nfc(f.operator.headers, 'GET', `/tags/${b.tagId}/history?cursor=1`),
    );
    expect(res.items).toEqual([]);
  });
});

describe('a user’s tags', () => {
  it('lists person tags and pass tags of the user’s passes, with the org', async () => {
    const owned = await bound({ owner: true, binding: 'user' });
    await secondPass(owned.ownerId);
    const named = await f.nfc(
      f.operator.headers,
      'GET',
      `/users/${owned.ownerId}/tags?orgId=${f.kit.org.id}`,
    );
    expect(named.status).toBe(200);
    const page = await body<{ items: (Tag & { orgId: string; orgName: string })[] }>(named);
    expect(page.items.map((t) => t.id)).toContain(owned.tagId);
    expect(page.items[0]).toMatchObject({ orgId: f.kit.org.id, orgName: expect.any(String) });
    const open = await body<{ items: Tag[] }>(
      await f.nfc(f.reader.headers, 'GET', `/users/${owned.ownerId}/tags`),
    );
    expect(open.items.map((t) => t.id)).toContain(owned.tagId);
  });

  it('includes tags bound to one of the user’s passes', async () => {
    const owned = await bound({ owner: true });
    const res = await body<{ items: Tag[] }>(
      await f.nfc(f.operator.headers, 'GET', `/users/${owned.ownerId}/tags?orgId=${f.kit.org.id}`),
    );
    expect(res.items.map((t) => t.id)).toEqual([owned.tagId]);
    expect(res.items[0]?.binding?.scope).toBe('pass');
  });

  it('shows another org’s caller nothing, and a named org the caller is not in is a 404', async () => {
    const owned = await bound({ owner: true, binding: 'user' });
    const q = (who: typeof f.operator, orgId = '') =>
      f.nfc(who.headers, 'GET', `/users/${owned.ownerId}/tags${orgId ? `?orgId=${orgId}` : ''}`);
    expect(await body<{ items: unknown[] }>(await q(f.stranger))).toEqual({
      items: [],
      nextCursor: null,
    });
    expect(await body<{ items: unknown[] }>(await q(f.outsider))).toEqual({
      items: [],
      nextCursor: null,
    });
    expect((await q(f.stranger, f.kit.org.id)).status).toBe(404);
    expect((await q(f.outsider, f.kit.org.id)).status).toBe(404);
    expect(
      (await f.nfc(f.operator.headers, 'GET', `/users/${owned.ownerId}/tags`, undefined, 'test'))
        .status,
    ).toBe(200);
    expect(
      (
        await body<{ items: unknown[] }>(
          await f.nfc(f.operator.headers, 'GET', `/users/${owned.ownerId}/tags`, undefined, 'test'),
        )
      ).items,
    ).toEqual([]);
    expect((await f.nfc({}, 'GET', `/users/${owned.ownerId}/tags`)).status).toBe(401);
  });
});
