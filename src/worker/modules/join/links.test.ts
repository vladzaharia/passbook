import { beforeAll, describe, expect, it } from 'vitest';
import {
  makeApiKey,
  makeOrg,
  makeTemplate,
  persistTemplate,
} from '../../../../test/helpers/index.ts';
import { JoinLinkStateSchema } from '../../../shared/contracts/join.ts';
import { tokenKeys } from '../../platform/capability-token.ts';
import { all, first, run } from '../../platform/db.ts';
import { eventMember } from '../events/test-auth-fixtures.ts';
import { type Kit, setupKit } from '../passes/pass-test-fixtures.ts';
import { joinTemplate } from './join-test-fixtures.ts';
import { adminApp, type Caller, call, extraTemplate, member } from './links-test-kit.ts';

let kit: Kit;
let app: ReturnType<typeof adminApp>;
let admin: Caller;
let operator: Caller;
let reader: Caller;
let publisher: Caller;
let n = 0;

beforeAll(async () => {
  kit = await setupKit({ template: (id) => joinTemplate(id) });
  app = adminApp(kit);
  admin = await member(kit, ['org_admin']);
  operator = await member(kit, ['pass_operator']);
  reader = await member(kit, ['read_only']);
  // Both capabilities from two roles of one membership.
  publisher = await member(kit, ['pass_operator', 'template_publisher']);
}, 120_000);

const tpl = () => extraTemplate(kit, `tpl-j3a-${n++}`, () => {});
const path = (id: string, orgId = kit.org.id) => `/${id}?orgId=${orgId}`;
const state = async (res: Response) => {
  const body = await res.json();
  if (res.status !== 200) throw new Error(`${res.status} ${JSON.stringify(body)}`);
  return JoinLinkStateSchema.parse(body);
};
const put = (who: Caller, id: string, body: unknown, mode?: 'test') =>
  call(app, kit, who, 'PUT', path(id), body, mode ? { 'x-passbook-mode': mode } : {});
const get = (who: Caller, id: string, mode?: 'test') =>
  call(app, kit, who, 'GET', path(id), undefined, mode ? { 'x-passbook-mode': mode } : {});
const code = async (res: Response) => ((await res.json()) as { code?: string }).code;
const auditOf = (id: string) =>
  all<{
    action: string;
    actor_type: string;
    actor_id: string;
    detail: string | null;
    org_id: string;
  }>(
    kit.env.DB,
    `SELECT action, actor_type, actor_id, detail, org_id FROM audit_log WHERE target_id = ? ORDER BY at, id`,
    [id],
  );

