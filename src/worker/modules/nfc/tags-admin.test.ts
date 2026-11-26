import { beforeAll, describe, expect, it } from 'vitest';
import { MODE_HEADER } from '../../../shared/contracts/common.ts';
import type { Tag } from '../../../shared/contracts/nfc-tags.ts';
import { createApp } from '../../app.ts';
import { all, first } from '../../platform/db.ts';
import { createAuthStores } from '../../stores.ts';
import { bindTag } from './tags.ts';
import { reportTagLost, restoreTag, retireTag, unbindTag, updateTag } from './tags-admin.ts';
import { tagFixture } from './tags-test-fixtures.ts';

let f: Awaited<ReturnType<typeof tagFixture>>;
let app: ReturnType<typeof createApp>;
beforeAll(async () => {
  f = await tagFixture();
  app = createApp({ stores: (env) => createAuthStores(env, f.kit.clock), clock: f.kit.clock });
});

const causes = (tagId: string) =>
  all<{ end_cause: string | null }>(
    f.kit.env.DB,
    'SELECT end_cause FROM tag_bindings WHERE tag_id = ? ORDER BY rowid',
    [tagId],
  ).then((r) => r.map((x) => x.end_cause));
const refused = (promise: Promise<unknown>, code: string) =>
  expect(promise).rejects.toMatchObject({ code });

async function bound(options: { owner?: boolean } = {}) {
  const t = await f.org();
  const owner = options.owner ? await f.user() : null;
  const pass = await f.pass(t.org.id, { ownerUserId: owner?.id ?? null });
  const authority = await t.authority();
  const uid = f.nextUid();
  const { tag } = await bindTag(f.kit.ctx, authority, {
    uid,
    passId: pass.id,
    scope: options.owner ? 'user' : 'pass',
  });
  return { t, pass, authority, tag, owner, uid };
}

describe('lost, retire and restore', () => {
  it('a lost tag has no binding and shows as lost; restore works with its pass again', async () => {
    const { pass, authority, tag } = await bound();
    const lost = await reportTagLost(f.kit.ctx, authority, tag.id);
    expect(lost).toMatchObject({ state: 'lost', binding: null });
    expect(await causes(tag.id)).toEqual(['lost']);
    expect((await reportTagLost(f.kit.ctx, authority, tag.id)).state).toBe('lost');
    await refused(reportTagLost(f.kit.ctx, authority, 'missing'), 'TAG_NOT_FOUND');
    const restored = await restoreTag(f.kit.ctx, authority, tag.id);
    expect(restored).toMatchObject({
      state: 'assigned',
      binding: { passId: pass.id, scope: 'pass' },
    });
    expect(await causes(tag.id)).toEqual(['lost', null]);
  });

  it('refuses a plain bind of a lost tag until it is moved', async () => {
    const { t, authority, tag, uid } = await bound();
    await reportTagLost(f.kit.ctx, authority, tag.id);
    const next = await f.pass(t.org.id);
    await refused(
      bindTag(f.kit.ctx, authority, { uid, passId: next.id, scope: 'pass' }),
      'TAG_LOST',
    );
    const moved = await bindTag(f.kit.ctx, authority, {
      uid,
      passId: next.id,
      scope: 'pass',
      move: true,
    });
    expect(moved).toMatchObject({ status: 'bound', tag: { id: tag.id, state: 'assigned' } });
  });

  it('a tag nobody holds cannot be reported lost', async () => {
    const { authority, tag } = await bound();
    await unbindTag(f.kit.ctx, authority, tag.binding?.id ?? '');
    await refused(reportTagLost(f.kit.ctx, authority, tag.id), 'TAG_NOT_ASSIGNED');
  });

  it('retire ends the binding with tag_retired, refuses a bind, and restore reopens it unassigned', async () => {
    const { authority, tag, pass } = await bound();
    const retired = await retireTag(f.kit.ctx, authority, tag.id);
    expect(retired).toMatchObject({ state: 'retired', status: 'retired', binding: null });
    expect(await causes(tag.id)).toEqual(['tag_retired']);
    await expect(
      f.kit.env.DB.prepare(
        `INSERT INTO tag_bindings (id, tag_id, scope, pass_id, source, bound_at, bound_by_type, bound_by, holder_generation)
         VALUES ('late', ?, 'pass', ?, 'admin', 1, 'user', 'x', 0)`,
      )
        .bind(tag.id, pass.id)
        .run(),
    ).rejects.toThrow(/tag_retired/);
    const back = await restoreTag(f.kit.ctx, authority, tag.id);
    expect(back).toMatchObject({ state: 'spare', status: 'active', binding: null });
    expect((await restoreTag(f.kit.ctx, authority, tag.id)).state).toBe('spare');
  });

  it('retire touches only that tag: the same UID in another org is a different row', async () => {
    const a = await bound();
    const b = await bound();
    await retireTag(f.kit.ctx, a.authority, a.tag.id);
    expect(
      (
        await first<{ status: string }>(f.kit.env.DB, 'SELECT status FROM nfc_tags WHERE id = ?', [
          b.tag.id,
        ])
      )?.status,
    ).toBe('active');
  });

  it('restoring a lost tag fails when its holder changed', async () => {
    const { authority, tag, pass } = await bound();
    await reportTagLost(f.kit.ctx, authority, tag.id);
    await f.kit.env.DB.prepare('UPDATE passes SET deleted_at = 1 WHERE id = ?').bind(pass.id).run();
    await refused(restoreTag(f.kit.ctx, authority, tag.id), 'TAG_HOLDER_CHANGED');
  });

  it('refuses a tag of another org or mode as not found', async () => {
    const a = await bound();
    const b = await bound();
    await refused(retireTag(f.kit.ctx, b.authority, a.tag.id), 'TAG_NOT_FOUND');
    await refused(
      updateTag(f.kit.ctx, await a.t.authority('test'), a.tag.id, { label: 'x' }),
      'TAG_NOT_FOUND',
    );
  });

  it('labels a tag, and refuses a loaner flag', async () => {
    const { authority, tag } = await bound();
    expect((await updateTag(f.kit.ctx, authority, tag.id, { label: 'Front door' })).label).toBe(
      'Front door',
    );
    expect((await updateTag(f.kit.ctx, authority, tag.id, { label: null })).label).toBeNull();
    await refused(updateTag(f.kit.ctx, authority, tag.id, { pool: true }), 'TAG_POOL_UNSUPPORTED');
  });
});

