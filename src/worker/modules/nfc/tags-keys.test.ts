import { beforeAll, describe, expect, it } from 'vitest';
import { makeApiKey } from '../../../../test/helpers/index.ts';
import { createApp } from '../../app.ts';
import { ROLE_PRESETS } from '../../platform/api-scopes.ts';
import { all, first, run } from '../../platform/db.ts';
import { createAuthStores } from '../../stores.ts';
import type { TenantPassWrite } from '../passes/http.ts';
import {
  tenantPassAuthorityParams,
  tenantPassAuthoritySql,
  tenantPassAuthorityValid,
} from '../passes/repo-authority.ts';
import { type EnrollFixture, enrollFixture } from '../scan/tags-enroll-test-fixtures.ts';
import { insertType } from '../scan/tags-policy-test-fixtures.ts';
import { tagWriterOf } from './tags-admin.ts';
import { assignTag } from './tags-assign.ts';

const DAY = 86_400_000;
const ORIGIN = 'https://wallet.test';
let f: EnrollFixture;
let app: ReturnType<typeof createApp>;
let typeId: string;
beforeAll(async () => {
  f = await enrollFixture();
  app = createApp({ stores: (env) => createAuthStores(env, f.kit.clock), clock: f.kit.clock });
  typeId = await insertType(f.kit, f.kit.org.id, { use: 'member' });
});

const key = (scopes: string[], over: Parameters<typeof makeApiKey>[1] = {}) =>
  makeApiKey(f.kit.fx, {
    orgId: f.kit.org.id,
    scopes,
    mode: 'live',
    expiresAt: f.kit.clock.now() + 30 * DAY,
    ...over,
  });