describe('join link admin: capabilities', () => {
  it('reads with passes:read, shows the url to passes:operate only, and writes need both capabilities', async () => {
    const id = await tpl();
    // Nothing yet: anyone with passes:read sees the state.
    const none = await state(await get(reader, id));
    expect(none.link).toBeNull();
    expect(none.ready).toBe(true);
    // Create: passes:operate alone and passes:read alone are refused; an admin creates it.
    expect((await put(operator, id, { revision: 0 })).status).toBe(403);
    expect((await put(reader, id, { revision: 0 })).status).toBe(403);
    const made = await put(admin, id, { revision: 0 });
    expect(made.status).toBe(200);
    const link = (await state(made)).link;
    expect(link).toMatchObject({
      enabled: false,
      revision: 1,
      askEmail: false,
      dailyLimit: 200,
      nameInput: 'memberName',
      issuedToday: 0,
      limitReached: false,
      ready: true,
    });
    expect(link?.url).toMatch(/^https:\/\/.+\/j\/[A-Za-z0-9_-]{22}$/);
    // The url is for passes:operate; the state is for passes:read.
    expect((await state(await get(operator, id))).link?.url).toBe(link?.url);
    const asReader = (await state(await get(reader, id))).link;
    expect(asReader?.url).toBeNull();
    expect(asReader?.id).toBe(link?.id);
    // Turning on needs both capabilities.
    expect((await put(operator, id, { revision: 1, enabled: true })).status).toBe(403);
    expect((await put(reader, id, { revision: 1, enabled: true })).status).toBe(403);
    expect(
      (await state(await put(publisher, id, { revision: 1, enabled: true }))).link?.enabled,
    ).toBe(true);
    // Turning off and lowering the limit need passes:operate only; raising it and changing what the form asks need both.
    expect((await put(operator, id, { revision: 2, dailyLimit: 500 })).status).toBe(403);
    expect((await put(operator, id, { revision: 2, askEmail: true })).status).toBe(403);
    expect((await put(operator, id, { revision: 2, nameInput: null })).status).toBe(403);
    expect((await put(reader, id, { revision: 2, enabled: false })).status).toBe(403);
    expect((await put(operator, id, { revision: 2, dailyLimit: 100 })).status).toBe(200);
    expect((await put(operator, id, { revision: 3, dailyLimit: 150 })).status).toBe(403);
    const off = await put(operator, id, { revision: 3, enabled: false, dailyLimit: 50 });
    expect((await state(off)).link).toMatchObject({ enabled: false, dailyLimit: 50, revision: 4 });
    // Rotating needs both; the reader and the operator are refused.
    for (const who of [reader, operator])
      expect(
        (await call(app, kit, who, 'POST', `/${id}/rotate?orgId=${kit.org.id}`, {})).status,
      ).toBe(403);
  });

  it('refuses API keys and signed-out calls', async () => {
    const id = await tpl();
    const key = await makeApiKey(kit.fx, { orgId: kit.org.id });
    expect([401, 403]).toContain((await get(key, id)).status);
    expect((await get({ headers: {} }, id)).status).toBe(401);
  });

  it("masks a template of an org the caller is not in, and keeps each org's link apart", async () => {
    const id = await tpl();
    await put(admin, id, { revision: 0 });
    const stranger = await makeOrg(kit.fx);
    const outsider = {
      headers: (await eventMember(kit, stranger.id, ['org_admin'])).session.headers,
    };
    // Not a member of the kit's org: not found.
    expect((await get(outsider, id)).status).toBe(404);
    expect((await put(outsider, id, { revision: 0 })).status).toBe(404);
    // In its own org the shared template shows no link: the kit org's link is not its.
    const own = await call(app, kit, outsider, 'GET', path(id, stranger.id));
    expect((await state(own)).link).toBeNull();
    expect((await get(admin, 'tpl-missing')).status).toBe(404);
  });

  it("refuses another org's template for an org that names it", async () => {
    const other = await makeOrg(kit.fx);
    const owned = makeTemplate({ id: `tpl-j3a-owned-${n++}`, orgId: other.id });
    await persistTemplate(kit.fx, owned.resolved, { registry: owned.registry });
    expect((await get(admin, owned.resolved.id)).status).toBe(404);
    expect((await put(admin, owned.resolved.id, { revision: 0 })).status).toBe(404);
    expect(
      await first(kit.env.DB, 'SELECT id FROM join_links WHERE template_id = ?', [
        owned.resolved.id,
      ]),
    ).toBeNull();
  });

  it('needs an org for a platform template', async () => {
    const id = await tpl();
    const res = await call(app, kit, admin, 'GET', `/${id}`);
    expect(res.status).toBe(422);
  });
});