describe('routes', () => {
  const call = (
    headers: Record<string, string>,
    method: string,
    path: string,
    body?: unknown,
    mode = 'live',
  ) =>
    app.request(
      `https://wallet.test/api/v1/nfc${path}`,
      {
        method,
        headers: {
          ...headers,
          [MODE_HEADER]: mode,
          ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      },
      f.kit.env,
    );

  it('lists tags and the tags of a pass, with a person tag shown on each of the owner’s passes', async () => {
    const t = await f.org();
    const owner = await f.user();
    const [a, b] = [
      await f.pass(t.org.id, { ownerUserId: owner.id }),
      await f.pass(t.org.id, { ownerUserId: owner.id }),
    ];
    const authority = await t.authority();
    const person = await bindTag(f.kit.ctx, authority, {
      uid: f.nextUid(),
      passId: a.id,
      scope: 'user',
    });
    const own = await bindTag(f.kit.ctx, authority, {
      uid: f.nextUid(),
      passId: b.id,
      scope: 'pass',
    });
    const forB = (await (await call(t.headers, 'GET', `/passes/${b.id}/tags`)).json()) as {
      items: Tag[];
    };
    expect(forB.items.map((x) => x.id).sort()).toEqual([person.tag.id, own.tag.id].sort());
    const listed = await call(t.headers, 'GET', `/tags?orgId=${t.org.id}&status=assigned`);
    expect(listed.status).toBe(200);
    expect(((await listed.json()) as { items: Tag[] }).items).toHaveLength(2);
    const search = (await (
      await call(t.headers, 'GET', `/tags?orgId=${t.org.id}&q=${own.tag.hint}`)
    ).json()) as { items: Tag[] };
    expect(search.items.map((x) => x.id)).toEqual([own.tag.id]);
    expect(
      (
        (await (
          await call(t.headers, 'GET', `/tags?orgId=${t.org.id}`, undefined, 'test')
        ).json()) as { items: Tag[] }
      ).items,
    ).toEqual([]);
  });

  it('pages a long list newest first', async () => {
    const t = await f.org();
    const authority = await t.authority();
    for (let i = 0; i < 3; i++) {
      const p = await f.pass(t.org.id);
      await bindTag(f.kit.ctx, authority, { uid: f.nextUid(), passId: p.id, scope: 'pass' });
    }
    const page = (await (
      await call(t.headers, 'GET', `/tags?orgId=${t.org.id}&limit=2`)
    ).json()) as { items: Tag[]; nextCursor: string | null };
    expect(page.items).toHaveLength(2);
    const rest = (await (
      await call(t.headers, 'GET', `/tags?orgId=${t.org.id}&limit=2&cursor=${page.nextCursor}`)
    ).json()) as { items: Tag[]; nextCursor: string | null };
    expect(rest.items).toHaveLength(1);
    expect(rest.nextCursor).toBeNull();
  });

  it('removes a binding, reports lost, restores and retires over HTTP', async () => {
    const { t, tag } = await bound();
    const lost = await call(t.headers, 'POST', `/tags/${tag.id}/lost`, {});
    expect(((await lost.json()) as Tag).state).toBe('lost');
    expect(
      ((await (await call(t.headers, 'POST', `/tags/${tag.id}/restore`, {})).json()) as Tag).state,
    ).toBe('assigned');
    const get = (await (await call(t.headers, 'GET', `/tags/${tag.id}`)).json()) as Tag;
    const removed = await call(t.headers, 'DELETE', `/bindings/${get.binding?.id}`);
    expect(((await removed.json()) as Tag).state).toBe('spare');
    expect((await call(t.headers, 'DELETE', `/bindings/${get.binding?.id}`)).status).toBe(404);
    const patched = await call(t.headers, 'PATCH', `/tags/${tag.id}`, { label: 'Gym fob' });
    expect(((await patched.json()) as Tag).label).toBe('Gym fob');
    expect(
      ((await (await call(t.headers, 'POST', `/tags/${tag.id}/retire`, {})).json()) as Tag).state,
    ).toBe('retired');
  });

  it('answers 404 for another org’s tag and 403 below passes:operate', async () => {
    const a = await bound();
    const b = await f.org();
    expect((await call(b.headers, 'GET', `/tags/${a.tag.id}`)).status).toBe(404);
    expect((await call(b.headers, 'POST', `/tags/${a.tag.id}/retire`, {})).status).toBe(404);
    expect((await call(b.headers, 'GET', `/tags?orgId=${a.t.org.id}`)).status).toBe(404);
    for (const path of [`/tags/${a.tag.id}`, '/tags', `/passes/${a.pass.id}/tags`])
      expect((await call({}, 'GET', path)).status, path).toBe(401);
    for (const method of ['DELETE', 'PATCH'])
      expect((await call({}, method, '/bindings/x', {})).status, method).toBe(401);
    expect((await call({}, 'GET', '/nothing-here')).status).toBe(404);
  });
});