async function call(
  k: { headers: Record<string, string> },
  method: string,
  path: string,
  body?: unknown,
) {
  const res = await app.request(
    `${ORIGIN}/api/v1/nfc${path}`,
    {
      method,
      headers: {
        ...k.headers,
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    },
    f.kit.env,
  );
  const text = await res.text();
  return { status: res.status, body: (text ? JSON.parse(text) : null) as Record<string, any> };
}

let n = 0;
async function spare(orgId = f.kit.org.id) {
  const id = `ksp-${++n}`;
  const ref = `d${n.toString(16).padStart(3, '0')}`.repeat(16);
  await run(
    f.kit.env.DB,
    `INSERT INTO nfc_tags (id, org_id, mode, tag_ref, system, type_id, hint, status, created_at)
     VALUES (?, ?, 'live', ?, 'uid', ?, ?, 'active', ?)`,
    [
      id,
      orgId,
      ref,
      orgId === f.kit.org.id ? typeId : null,
      ref.slice(0, 4).toUpperCase(),
      f.kit.clock.now(),
    ],
  );
  return id;
}
const bindingOf = (tagId: string) =>
  first<{
    id: string;
    bound_by_type: string;
    bound_by: string;
    ended_at: number | null;
    ended_by: string | null;
  }>(
    f.kit.env.DB,
    'SELECT id, bound_by_type, bound_by, ended_at, ended_by FROM tag_bindings WHERE tag_id = ? ORDER BY bound_at DESC LIMIT 1',
    [tagId],
  );

describe('tags by key', () => {
  it('reads with nfc:read and refuses a key without it', async () => {
    const { pass } = await f.pass();
    const read = await key(['nfc:read']);
    const tagId = await spare();
    const bound = await call(await key(['nfc:write']), 'POST', `/passes/${pass.id}/tags/assign`, {
      tagId,
      binding: 'pass',
    });
    expect(bound.status).toBe(200);
    expect((await call(read, 'GET', `/tags?status=spare`)).status).toBe(200);
    const one = await call(read, 'GET', `/tags/${tagId}`);
    expect(one.status).toBe(200);
    expect(one.body.id).toBe(tagId);
    expect((await call(read, 'GET', `/tags/${tagId}/history`)).status).toBe(200);
    const onPass = await call(read, 'GET', `/passes/${pass.id}/tags`);
    expect(onPass.body.items.map((t: { id: string }) => t.id)).toEqual([tagId]);
    const none = await key(['passes:read']);
    for (const path of [`/tags`, `/tags/${tagId}`, `/passes/${pass.id}/tags`]) {
      const r = await call(none, 'GET', path);
      expect({ path, status: r.status, code: r.body.code }).toEqual({
        path,
        status: 403,
        code: 'MISSING_SCOPE',
      });
    }
  });

  it('assigns, removes, reports lost and restores with nfc:write, and the rows name the key', async () => {
    const { pass } = await f.pass();
    const w = await key(['nfc:write', 'nfc:read']);
    const tagId = await spare();
    const assigned = await call(w, 'POST', `/passes/${pass.id}/tags/assign`, {
      tagId,
      binding: 'pass',
    });
    expect(assigned.status, JSON.stringify(assigned.body)).toBe(200);
    expect(await bindingOf(tagId)).toMatchObject({ bound_by_type: 'user', bound_by: `k:${w.id}` });
    const audit = await first<{ actor_type: string; actor_id: string }>(
      f.kit.env.DB,
      "SELECT actor_type, actor_id FROM audit_log WHERE action = 'tag.bind' AND target_id = ?",
      [tagId],
    );
    expect(audit).toEqual({ actor_type: 'api_key', actor_id: w.id });

    const lost = await call(w, 'POST', `/tags/${tagId}/lost`);
    expect(lost.status, JSON.stringify(lost.body)).toBe(200);
    const row = await first<{ lost_by: string }>(
      f.kit.env.DB,
      'SELECT lost_by FROM nfc_tags WHERE id = ?',
      [tagId],
    );
    expect(row?.lost_by).toBe(`k:${w.id}`);
    expect((await call(w, 'POST', `/tags/${tagId}/restore`)).status).toBe(200);

    const binding = await bindingOf(tagId);
    const removed = await call(w, 'DELETE', `/bindings/${binding?.id}`);
    expect(removed.status, JSON.stringify(removed.body)).toBe(200);
    expect((await bindingOf(tagId))?.ended_by).toBe(`k:${w.id}`);
    const actions = await all<{ action: string; actor_type: string }>(
      f.kit.env.DB,
      "SELECT action, actor_type FROM audit_log WHERE target_id = ? AND action LIKE 'tag.%'",
      [tagId],
    );
    expect(actions.length).toBeGreaterThanOrEqual(4);
    expect(actions.every((a) => a.actor_type === 'api_key')).toBe(true);
  });

  it('refuses a write to a key with nfc:read only, and a typed tag ID creates the tag', async () => {
    const { pass } = await f.pass();
    const r = await key(['nfc:read']);
    const tagId = await spare();
    for (const [method, path, body] of [
      ['POST', `/passes/${pass.id}/tags/assign`, { tagId, binding: 'pass' }],
      ['POST', `/tags/${tagId}/lost`, undefined],
      ['POST', `/tags/${tagId}/restore`, undefined],
    ] as const) {
      const res = await call(r, method, path, body);
      expect({ path, status: res.status, code: res.body.code }).toEqual({
        path,
        status: 403,
        code: 'MISSING_SCOPE',
      });
    }
    const w = await key(['nfc:write']);
    const typed = await call(w, 'POST', `/passes/${pass.id}/tags/assign`, {
      id: '04aabbccddeeff',
      binding: 'pass',
    });
    expect(typed.status, JSON.stringify(typed.body)).toBe(200);
  });

  it('another org is a 404, and a key never reaches the console-only routes', async () => {
    const { pass } = await f.pass();
    const w = await key(['nfc:write', 'nfc:read']);
    const foreign = await spare(f.other.id);
    expect((await call(w, 'GET', `/tags/${foreign}`)).status).toBe(404);
    expect((await call(w, 'POST', `/tags/${foreign}/lost`)).status).toBe(404);
    const outside = await key(['nfc:write'], { orgId: f.other.id });
    const mine = await spare();
    const res = await call(outside, 'POST', `/passes/${pass.id}/tags/assign`, {
      tagId: mine,
      binding: 'pass',
    });
    expect(res.status).toBe(404);
    for (const [method, path, body] of [
      ['PATCH', `/tags/${mine}`, { label: 'x' }],
      ['POST', `/tags/${mine}/retire`, undefined],
      ['GET', `/users/${f.operator.user.id}/tags`, undefined],
      ['GET', `/scanners?orgId=${f.kit.org.id}`, undefined],
    ] as const) {
      const denied = await call(w, method, path, body);
      expect({ path, status: denied.status }).toEqual({ path, status: 401 });
    }
  });
});

describe('tags by a key limited to templates', () => {
  it('assigns a spare to a pass of its template and not to another, never by user or typed ID', async () => {
    const mine = (await f.pass()).pass;
    const theirs = (await f.pass({ template: f.otherTpl })).pass;
    const w = await key(['nfc:write', 'nfc:read'], { templateIds: [f.tpl] });
    const tagId = await spare();
    const outside = await call(w, 'POST', `/passes/${theirs.id}/tags/assign`, {
      tagId,
      binding: 'pass',
    });
    expect({ status: outside.status, code: outside.body.code }).toEqual({
      status: 404,
      code: 'PASS_NOT_FOUND',
    });
    expect(await bindingOf(tagId)).toBeNull();
    for (const body of [
      { tagId, binding: 'user' },
      { id: '04aabbccddee11', binding: 'pass' },
    ]) {
      const refused = await call(w, 'POST', `/passes/${mine.id}/tags/assign`, body);
      expect({ status: refused.status, code: refused.body.code }).toEqual({
        status: 403,
        code: 'TAG_KEY_LIMITED',
      });
    }
    const ok = await call(w, 'POST', `/passes/${mine.id}/tags/assign`, { tagId, binding: 'pass' });
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    expect(await bindingOf(tagId)).toMatchObject({ bound_by: `k:${w.id}` });
    expect((await call(w, 'GET', `/passes/${mine.id}/tags`)).body.items).toHaveLength(1);
    expect((await call(w, 'GET', `/passes/${theirs.id}/tags`)).status).toBe(404);
  });

  it('removes a binding on its own pass only, and lists spares only', async () => {
    const mine = (await f.pass()).pass;
    const theirs = (await f.pass({ template: f.otherTpl })).pass;
    const free = await key(['nfc:write', 'nfc:read']);
    const w = await key(['nfc:write', 'nfc:read'], { templateIds: [f.tpl] });
    const a = await spare();
    const b = await spare();
    await call(free, 'POST', `/passes/${mine.id}/tags/assign`, { tagId: a, binding: 'pass' });
    await call(free, 'POST', `/passes/${theirs.id}/tags/assign`, { tagId: b, binding: 'pass' });
    const onTheirs = await bindingOf(b);
    const gone = await call(w, 'DELETE', `/bindings/${onTheirs?.id}`);
    expect({ status: gone.status, code: gone.body.code }).toEqual({
      status: 404,
      code: 'TAG_NOT_FOUND',
    });
    expect((await bindingOf(b))?.ended_at).toBeNull();
    const onMine = await bindingOf(a);
    expect((await call(w, 'DELETE', `/bindings/${onMine?.id}`)).status).toBe(200);
    expect((await call(w, 'GET', `/tags?status=spare`)).status).toBe(200);
    const all1 = await call(w, 'GET', `/tags`);
    expect({ status: all1.status, code: all1.body.code }).toEqual({
      status: 403,
      code: 'TAG_KEY_LIMITED',
    });
  });

  it('is refused on the routes that read or write a tag outside a pass', async () => {
    const w = await key(['nfc:write', 'nfc:read'], { templateIds: [f.tpl] });
    const tagId = await spare();
    for (const [method, path] of [
      ['GET', `/tags/${tagId}`],
      ['GET', `/tags/${tagId}/history`],
      ['POST', `/tags/${tagId}/lost`],
      ['POST', `/tags/${tagId}/restore`],
    ] as const) {
      const res = await call(w, method, path);
      expect({ path, status: res.status, code: res.body.code }).toEqual({
        path,
        status: 403,
        code: 'API_KEY_RESTRICTED_ROUTE',
      });
    }
  });
});

describe('tags by key: review follow-ups', () => {
  it('a limited key never sees a user-scope tag anchored on a pass of another template', async () => {
    const mine = await f.pass({ owner: true });
    const theirs = await f.pass({ ownerId: mine.ownerId as string, template: f.otherTpl });
    const free = await key(['nfc:write', 'nfc:read']);
    const w = await key(['nfc:write', 'nfc:read'], { templateIds: [f.tpl] });
    const userTag = await spare();
    const passTag = await spare();
    const bound = await call(free, 'POST', `/passes/${theirs.pass.id}/tags/assign`, {
      tagId: userTag,
      binding: 'user',
    });
    expect(bound.status, JSON.stringify(bound.body)).toBe(200);
    await call(free, 'POST', `/passes/${mine.pass.id}/tags/assign`, {
      tagId: passTag,
      binding: 'pass',
    });
    const ids = (r: { body: Record<string, any> }) => r.body.items.map((t: { id: string }) => t.id);
    expect(ids(await call(free, 'GET', `/passes/${mine.pass.id}/tags`))).toEqual(
      expect.arrayContaining([userTag, passTag]),
    );
    expect(ids(await call(w, 'GET', `/passes/${mine.pass.id}/tags`))).toEqual([passTag]);
  });

  it('a limited key cannot probe a pass outside its templates through the spare list', async () => {
    const theirs = (await f.pass({ template: f.otherTpl })).pass;
    const w = await key(['nfc:read'], { templateIds: [f.tpl] });
    const res = await call(w, 'GET', `/tags?status=spare&passId=${theirs.id}`);
    expect({ status: res.status, code: res.body.code }).toEqual({
      status: 404,
      code: 'PASS_NOT_FOUND',
    });
  });

  it('the grant refuses a user-scope bind to a limited key, whatever the route does', async () => {
    const mine = await f.pass({ owner: true });
    const w = await key(['nfc:write'], { templateIds: [f.tpl] });
    const tagId = await spare();
    const rev = await first<{ access_revision: number }>(
      f.kit.env.DB,
      'SELECT access_revision FROM orgs WHERE id = ?',
      [f.kit.org.id],
    );
    const authority = tagWriterOf({
      kind: 'api_key',
      orgId: f.kit.org.id,
      orgAccessRevision: rev?.access_revision ?? 0,
      keyId: w.id,
      keyOrgId: f.kit.org.id,
      scopes: ['nfc:write'],
      scope: 'nfc:write',
      mode: 'live',
      limited: true,
    });
    await expect(
      assignTag(f.kit.ctx, authority, mine.pass.id, { tagId, binding: 'user' }),
    ).rejects.toBeTruthy();
    expect(await bindingOf(tagId)).toBeNull();
  });

  it('only the capture check admits a limited key; raw authority SQL still refuses it', async () => {
    const k = await key(['nfc:write'], { templateIds: [f.tpl] });
    const org = f.kit.org.id;
    const rev = await first<{ access_revision: number }>(
      f.kit.env.DB,
      'SELECT access_revision FROM orgs WHERE id = ?',
      [org],
    );
    const a: TenantPassWrite = {
      kind: 'api_key',
      orgId: org,
      orgAccessRevision: rev?.access_revision ?? 0,
      keyId: k.id,
      keyOrgId: org,
      scopes: ['nfc:write'],
      scope: 'nfc:write',
      mode: 'live',
      limited: true,
    };
    const now = f.kit.clock.now();
    const raw = await first(
      f.kit.env.DB,
      `SELECT 1 AS ok WHERE ${tenantPassAuthoritySql(a)}`,
      tenantPassAuthorityParams(a, now),
    );
    expect(raw).toBeNull();
    expect(await tenantPassAuthorityValid(f.kit.env.DB, a, now)).toBe(true);
    const plain = { ...a };
    delete plain.limited;
    expect(await tenantPassAuthorityValid(f.kit.env.DB, plain, now)).toBe(false);
  });

  it('shows the key by name as who bound a tag', async () => {
    const { pass } = await f.pass();
    const w = await key(['nfc:write', 'nfc:read'], { name: 'Front desk VMS' });
    const tagId = await spare();
    await call(w, 'POST', `/passes/${pass.id}/tags/assign`, { tagId, binding: 'pass' });
    const one = await call(w, 'GET', `/tags/${tagId}`);
    expect(one.body.binding.boundByName).toBe('Front desk VMS');
  });

  it('another org, a platform key and the role presets', async () => {
    const mine = await spare();
    const { pass } = await f.pass();
    const foreign = await key(['nfc:write', 'nfc:read'], { orgId: f.other.id });
    for (const [method, path, body] of [
      ['GET', `/tags/${mine}/history`, undefined],
      ['POST', `/tags/${mine}/restore`, undefined],
      ['GET', `/passes/${pass.id}/tags`, undefined],
      ['GET', `/tags?orgId=${f.kit.org.id}`, undefined],
    ] as const) {
      const r = await call(foreign, method, path, body);
      expect({ path, status: r.status }).toEqual({ path, status: 404 });
    }
    const bound = await call(await key(['nfc:write']), 'POST', `/passes/${pass.id}/tags/assign`, {
      tagId: mine,
      binding: 'pass',
    });
    const binding = await bindingOf(mine);
    expect(bound.status).toBe(200);
    expect((await call(foreign, 'DELETE', `/bindings/${binding?.id}`)).status).toBe(404);
    const platform = await key(['nfc:read'], {
      orgId: null,
      kind: 'platform',
      ipAllow: ['203.0.113.0/24'],
      expiresAt: f.kit.clock.now() + 30 * DAY,
    });
    expect(
      (
        await call(
          { headers: { ...platform.headers, 'cf-connecting-ip': '203.0.113.7' } },
          'GET',
          `/tags/${mine}`,
        )
      ).status,
    ).toBe(404);
    for (const scopes of Object.values(ROLE_PRESETS))
      expect(scopes).not.toEqual(expect.arrayContaining(['nfc:read']));
    for (const scopes of Object.values(ROLE_PRESETS)) expect(scopes).not.toContain('nfc:write');
  });
});
