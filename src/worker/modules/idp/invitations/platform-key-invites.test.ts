// A platform invitation made by a Platform key lives only while the key and its creator do (R2b M1).
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { expectProblem } from '../../../../../test/helpers/denial.ts';
import { makeApiKey } from '../../../../../test/helpers/index.ts';
import { INVITE_PREFIX } from '../../../../shared/invitation-link.ts';
import { run } from '../../../platform/db.ts';
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
beforeEach(async () => {
  r = await rig();
});
afterEach(teardown);

async function keyInvite() {
  const group = await customGroup(r);
  const key = await makeApiKey(f(), {
    orgId: null,
    kind: 'platform',
    scopes: ['platform:users'],
    expiresAt: r.h.clock.now() + 30 * DAY,
    ipAllow: ['198.51.100.0/24'],
  });
  const secret = `${INVITE_PREFIX.platform}${f().ids.token(32)}`;
  const id = f().ids.id();
  const now = r.h.clock.now();
  await run(
    r.h.env.DB,
    `INSERT INTO platform_invitations (id, email, token_hash, groups, developer, created_by_key, created_at, expires_at, claim_until)
     VALUES (?, ?, ?, ?, 0, ?, ?, ?, ?)`,
    [
      id,
      r.addr('guest@agency.test'),
      await sha256Hex(secret),
      JSON.stringify([group]),
      key.id,
      now,
      now + 7 * DAY,
      now + 8 * DAY,
    ],
  );
  return { id, secret, keyId: key.id };
}
const members = (id: string) =>
  rowsOf(r, 'SELECT subject FROM idp_group_members WHERE platform_invitation_id = ?', [id]);
const refused = async (secret: string) => {
  await expectProblem(await post(r, '/preview', { token: secret }), 400, 'INVITATION_INVALID');
  const setup = await post(r, '/setup', challenge(secret));
  expect(setup.status).toBeGreaterThanOrEqual(400);
};

describe('an invitation made by a Platform key', () => {
  it('is open while the key lives', async () => {
    const inv = await keyInvite();
    expect((await post(r, '/preview', { token: inv.secret })).status).toBe(200);
  });

  it('ends when the key is revoked, and nobody lands in a group', async () => {
    const inv = await keyInvite();
    await run(r.h.env.DB, 'UPDATE api_keys SET revoked_at = ? WHERE id = ?', [
      r.h.clock.now(),
      inv.keyId,
    ]);
    await refused(inv.secret);
    expect(await members(inv.id)).toEqual([]);
  });

  it('ends when the creator is disabled', async () => {
    const inv = await keyInvite();
    await run(
      r.h.env.DB,
      "UPDATE users SET status = 'disabled' WHERE id = (SELECT created_by FROM api_keys WHERE id = ?)",
      [inv.keyId],
    );
    await refused(inv.secret);
    expect(await members(inv.id)).toEqual([]);
  });

  it('is revoked in its row when the key is revoked through the service', async () => {
    const inv = await keyInvite();
    const who = await admin();
    const res = await r.h.call(`/api/v1/api-keys/${inv.keyId}?orgId=null`, {
      method: 'DELETE',
      headers: who.headers,
    });
    expect([res.status, await res.text()]).toEqual([200, '{"ok":true}']);
    const row = await oneOf(r, 'SELECT revoked_at FROM platform_invitations WHERE id = ?', [
      inv.id,
    ]);
    expect(row?.revoked_at).not.toBeNull();
  });

  it('is listed with its creator', async () => {
    const inv = await keyInvite();
    const who = await admin();
    const res = await r.h.call('/api/v1/platform/invitations', { headers: who.headers });
    const body = (await res.json()) as {
      items: { id: string; createdBy: { kind: string; id: string } }[];
    };
    expect(body.items.find((i) => i.id === inv.id)?.createdBy).toMatchObject({
      kind: 'key',
      id: inv.keyId,
    });
  });
});
