import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { expectProblem } from '../../../../../test/helpers/denial.ts';
import { makeApiKey, makeSession, makeUser } from '../../../../../test/helpers/index.ts';
import { sha256Hex } from '../../../platform/ids.ts';
import { f } from '../../api-keys/test-kit.ts';
import {
  challenge,
  DAY,
  oneOf,
  post,
  type Rig,
  rig,
  rowsOf,
  teardown,
} from './invitations-test-fixtures.ts';
import { admin, customGroup } from './platform-test-fixtures.ts';

let r: Rig;
let mailDown = false;
beforeEach(async () => {
  r = await rig();
  mailDown = false;
  const send = r.h.env.EMAIL.send.bind(r.h.env.EMAIL);
  (r.h.env as unknown as { EMAIL: unknown }).EMAIL = {
    send: async (m: Parameters<typeof send>[0]) => {
      if (mailDown) throw new Error('mail down');
      return send(m);
    },
  };
});
afterEach(teardown);

const URL = '/api/v1/platform/invitations';
const create = (headers: Record<string, string>, json: object) =>
  r.h.call(URL, { method: 'POST', headers, json });
const addr = (email: string) => r.addr(email);

describe('access', () => {
  it('is for platform admins signed in with Polaris ID, and a recent sign-in writes', async () => {
    const key = await customGroup(r);
    const body = { email: addr('a@agency.test'), groups: [key] };
    expect((await create({}, body)).status).toBe(401);
    const user = await makeUser(f());
    const plain = await makeSession(f(), { userId: user.id, roles: ['user'] });
    await expectProblem(await create(plain.headers, body), 403, 'FORBIDDEN');
    const link = await makeSession(f(), {
      userId: user.id,
      roles: ['admin', 'user'],
      amr: 'magic_link',
    });
    await expectProblem(await create(link.headers, body), 403, 'IDP_SIGN_IN_REQUIRED');
    const keyed = await makeApiKey(f());
    expect((await create(keyed.headers, body)).status).toBe(401);
    const old = await makeSession(f(), {
      userId: user.id,
      roles: ['admin', 'user'],
      authTime: r.h.clock.now() - 3 * 3600_000,
    });
    await expectProblem(await create(old.headers, body), 403, 'STEP_UP_REQUIRED');
    expect((await r.h.call(URL, { headers: old.headers })).status).toBe(200);
  });
});