describe('join link admin: writes', () => {
  it('is a compare-and-set on the revision', async () => {
    const id = await tpl();
    expect((await put(admin, id, { revision: 0 })).status).toBe(200);
    // A second create, a stale revision and a future one are all a changed link.
    for (const revision of [0, 7]) {
      const res = await put(admin, id, { revision, askEmail: true });
      expect(res.status).toBe(409);
      expect(await code(res)).toBe('JOIN_LINK_CHANGED');
    }
    expect(
      (await state(await put(admin, id, { revision: 1, askEmail: true }))).link?.revision,
    ).toBe(2);
    const stale = await put(admin, id, { revision: 1, dailyLimit: 20 });
    expect(stale.status).toBe(409);
    expect(await code(stale)).toBe('JOIN_LINK_CHANGED');
    expect((await state(await get(admin, id))).link).toMatchObject({
      askEmail: true,
      dailyLimit: 200,
    });
  });

  it('refuses a write that races another between the read and the batch', async () => {
    const id = await tpl();
    const link = (await state(await put(admin, id, { revision: 0 }))).link;
    // Another admin's change lands after the pre-check: the grant's compare-and-set refuses.
    const db = kit.env.DB;
    const batch = db.batch.bind(db);
    let raced = false;
    db.batch = (async (statements: D1PreparedStatement[]) => {
      if (!raced) {
        raced = true;
        await run(db, 'UPDATE join_links SET revision = revision + 1 WHERE id = ?', [
          link?.id ?? '',
        ]);
      }
      return batch(statements);
    }) as typeof db.batch;
    try {
      const res = await put(admin, id, { revision: 1, askEmail: true });
      expect(res.status).toBe(409);
      expect(await code(res)).toBe('JOIN_LINK_CHANGED');
    } finally {
      db.batch = batch;
    }
    expect(raced).toBe(true);
  });

  it('writes nothing when nothing changes', async () => {
    const id = await tpl();
    await put(admin, id, { revision: 0 });
    const link = (
      await state(await put(admin, id, { revision: 1, enabled: false, askEmail: false }))
    ).link;
    expect(link?.revision).toBe(1);
    expect((await auditOf(link?.id ?? '')).map((a) => a.action)).toEqual(['join_link.create']);
  });

  it('limits a test link to 50 a day and keeps the console mode apart', async () => {
    const id = await tpl();
    const test = await put(admin, id, { revision: 0, dailyLimit: 51 }, 'test');
    expect(test.status).toBe(422);
    const made = await put(admin, id, { revision: 0 }, 'test');
    expect((await state(made)).link).toMatchObject({ mode: 'test', dailyLimit: 50 });
    // The live console sees no link; the test link is its own row.
    expect((await state(await get(admin, id))).link).toBeNull();
    expect(
      (await state(await put(admin, id, { revision: 0, dailyLimit: 300 }))).link,
    ).toMatchObject({
      mode: 'live',
      dailyLimit: 300,
    });
    expect((await put(admin, id, { revision: 1, dailyLimit: 60 }, 'test')).status).toBe(422);
  });

  it('validates the name input against the eligible inputs', async () => {
    const id = await extraTemplate(kit, `tpl-j3a-${n++}`, (m) => {
      (m.inputs.properties as Record<string, unknown>).tier = { type: 'string', maxLength: 5 };
    });
    expect((await put(admin, id, { revision: 0, nameInput: 'tier' })).status).toBe(422);
    expect((await put(admin, id, { revision: 0, nameInput: 'missing' })).status).toBe(422);
    const made = await put(admin, id, { revision: 0, nameInput: 'memberName' });
    expect((await state(made)).link?.nameInputs).toEqual([
      { key: 'memberName', label: 'memberName' },
    ]);
    // The strict body refuses extra keys.
    expect((await put(admin, id, { revision: 1, mode: 'live' })).status).toBe(422);
    expect((await put(admin, id, { revision: 1, dailyLimit: 0 })).status).toBe(422);
    expect((await put(admin, id, { revision: 1, dailyLimit: 5001 })).status).toBe(422);
  });
});

describe('join link admin: readiness', () => {
  it('names a barcode that reads an input and refuses to turn the link on', async () => {
    const id = await extraTemplate(
      kit,
      `tpl-j3a-${n++}`,
      (m) => {
        (m.inputs.properties as Record<string, unknown>).memberName = {
          type: 'string',
          minLength: 1,
          'x-label': 'Member',
        };
      },
      '{{memberName}}',
    );
    const before = await state(await get(admin, id));
    expect(before.ready).toBe(false);
    expect(before.issues).toEqual([
      { code: 'barcode_input', input: 'memberName', label: 'Member' },
    ]);
    // The link can still be made, but not opened.
    const made = await state(await put(admin, id, { revision: 0 }));
    expect(made.link?.enabled).toBe(false);
    expect(made.link?.issues).toEqual(before.issues);
    const open = await put(admin, id, { revision: 1, enabled: true });
    expect(open.status).toBe(409);
    expect(await code(open)).toBe('JOIN_NOT_READY');
    expect((await put(admin, id, { revision: 0, enabled: true })).status).toBe(409);
  });

  it('names a required input with no default and an archived template', async () => {
    const id = await extraTemplate(kit, `tpl-j3a-${n++}`, (m) => {
      m.inputs.required = ['memberName', 'tier'];
      (m.inputs.properties as Record<string, unknown>).tier = {
        type: 'integer',
        'x-label': 'Tier',
      };
    });
    expect((await state(await get(admin, id))).issues).toEqual([
      { code: 'input_needed', input: 'tier', label: 'Tier' },
    ]);
    const ok = await tpl();
    await put(admin, ok, { revision: 0 });
    await run(kit.env.DB, "UPDATE templates SET status = 'archived' WHERE id = ?", [ok]);
    const archived = await state(await get(admin, ok));
    expect(archived.issues).toEqual([{ code: 'archived' }]);
    expect((await put(admin, ok, { revision: 1, enabled: true })).status).toBe(409);
    await run(kit.env.DB, "UPDATE templates SET status = 'active' WHERE id = ?", [ok]);
  });

  it('has no release for a mode nobody released', async () => {
    const id = await extraTemplate(kit, `tpl-j3a-${n++}`, () => {}, '{{pass.scanCode}}', ['live']);
    expect((await state(await get(admin, id))).ready).toBe(true);
    const test = await state(await get(admin, id, 'test'));
    expect(test.ready).toBe(false);
    expect(test.issues).toEqual([{ code: 'no_release' }]);
    // The link is made in the mode, and cannot open there (never falls back to the live release).
    expect((await put(admin, id, { revision: 0, enabled: true }, 'test')).status).toBe(409);
    expect((await state(await put(admin, id, { revision: 0 }, 'test'))).link?.enabled).toBe(false);
    expect((await put(admin, id, { revision: 1, enabled: true }, 'test')).status).toBe(409);
  });
});

