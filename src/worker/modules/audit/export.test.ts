import { beforeAll, describe, expect, it } from 'vitest';
import { fakeAuth, makeUser } from '../../../../test/helpers/index.ts';
import { createApp } from '../../app.ts';
import { run } from '../../platform/db.ts';
import { type RetentionKit, retentionKit } from '../retention/retention-test-fixtures.ts';
import { recordAudit } from './service.ts';

const fake = fakeAuth();
let rk: RetentionKit;
let app: ReturnType<typeof createApp>;
beforeAll(async () => {
  rk = await retentionKit();
  fake.bindSessions(rk.kit.env.DB, rk.kit.clock);
  app = createApp({ stores: fake.stores, clock: rk.kit.clock });
}, 30_000);

const get = (path: string, headers: Record<string, string>) =>
  app.request(path, { headers }, rk.kit.env);

async function member(orgId: string, role: string) {
  const { fx, env, clock } = rk.kit;
  const user = await makeUser(fx);
  const invitationId = fx.ids.id();
  const now = clock.now();
  await run(
    env.DB,
    `INSERT INTO org_invitations (id, org_id, email, roles, token_hash, created_at, expires_at, accepted_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      invitationId,
      orgId,
      user.primaryEmail,
      JSON.stringify([role]),
      fx.ids.token(),
      now,
      now + 3_600_000,
      now,
    ],
  );
  await run(
    env.DB,
    'INSERT INTO org_memberships (id, org_id, user_id, invitation_id, roles, created_at) VALUES (?, ?, ?, ?, ?, ?)',
    [fx.ids.id(), orgId, user.id, invitationId, JSON.stringify([role]), now],
  );
  return fake.user(user.id);
}

async function setup(rows: number) {
  const admin = await rk.org(['org_admin']);
  const other = await rk.org(['org_admin']);
  for (let i = 0; i < rows; i++)
    await recordAudit(rk.kit.ctx, {
      orgId: admin.orgId,
      actorType: 'user',
      actorId: admin.userId,
      action: 'pass.update',
      targetType: 'pass',
      targetId: `p${i}`,
      detail: { note: `private ${i}`, email: 'holder@example.test' },
    });
  await recordAudit(rk.kit.ctx, { orgId: other.orgId, actorType: 'system', action: 'other.org' });
  const root = await rk.platform();
  return {
    orgId: admin.orgId,
    otherId: other.orgId,
    admin: fake.user(admin.userId),
    author: await member(admin.orgId, 'template_author'),
    outsider: fake.user(other.userId),
    root: fake.session({ userId: root.userId, roles: ['admin', 'user'] }),
  };
}

describe('audit export', () => {
  it('streams every matching entry of the org, past one page, without detail', async () => {
    const p = await setup(450);
    const res = await get(`/api/v1/audit/export?orgId=${p.orgId}`, p.admin);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/csv');
    expect(res.headers.get('content-disposition')).toContain('audit-log.csv');
    const lines = (await res.text()).trim().split('\r\n');
    expect(lines[0]).toBe('Time (UTC),Action,Actor,Target,Organization');
    const rows = lines.slice(1).filter((l) => l.includes('pass.update'));
    expect(rows).toHaveLength(450);
    const text = lines.join('\n');
    expect(text).not.toContain('private');
    expect(text).not.toContain('holder@example.test');
    expect(text).not.toContain('other.org');
  }, 60_000);

  it('applies the list filters', async () => {
    const p = await setup(3);
    const res = await get(`/api/v1/audit/export?orgId=${p.orgId}&action=nothing.here`, p.admin);
    expect((await res.text()).trim().split('\r\n')).toHaveLength(1);
  });

  it('refuses a member without audit:read and another org admin', async () => {
    const p = await setup(1);
    expect((await get(`/api/v1/audit/export?orgId=${p.orgId}`, p.author)).status).toBe(403);
    expect((await get(`/api/v1/audit/export?orgId=${p.orgId}`, p.outsider)).status).toBe(403);
    expect((await get('/api/v1/audit/export', p.admin)).status).toBe(422);
  });

  it('the platform export is for administrators and spans orgs', async () => {
    const p = await setup(2);
    expect((await get('/api/v1/audit/platform/export', p.admin)).status).toBe(403);
    const res = await get('/api/v1/audit/platform/export', p.root);
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toContain('other.org');
    expect(text).toContain('pass.update');
    expect(text).not.toContain('private');
  });
});
