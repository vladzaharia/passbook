import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { expectProblem } from '../../../../test/helpers/denial.ts';
import { run } from '../../platform/db.ts';
import { type CreatedKey, create, h, keyBody, member, org, setup, teardown } from './test-kit.ts';

beforeEach(async () => {
  await setup();
  await run(h.env.DB, 'DELETE FROM settings WHERE key = ?', ['auth.consoleEmailUntil']);
  await run(h.env.DB, 'DELETE FROM console_email_grace');
});
afterEach(teardown);

const DAY = 86_400_000;
const listPasses = (secret: string) =>
  h.call('/api/v1/passes', { headers: { authorization: `Bearer ${secret}` } });

async function personalKey() {
  const who = await member('pass_operator');
  const res = await create(who.session.headers, {
    ...keyBody(org.id),
    kind: 'personal',
    expiresAt: h.clock.now() + 30 * DAY,
  });
  expect(res.status).toBe(201);
  return { ...who, key: (await res.json()) as CreatedKey };
}

const dropIdentity = (userId: string) =>
  run(h.env.DB, 'DELETE FROM auth_identities WHERE user_id = ?', [userId]);
const grace = (userId: string, until: number) =>
  run(h.env.DB, 'INSERT INTO console_email_grace (user_id, created_at) VALUES (?, 1)', [
    userId,
  ]).then(() =>
    run(
      h.env.DB,
      `INSERT INTO settings (scope, key, value, updated_at) VALUES ('platform', 'auth.consoleEmailUntil', ?, 1)
         ON CONFLICT (scope, key) DO UPDATE SET value = excluded.value`,
      [String(until)],
    ),
  );

describe('a personal key needs its owner to have signed in with Polaris ID', () => {
  it('works for an owner with a Polaris ID identity', async () => {
    const { key } = await personalKey();
    expect((await listPasses(key.secret)).status).toBe(200);
  });

  it('works for a member in grace before the cutover, and stops after it', async () => {
    const { user, key } = await personalKey();
    await dropIdentity(user.id);
    await grace(user.id, h.clock.now() + 10 * DAY);
    expect((await listPasses(key.secret)).status).toBe(200);
    h.clock.advance(11 * DAY);
    await expectProblem(await listPasses(key.secret), 403, 'KEY_OWNER_NEEDS_IDP');
  });

  it('stops at once for an owner with no identity and no grace (enforced from the start)', async () => {
    const { user, key } = await personalKey();
    await dropIdentity(user.id);
    await expectProblem(await listPasses(key.secret), 403, 'KEY_OWNER_NEEDS_IDP');
  });

  it('works again unchanged once the owner signs in with Polaris ID', async () => {
    const { user, key } = await personalKey();
    await dropIdentity(user.id);
    await expectProblem(await listPasses(key.secret), 403, 'KEY_OWNER_NEEDS_IDP');
    await run(
      h.env.DB,
      `INSERT INTO auth_identities (provider, subject, user_id, created_at) VALUES ('pocketid', ?, ?, 1)`,
      [`sub-${user.id}`, user.id],
    );
    expect((await listPasses(key.secret)).status).toBe(200);
  });

  it('leaves a service key unaffected', async () => {
    const { session } = await member('org_admin');
    const res = await create(session.headers, keyBody(org.id));
    expect(res.status).toBe(201);
    const service = (await res.json()) as CreatedKey;
    await run(h.env.DB, 'DELETE FROM auth_identities');
    expect((await listPasses(service.secret)).status).toBe(200);
  });

  it('records how the creator signed in, and never changes it', async () => {
    const { key } = await personalKey();
    const row = async () =>
      (
        await h.env.DB.prepare('SELECT created_amr FROM api_keys WHERE id = ?')
          .bind(key.id)
          .first<{ created_amr: string | null }>()
      )?.created_amr;
    expect(await row()).toBe('oidc');
    await expect(
      run(h.env.DB, "UPDATE api_keys SET created_amr = 'magic_link' WHERE id = ?", [key.id]),
    ).rejects.toThrow(/created_amr is immutable/);
  });
});
