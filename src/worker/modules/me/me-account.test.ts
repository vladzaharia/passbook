import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  fixtures,
  makeOrg,
  makePass,
  makeSession,
  makeTemplate,
  makeUser,
} from '../../../../test/helpers/index.ts';
import { all, run } from '../../platform/db.ts';
import { harness, type TestHarness } from '../auth/test-support.ts';
import { PLATFORM_IDENTITY_ID } from '../identities/resolver.ts';

let h: TestHarness;
const f = () => fixtures(h.env, h.clock);

beforeEach(async () => {
  h = await harness();
});
afterEach(() => h.restore());

async function setup() {
  const f1 = f();
  const user = await makeUser(f1);
  const session = await makeSession(f1, { userId: user.id });
  const org = await makeOrg(f1, { name: 'Acme' });
  const template = makeTemplate();
  const own = async () => {
    const pass = await makePass(f1, { orgId: org.id, template: template.resolved });
    await run(h.env.DB, 'UPDATE passes SET owner_user_id = ? WHERE id = ?', [user.id, pass.id]);
    return pass;
  };
  return { user, session, own };
}

/** A device registered for the pass through the Apple web service. */
async function register(pass: { id: string }, identityId = PLATFORM_IDENTITY_ID) {
  const device = `dev-${Math.random().toString(36).slice(2)}`;
  await run(
    h.env.DB,
    'INSERT INTO devices (device_id, identity_id, push_token, updated_at) VALUES (?, ?, ?, 1)',
    [device, identityId, `tok-${device}`],
  );
  await run(
    h.env.DB,
    'INSERT INTO registrations (device_id, identity_id, pass_id, created_at) VALUES (?, ?, ?, 1)',
    [device, identityId, pass.id],
  );
}

const zipNames = (bytes: Uint8Array) => {
  const names: string[] = [];
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  for (let i = 0; i + 30 < bytes.length; i++) {
    if (view.getUint32(i, true) !== 0x04034b50) continue;
    const len = view.getUint16(i + 26, true);
    names.push(new TextDecoder().decode(bytes.subarray(i + 30, i + 30 + len)));
  }
  return names;
};

describe('in Wallet', () => {
  it('flags passes a device registered and leaves them out of Add all', async () => {
    const { session, own } = await setup();
    const inWallet = await own();
    const fresh = await own();
    await register(inWallet);

    const list = (await (
      await h.call('/api/v1/me/passes', { headers: session.headers })
    ).json()) as {
      items: { id: string; inWallet: boolean }[];
    };
    const flags = Object.fromEntries(list.items.map((p) => [p.id, p.inWallet]));
    expect(flags).toEqual({ [inWallet.id]: true, [fresh.id]: false });
    const one = (await (
      await h.call(`/api/v1/me/passes/${inWallet.id}`, { headers: session.headers })
    ).json()) as { inWallet: boolean };
    expect(one.inWallet).toBe(true);

    const bundle = await h.call('/api/v1/me/passes.pkpasses', { headers: session.headers });
    expect(bundle.status).toBe(200);
    expect(zipNames(new Uint8Array(await bundle.arrayBuffer()))).toEqual([`${fresh.id}.pkpass`]);
  });
});

describe('make primary', () => {
  it('moves the primary to a verified address, audited', async () => {
    const { user, session } = await setup();
    const extra = `extra-${Math.random().toString(36).slice(2)}@example.test`;
    await run(
      h.env.DB,
      "INSERT INTO user_emails (email, user_id, verified_via, verified_at) VALUES (?, ?, 'magic_link', 0)",
      [extra, user.id],
    );
    const res = await h.call(`/api/v1/me/emails/${encodeURIComponent(extra)}/primary`, {
      method: 'POST',
      headers: session.headers,
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { items: { email: string; primary: boolean }[] };
    expect(body.items.find((e) => e.primary)?.email).toBe(extra);
    const me = (await (await h.call('/api/v1/session', { headers: session.headers })).json()) as {
      user: { primaryEmail: string };
    };
    expect(me.user.primaryEmail).toBe(extra);
    const audit = await all<{ action: string }>(
      h.env.DB,
      'SELECT action FROM audit_log WHERE actor_id = ?',
      [user.id],
    );
    expect(audit.map((a) => a.action)).toContain('user.email_primary');
  });

  it('refuses an address that is not mine or not an email', async () => {
    const { session } = await setup();
    const other = await makeUser(f());
    const post = (email: string) =>
      h.call(`/api/v1/me/emails/${encodeURIComponent(email)}/primary`, {
        method: 'POST',
        headers: session.headers,
      });
    expect((await post(other.primaryEmail)).status).toBe(404);
    expect((await post('nope')).status).toBe(422);
  });
});