describe('POST /platform/invitations', () => {
  it('stores only the hash, mails the link, shows it once and audits without the address', async () => {
    const key = await customGroup(r);
    const who = await admin();
    const res = await create(who.headers, {
      email: addr('Guest@Agency.test'),
      groups: [key],
      developer: true,
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { id: string; link: string; email: string; state: string };
    expect(body).toMatchObject({
      email: addr('guest@agency.test'),
      state: 'pending',
      developer: true,
      groups: [key],
    });
    const secret = body.link.split('#')[1] as string;
    expect(secret).toMatch(/^p_[\w-]{43}$/);
    const row = await oneOf(r, 'SELECT * FROM platform_invitations WHERE id = ?', [body.id]);
    expect(row).toMatchObject({
      token_hash: await sha256Hex(secret),
      created_by_user: who.id,
      created_by_key: null,
      expires_at: r.h.clock.now() + 7 * DAY,
      claim_until: r.h.clock.now() + 8 * DAY,
    });
    expect(JSON.stringify(row)).not.toContain(secret);
    expect(r.h.mail).toHaveLength(1);
    expect(r.h.mail[0]?.text).toContain(`/invite#${secret}`);
    expect(r.h.mail[0]?.text).not.toContain('id.test');
    const audit = await oneOf(
      r,
      "SELECT detail, actor_id FROM audit_log WHERE action = 'idp.invite_platform' AND target_id = ?",
      [body.id],
    );
    expect(audit).toMatchObject({
      actor_id: who.id,
      detail: '{"op":"create","groups":1,"developer":true}',
    });
    // The link works on the page.
    expect(await (await post(r, '/preview', { token: secret })).json()).toMatchObject({
      kind: 'platform',
    });
  });

  it('needs a group or developer access, and live groups', async () => {
    const who = await admin();
    expect((await create(who.headers, { email: addr('a@agency.test') })).status).toBe(422);
    expect((await create(who.headers, { email: addr('a@agency.test'), groups: [] })).status).toBe(
      422,
    );
    const six = await Promise.all([1, 2, 3, 4, 5, 6].map(() => customGroup(r)));
    expect((await create(who.headers, { email: addr('a@agency.test'), groups: six })).status).toBe(
      422,
    );
    expect(
      (await create(who.headers, { email: addr('a@agency.test'), groups: ['nope_nope'] })).status,
    ).toBe(422);
    expect((await create(who.headers, { email: 'not-an-email', developer: true })).status).toBe(
      422,
    );
    expect(r.h.mail).toHaveLength(0);
  });

  it('refuses a second pending invitation to the address, and works again after a revoke', async () => {
    const key = await customGroup(r);
    const who = await admin();
    const body = { email: addr('a@agency.test'), groups: [key] };
    const first = (await (await create(who.headers, body)).json()) as { id: string };
    await expectProblem(await create(who.headers, body), 409, 'PLATFORM_INVITE_PENDING');
    expect(
      (await r.h.call(`${URL}/${first.id}`, { method: 'DELETE', headers: who.headers })).status,
    ).toBe(200);
    expect((await create(who.headers, body)).status).toBe(201);
  });

  it('is refused in dry run and while Polaris ID is not live', async () => {
    const key = await customGroup(r);
    const who = await admin();
    const body = { email: addr('a@agency.test'), groups: [key] };
    r.idp.mode = 'dry_run';
    await expectProblem(await create(who.headers, body), 409, 'IDP_DRY_RUN');
    r.idp.mode = 'live';
    r.idp.frozen = true;
    await expectProblem(await create(who.headers, body), 503, 'IDP_UNAVAILABLE');
    expect(
      await rowsOf(r, 'SELECT id FROM platform_invitations WHERE email = ?', [body.email]),
    ).toEqual([]);
  });

  it('revokes the row when the mail fails', async () => {
    const key = await customGroup(r);
    const who = await admin();
    mailDown = true;
    const res = await create(who.headers, { email: addr('a@agency.test'), groups: [key] });
    expect(res.status).toBe(503);
    const row = await oneOf(r, 'SELECT revoked_at FROM platform_invitations WHERE email = ?', [
      addr('a@agency.test'),
    ]);
    expect(row?.revoked_at).not.toBeNull();
  });

  it('replays an Idempotency-Key without a second mail', async () => {
    const key = await customGroup(r);
    const who = await admin();
    const headers = { ...who.headers, 'idempotency-key': 'inv-1' };
    const body = { email: addr('a@agency.test'), groups: [key] };
    const one = await create(headers, body);
    const two = await create(headers, body);
    expect(two.headers.get('Idempotent-Replayed')).toBe('true');
    const first = (await one.json()) as { id: string; link?: string };
    const replayed = (await two.json()) as { id: string; link?: string };
    expect(first.link).toMatch(/#p_/);
    // The stored copy never holds the link: the replay names the invitation and nothing that opens it.
    expect(replayed).toEqual({ ...first, link: undefined });
    expect(replayed.link).toBeUndefined();
    expect(r.h.mail).toHaveLength(1);
    const secret = (first.link as string).split('#')[1] as string;
    const stored = await rowsOf(r, 'SELECT body FROM idempotent_requests', []);
    expect(JSON.stringify(stored)).not.toContain(secret);
  });

  it('keeps the link out of a stored resend too', async () => {
    const key = await customGroup(r);
    const who = await admin();
    const made = (await (
      await create(who.headers, { email: addr('a@agency.test'), groups: [key] })
    ).json()) as { id: string };
    const headers = { ...who.headers, 'idempotency-key': 'resend-1' };
    const one = (await (
      await r.h.call(`${URL}/${made.id}/resend`, { method: 'POST', headers })
    ).json()) as { link?: string };
    const two = await r.h.call(`${URL}/${made.id}/resend`, { method: 'POST', headers });
    expect(two.headers.get('Idempotent-Replayed')).toBe('true');
    expect(((await two.json()) as { link?: string }).link).toBeUndefined();
    const secret = (one.link as string).split('#')[1] as string;
    expect(
      JSON.stringify(await rowsOf(r, 'SELECT body FROM idempotent_requests', [])),
    ).not.toContain(secret);
  });
});

describe('list, revoke and resend', () => {
  it('lists with states, revokes and withdraws unused tokens', async () => {
    const key = await customGroup(r);
    const who = await admin();
    const made = (await (
      await create(who.headers, { email: addr('a@agency.test'), groups: [key] })
    ).json()) as {
      id: string;
      link: string;
    };
    const secret = made.link.split('#')[1] as string;
    await post(r, '/setup', challenge(secret));
    const token = [...r.idp.signups.keys()].at(-1) as string;
    const listed = (await (await r.h.call(URL, { headers: who.headers })).json()) as {
      items: { id: string; state: string }[];
    };
    expect(listed.items.find((i) => i.id === made.id)?.state).toBe('pending');
    expect(
      (await r.h.call(`${URL}/${made.id}`, { method: 'DELETE', headers: who.headers })).status,
    ).toBe(200);
    expect(r.idp.signups.has(token)).toBe(false);
    const after = (await (await r.h.call(URL, { headers: who.headers })).json()) as {
      items: { id: string; state: string }[];
    };
    expect(after.items.find((i) => i.id === made.id)?.state).toBe('revoked');
    await expectProblem(
      await r.h.call(`${URL}/${made.id}`, { method: 'DELETE', headers: who.headers }),
      409,
      'PLATFORM_INVITE_CONFLICT',
    );
    await expectProblem(await post(r, '/preview', { token: secret }), 400, 'INVITATION_INVALID');
    expect((await r.h.call(`${URL}/nope`, { method: 'DELETE', headers: who.headers })).status).toBe(
      404,
    );
  });

  it('resends on a new row with a new link and revokes the old one', async () => {
    const key = await customGroup(r);
    const who = await admin();
    const made = (await (
      await create(who.headers, { email: addr('a@agency.test'), groups: [key] })
    ).json()) as {
      id: string;
      link: string;
    };
    r.h.clock.advance(8.5 * DAY);
    const later = await admin();
    const res = await r.h.call(`${URL}/${made.id}/resend`, {
      method: 'POST',
      headers: later.headers,
    });
    expect(res.status).toBe(201);
    const again = (await res.json()) as { id: string; link: string; groups: string[] };
    expect(again.id).not.toBe(made.id);
    expect(again.link).not.toBe(made.link);
    expect(again.groups).toEqual([key]);
    expect(
      (await oneOf(r, 'SELECT revoked_at FROM platform_invitations WHERE id = ?', [made.id]))
        ?.revoked_at,
    ).not.toBeNull();
    expect(r.h.mail).toHaveLength(2);
    expect(
      await (await post(r, '/preview', { token: again.link.split('#')[1] as string })).json(),
    ).toMatchObject({ kind: 'platform' });
    // An ended one cannot be sent again.
    await expectProblem(
      await r.h.call(`${URL}/${made.id}/resend`, { method: 'POST', headers: later.headers }),
      409,
      'PLATFORM_INVITE_CONFLICT',
    );
  });
});
