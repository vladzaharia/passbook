import { beforeAll, describe, expect, it } from 'vitest';
import { fakeAuth, makeUser } from '../../../../test/helpers/index.ts';
import { createApp } from '../../app.ts';
import { first, run } from '../../platform/db.ts';
import { writeReceipt } from './receipt-service.ts';
import { type RetentionKit, retentionKit } from './retention-test-fixtures.ts';

const fake = fakeAuth();
let rk: RetentionKit;
let app: ReturnType<typeof createApp>;
beforeAll(async () => {
  rk = await retentionKit();
  fake.bindSessions(rk.kit.env.DB, rk.kit.clock);
  app = createApp({ stores: fake.stores, clock: rk.kit.clock });
}, 30_000);

const call = (method: string, path: string, headers: Record<string, string>, body?: unknown) =>
  app.request(
    path,
    {
      method,
      headers: {
        ...headers,
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    },
    rk.kit.env,
  );
const org = (orgId: string, rest: string) => `/api/v1/orgs/${orgId}/retention/${rest}`;
const platform = (orgId: string, rest: string) =>
  `/api/v1/platform/orgs/${orgId}/retention/${rest}`;
type Holds = {
  items: { id: string; canRelease: boolean; placedByLabel: string; reason: string }[];
};

/** A member of `orgId` with one role: a real user, invitation and membership. */
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

/** Members of one org by role, plus a platform administrator. */
async function people() {
  const admin = await rk.org(['org_admin']);
  const root = await rk.platform();
  return {
    orgId: admin.orgId,
    admin: fake.user(admin.userId),
    reader: await member(admin.orgId, 'read_only'),
    author: await member(admin.orgId, 'template_author'),
    root: fake.session({ userId: root.userId, roles: ['admin', 'user'] }),
  };
}

describe('retention holds routes', () => {
  it('an org admin places and releases an org hold; a reader lists but cannot act', async () => {
    const p = await people();
    const placed = await call('POST', org(p.orgId, 'holds'), p.admin, { reason: 'Inquiry' });
    expect(placed.status).toBe(201);
    const list = (await (await call('GET', org(p.orgId, 'holds'), p.reader)).json()) as Holds;
    expect(list.items).toHaveLength(1);
    expect(list.items[0]).toMatchObject({ reason: 'Inquiry', canRelease: true });
    const id = list.items[0]?.id ?? '';
    expect((await call('POST', org(p.orgId, `holds/${id}/release`), p.reader)).status).toBe(403);
    expect((await call('POST', org(p.orgId, 'holds'), p.reader, { reason: 'x' })).status).toBe(403);
    expect((await call('POST', org(p.orgId, `holds/${id}/release`), p.admin)).status).toBe(200);
    const after = (await (await call('GET', org(p.orgId, 'holds'), p.admin)).json()) as Holds;
    expect(after.items[0]).toMatchObject({ canRelease: false });
  });

  it('a member without audit:read cannot list holds or receipts', async () => {
    const p = await people();
    expect((await call('GET', org(p.orgId, 'holds'), p.author)).status).toBe(403);
    expect((await call('GET', org(p.orgId, 'receipts'), p.author)).status).toBe(403);
  });

  it('an org admin cannot release a platform hold and never learns the administrator', async () => {
    const p = await people();
    expect(
      (await call('POST', platform(p.orgId, 'holds'), p.root, { reason: 'Preserve' })).status,
    ).toBe(201);
    const list = (await (await call('GET', org(p.orgId, 'holds'), p.admin)).json()) as Holds;
    const hold = list.items[0];
    expect(hold).toMatchObject({ placedByLabel: 'PassBook', canRelease: false });
    const denied = await call('POST', org(p.orgId, `holds/${hold?.id}/release`), p.admin);
    expect(denied.status).toBe(403);
    expect(await denied.text()).toContain('RETENTION_HOLD_PLATFORM');
    expect(
      (await call('POST', platform(p.orgId, `holds/${hold?.id}/release`), p.root)).status,
    ).toBe(200);
    const row = await first<{ released_at: number | null }>(
      rk.kit.env.DB,
      'SELECT released_at FROM retention_holds WHERE id = ?',
      [hold?.id ?? ''],
    );
    expect(row?.released_at).not.toBeNull();
  });

  it('org members cannot use the platform routes, and an admin of another org cannot read this one', async () => {
    const p = await people();
    const other = await rk.org(['org_admin']);
    expect((await call('GET', platform(p.orgId, 'holds'), p.admin)).status).toBe(403);
    expect((await call('POST', platform(p.orgId, 'holds'), p.admin, { reason: 'x' })).status).toBe(
      403,
    );
    expect((await call('GET', org(p.orgId, 'holds'), fake.user(other.userId))).status).toBe(403);
  });
});

describe('retention receipts routes', () => {
  it('lists receipts with counts only and downloads one as a file', async () => {
    const p = await people();
    const r = await writeReceipt(rk.kit.ctx, {
      orgId: p.orgId,
      cls: 'scans',
      kind: 'sweep',
      policyDays: 396,
      cutoffAt: 5,
      deleted: 12,
    });
    const list = await call('GET', org(p.orgId, 'receipts'), p.reader);
    const body = (await list.json()) as { items: Record<string, unknown>[] };
    expect(body.items[0]).toMatchObject({ id: r.id, cls: 'scans', deleted: 12, verified: true });
    expect(JSON.stringify(body)).not.toContain(r.mac);
    const file = await call('GET', org(p.orgId, `receipts/${r.id}/download`), p.reader);
    expect(file.status).toBe(200);
    expect(file.headers.get('content-disposition')).toContain(`retention-receipt-${r.id}.json`);
    expect(((await file.json()) as { receipt: { mac: string } }).receipt.mac).toBe(r.mac);
  });

  it("another org's receipt, and a member without audit:read, get no download", async () => {
    const p = await people();
    const mine = await rk.org(['org_admin']);
    const r = await writeReceipt(rk.kit.ctx, {
      orgId: mine.orgId,
      cls: 'events',
      kind: 'sweep',
      deleted: 1,
    });
    // p.admin asks under its own org for an id that belongs to another org's chain.
    expect((await call('GET', org(p.orgId, `receipts/${r.id}/download`), p.admin)).status).toBe(
      404,
    );
    expect((await call('GET', org(mine.orgId, `receipts/${r.id}/download`), p.admin)).status).toBe(
      403,
    );
    expect((await call('GET', org(p.orgId, `receipts/${r.id}/download`), p.author)).status).toBe(
      403,
    );
    expect((await call('GET', org(mine.orgId, `receipts/${r.id}/download`), p.root)).status).toBe(
      403,
    );
    expect(
      (await call('GET', platform(mine.orgId, `receipts/${r.id}/download`), p.root)).status,
    ).toBe(200);
  });
});

describe('platform-scope receipts routes', () => {
  it('lists and downloads receipts of the platform pass for an administrator only', async () => {
    const p = await people();
    const r = await writeReceipt(rk.kit.ctx, {
      orgId: null,
      cls: 'photos',
      kind: 'sweep',
      policyDays: 30,
      deleted: 3,
    });
    const own = await writeReceipt(rk.kit.ctx, {
      orgId: p.orgId,
      cls: 'photos',
      kind: 'sweep',
      deleted: 1,
    });
    const list = (await (
      await call('GET', '/api/v1/platform/retention/receipts', p.root)
    ).json()) as {
      items: { id: string }[];
    };
    expect(list.items.map((i) => i.id)).toContain(r.id);
    expect(list.items.map((i) => i.id)).not.toContain(own.id);
    const file = await call('GET', `/api/v1/platform/retention/receipts/${r.id}/download`, p.root);
    expect(file.status).toBe(200);
    expect(((await file.json()) as { receipt: { orgId: null } }).receipt.orgId).toBeNull();
    expect(
      (await call('GET', `/api/v1/platform/retention/receipts/${own.id}/download`, p.root)).status,
    ).toBe(404);
    expect((await call('GET', '/api/v1/platform/retention/receipts', p.admin)).status).toBe(403);
    expect(
      (await call('GET', `/api/v1/platform/retention/receipts/${r.id}/download`, p.reader)).status,
    ).toBe(403);
  });
});
