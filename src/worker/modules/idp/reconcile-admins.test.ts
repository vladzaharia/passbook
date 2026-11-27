import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import { run } from '../../platform/db.ts';
import { idpClient } from './client.ts';
import { retireAdmins } from './reconcile-admins.ts';
import { rig } from './sync-test-fixtures.ts';

describe('retireAdmins', () => {
  it('judges nothing when more admin accounts are linked than it can list', async () => {
    const r = await rig();
    await run(
      env.DB,
      `WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 1001)
       INSERT INTO users (id, primary_email, created_at, last_roles)
       SELECT 'cap-u' || i, 'cap' || i || '@example.test', 1, '["admin"]' FROM n`,
    );
    await run(
      env.DB,
      `INSERT INTO auth_identities (provider, subject, user_id, created_at)
       SELECT 'pocketid', 'cap-s' || substr(id, 6), id, 1 FROM users WHERE id LIKE 'cap-u%'`,
    );
    await retireAdmins(
      {
        ctx: r.ctx,
        rpc: idpClient(r.ctx.env, r.ctx.log),
        runId: 'run',
        dry: false,
        blocked: new Set(),
        renew: async () => {},
      },
      new Set(['someone-else']),
      true,
      [],
    );
    expect(r.logs.some((l) => l.code === 'IDP_ADMINS_TRUNCATED')).toBe(true);
    expect(r.logs.some((l) => l.event === 'idp.reconcile.admin_breaker')).toBe(false);
  });
});
