import { beforeAll, describe, expect, it } from 'vitest';
import { fakeAuth, makeUser } from '../../../../test/helpers/index.ts';
import { AuditQuerySchema } from '../../../shared/contracts/audit.ts';
import { createApp } from '../../app.ts';
import type { AuthContext } from '../../platform/auth.ts';
import { first, run } from '../../platform/db.ts';
import { ForbiddenError } from '../../platform/errors.ts';
import { type RetentionKit, retentionKit } from '../retention/retention-test-fixtures.ts';
import { auditCsv } from './export.ts';
import { listTenantAudit, recordAudit, tenantAuditReader } from './service.ts';

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
    adminUserId: admin.userId,
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

  it('fails a later page when authority is lost mid-export, instead of ending the file short', async () => {
    const p = await setup(3);
    expect((await get(`/api/v1/audit?orgId=${p.orgId}`, p.admin)).status).toBe(200);
    const row = await first<{ id_hash: string }>(
      rk.kit.env.DB,
      'SELECT id_hash FROM sessions WHERE user_id = ?',
      [p.adminUserId],
    );
    const auth: AuthContext = {
      kind: 'session',
      userId: p.adminUserId,
      sessionId: row?.id_hash ?? '',
      roles: ['user'],
      csrfSecret: 'x',
      amr: 'oidc',
      consoleUntil: null,
      authTime: null,
      mode: 'live',
    };
    const query = AuditQuerySchema.parse({ orgId: p.orgId });
    const { ctx } = rk.kit;
    const reader = await tenantAuditReader(ctx, auth, query);
    const next = { ...query, cursor: '1' };
    expect((await listTenantAudit(ctx, auth, next, reader)).items).toEqual([]);
    await run(rk.kit.env.DB, 'UPDATE sessions SET revoked_at = ? WHERE id_hash = ?', [
      rk.kit.clock.now(),
      auth.sessionId,
    ]);
    await expect(listTenantAudit(ctx, auth, next, reader)).rejects.toBeInstanceOf(ForbiddenError);
  });

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

  it('the 7th export in an hour is refused with the wait; a refused caller spends nothing', async () => {
    const p = await setup(1);
    for (let i = 0; i < 6; i++)
      expect((await get(`/api/v1/audit/export?orgId=${p.orgId}`, p.admin)).status).toBe(200);
    const limited = await get(`/api/v1/audit/export?orgId=${p.orgId}`, p.admin);
    expect(limited.status).toBe(429);
    expect(Number(limited.headers.get('retry-after'))).toBeGreaterThan(0);
    expect(await limited.text()).toMatch(/Try again in \d+ minute/);
    // 403s never reach the counter.
    for (let i = 0; i < 8; i++)
      expect((await get(`/api/v1/audit/export?orgId=${p.orgId}`, p.author)).status).toBe(403);
  });

  it('the platform export has its own per-admin budget', async () => {
    const p = await setup(1);
    for (let i = 0; i < 6; i++)
      expect((await get('/api/v1/audit/platform/export', p.root)).status).toBe(200);
    expect((await get('/api/v1/audit/platform/export', p.root)).status).toBe(429);
  });
});

describe('audit csv cap', () => {
  const entry = (id: number) => ({
    id,
    at: 0,
    orgId: 'o',
    actorType: 'user' as const,
    actorId: null,
    actorLabel: null,
    action: 'x.y',
    targetType: null,
    targetId: null,
    targetLabel: null,
    requestId: null,
    detail: null,
  });
  const pages = (total: number) => async (cursor: string | undefined, limit: number) => {
    const from = cursor ? Number(cursor) : 0;
    const n = Math.min(limit, total - from);
    return {
      items: Array.from({ length: n }, (_, i) => entry(from + i)),
      nextCursor: from + n < total ? String(from + n) : null,
    };
  };

  it('ends with a note once the cap is hit, and says so', async () => {
    const out = await auditCsv(pages(1000), async () => {}, 450);
    expect(out.truncated).toBe(true);
    const lines = out.csv.trim().split('\r\n');
    expect(lines).toHaveLength(1 + 450 + 1);
    expect(lines.at(-1)).toBe('# truncated at 450 rows; narrow the dates');
  });

  it('does not truncate at exactly the cap', async () => {
    const out = await auditCsv(pages(450), async () => {}, 450);
    expect(out.truncated).toBe(false);
    expect(out.csv).not.toContain('# truncated');
  });
});