describe('join link admin: rotation and the token', () => {
  it('replaces the token, raises the generation and shows the new url', async () => {
    const id = await tpl();
    const first1 = (await state(await put(admin, id, { revision: 0, enabled: true }))).link;
    const oldToken = first1?.url?.split('/j/')[1] ?? '';
    const [oldMac] = await tokenKeys(kit.env, 'join', oldToken);
    const row = (token: string) =>
      first<{ id: string; generation: number; token: string }>(
        kit.env.DB,
        'SELECT id, generation, token FROM join_links WHERE token = ?',
        [token],
      );
    expect((await row(oldMac))?.generation).toBe(1);
    const res = await call(app, kit, publisher, 'POST', `/${id}/rotate?orgId=${kit.org.id}`, {});
    expect(res.status).toBe(200);
    const next = (await state(res)).link;
    const newToken = next?.url?.split('/j/')[1] ?? '';
    expect(newToken).toMatch(/^[A-Za-z0-9_-]{22}$/);
    expect(newToken).not.toBe(oldToken);
    // The old token no longer finds the row; the new one does, one generation up.
    expect(await row(oldMac)).toBeNull();
    const [newMac] = await tokenKeys(kit.env, 'join', newToken);
    expect(await row(newMac)).toMatchObject({ id: first1?.id, generation: 2 });
    expect(next).toMatchObject({ id: first1?.id, enabled: true, revision: 2 });
    expect(next?.rotatedAt).not.toBeNull();
    // The sealed copy is the new token, not the old one.
    expect((await state(await get(operator, id))).link?.url).toBe(next?.url);
  });

  it('refuses a rotation of a link that does not exist', async () => {
    const id = await tpl();
    const res = await call(app, kit, admin, 'POST', `/${id}/rotate?orgId=${kit.org.id}`, {});
    expect(res.status).toBe(404);
    expect(await code(res)).toBe('JOIN_LINK_NOT_FOUND');
  });

  it('shows no url when the sealed copy is gone', async () => {
    const id = await tpl();
    const link = (await state(await put(admin, id, { revision: 0 }))).link;
    await run(kit.env.DB, 'DELETE FROM join_link_seals WHERE link_id = ?', [link?.id ?? '']);
    expect((await state(await get(admin, id))).link?.url).toBeNull();
    const rotated = (
      await state(await call(app, kit, admin, 'POST', `/${id}/rotate?orgId=${kit.org.id}`, {}))
    ).link;
    expect(rotated?.url).toMatch(/\/j\//);
  });
});

describe('join link admin: audit', () => {
  it('records each change with the member and no token', async () => {
    const id = await tpl();
    const actor = await eventMember(kit, kit.org.id, ['org_admin']);
    const who = { headers: actor.session.headers };
    const link = (await state(await put(who, id, { revision: 0, askEmail: true }))).link;
    await put(who, id, { revision: 1, enabled: true });
    await put(who, id, { revision: 2, dailyLimit: 20 });
    await put(who, id, { revision: 3, enabled: false });
    await call(app, kit, who, 'POST', `/${id}/rotate?orgId=${kit.org.id}`, {});
    const rows = await auditOf(link?.id ?? '');
    expect(rows.map((r) => r.action)).toEqual([
      'join_link.create',
      'join_link.enable',
      'join_link.update',
      'join_link.disable',
      'join_link.rotate',
    ]);
    for (const row of rows) {
      expect(row).toMatchObject({
        actor_type: 'user',
        actor_id: actor.user.id,
        org_id: kit.org.id,
      });
      expect(row.detail ?? '').not.toMatch(/h1:|[A-Za-z0-9_-]{22}\b.*\/j\//);
    }
    expect(JSON.parse(rows[0]?.detail ?? '{}')).toMatchObject({
      templateId: id,
      enabled: false,
      askEmail: true,
      dailyLimit: 200,
    });
    expect(JSON.parse(rows[2]?.detail ?? '{}')).toMatchObject({ dailyLimit: 20 });
  });
});
