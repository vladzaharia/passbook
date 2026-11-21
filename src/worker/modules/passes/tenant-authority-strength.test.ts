import { beforeAll, describe, expect, it } from 'vitest';
import { makeSession, makeUser } from '../../../../test/helpers/index.ts';
import { run } from '../../platform/db.ts';
import { ForbiddenError } from '../../platform/errors.ts';
import { createSessionStore } from '../auth/sessions.ts';
import { tenantAuthorityOf } from './http.ts';
import { type Kit, setupKit } from './pass-test-fixtures.ts';
import { tenantPassAuthorityValid } from './repo-authority.ts';

let kit: Kit;
beforeAll(async () => {
  kit = await setupKit();
});

async function member(amr: 'oidc' | 'magic_link' | 'breakglass') {
  const user = await makeUser(kit.fx);
  const invitationId = kit.fx.ids.id();
  const now = kit.clock.now();
  await run(
    kit.env.DB,
    `INSERT INTO org_invitations (id, org_id, email, roles, token_hash, created_at, expires_at, accepted_at)
     VALUES (?, ?, ?, '["org_admin"]', ?, ?, ?, ?)`,
    [invitationId, kit.org.id, user.primaryEmail, kit.fx.ids.token(), now, now + 60_000, now],
  );
  await run(
    kit.env.DB,
    `INSERT INTO org_memberships (id, org_id, user_id, invitation_id, roles, created_at)
     VALUES (?, ?, ?, ?, '["org_admin"]', ?)`,
    [kit.fx.ids.id(), kit.org.id, user.id, invitationId, now],
  );
  const session = await makeSession(kit.fx, { userId: user.id, amr, lifetimeMs: 24 * 3_600_000 });
  return { user, session };
}

const resolve = async (cookie: string) => {
  const auth = await createSessionStore(kit.env, kit.clock).resolve(cookie);
  if (!auth) throw new Error('session did not resolve');
  return { ...auth, mode: 'live' as const };
};

const grace = (userId: string, until: number | null) =>
  run(
    kit.env.DB,
    'INSERT OR REPLACE INTO console_email_grace (user_id, created_at) VALUES (?, 1)',
    [userId],
  ).then(() =>
    run(
      kit.env.DB,
      `INSERT INTO settings (scope, key, value, updated_at) VALUES ('platform', 'auth.consoleEmailUntil', ?, 1)
       ON CONFLICT (scope, key) DO UPDATE SET value = excluded.value`,
      [JSON.stringify(until)],
    ),
  );

describe('org authority needs a strong session, or an email session in grace', () => {
  it('commits for a Polaris ID or break-glass session', async () => {
    for (const amr of ['oidc', 'breakglass'] as const) {
      const { session } = await member(amr);
      const authority = await tenantAuthorityOf(
        kit.ctx,
        await resolve(session.cookieValue),
        kit.org.id,
        'passes:read',
      );
      expect(await tenantPassAuthorityValid(kit.env.DB, authority, kit.clock.now())).toBe(true);
    }
  });

  it('refuses an email session with no grace, allows it in grace, refuses it after', async () => {
    const { user, session } = await member('magic_link');
    await expect(
      tenantAuthorityOf(kit.ctx, await resolve(session.cookieValue), kit.org.id, 'passes:read'),
    ).rejects.toBeInstanceOf(ForbiddenError);

    // In the grace table, but the setting is unset: still refused.
    await run(kit.env.DB, 'DELETE FROM settings WHERE key = ?', ['auth.consoleEmailUntil']);
    await run(
      kit.env.DB,
      'INSERT OR REPLACE INTO console_email_grace (user_id, created_at) VALUES (?, 1)',
      [user.id],
    );
    await expect(
      tenantAuthorityOf(kit.ctx, await resolve(session.cookieValue), kit.org.id, 'passes:read'),
    ).rejects.toBeInstanceOf(ForbiddenError);

    const until = kit.clock.now() + 30 * 60_000;
    await grace(user.id, until);
    const auth = await resolve(session.cookieValue);
    expect(auth.consoleUntil).toBe(until);
    const authority = await tenantAuthorityOf(kit.ctx, auth, kit.org.id, 'passes:read');
    expect(await tenantPassAuthorityValid(kit.env.DB, authority, kit.clock.now())).toBe(true);

    // The same snapshot, after the window: the SQL refuses even though the guard once let it in.
    kit.clock.advance(31 * 60_000);
    expect(await tenantPassAuthorityValid(kit.env.DB, authority, kit.clock.now())).toBe(false);
    await expect(
      tenantAuthorityOf(kit.ctx, await resolve(session.cookieValue), kit.org.id, 'passes:read'),
    ).rejects.toBeInstanceOf(ForbiddenError);
  });

  it('never gives grace to a user outside the grace table', async () => {
    const { session } = await member('magic_link');
    const auth = await resolve(session.cookieValue);
    expect(auth.consoleUntil).toBeNull();
    await expect(
      tenantAuthorityOf(kit.ctx, auth, kit.org.id, 'passes:read'),
    ).rejects.toBeInstanceOf(ForbiddenError);
  });
});
