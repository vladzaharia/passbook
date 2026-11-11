import {
  fixtures,
  makeOrg,
  makeSession,
  makeUser,
  type OrgRow,
} from '../../../../test/helpers/index.ts';
import type { OrgRole } from '../../../shared/contracts/org-membership.ts';
import { all, run } from '../../platform/db.ts';
import { harness, type TestHarness } from '../auth/test-support.ts';

export let h: TestHarness;
export let org: OrgRow;
export let other: OrgRow;
export const f = () => fixtures(h.env, h.clock);
export const keyBody = (orgId: string | null) => ({
  name: 'Tenant key',
  scopes: ['passes:read'],
  orgId,
});

export async function setup() {
  h = await harness();
  org = await makeOrg(f());
  other = await makeOrg(f());
}

export function teardown() {
  h.restore();
}

export async function member(role: OrgRole, options: { platformAdmin?: boolean } = {}) {
  const fx = f();
  const user = await makeUser(fx);
  const roles = JSON.stringify([role]);
  const invitationId = fx.ids.id();
  const membershipId = fx.ids.id();
  const now = h.clock.now();
  await run(
    h.env.DB,
    `INSERT INTO org_invitations
      (id, org_id, email, roles, token_hash, created_at, expires_at, accepted_at)
     SELECT ?, ?, primary_email, ?, ?, ?, ?, ? FROM users WHERE id = ?`,
    [invitationId, org.id, roles, fx.ids.token(), now, now + 3600_000, now, user.id],
  );
  await run(
    h.env.DB,
    `INSERT INTO org_memberships (id, org_id, user_id, invitation_id, roles, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [membershipId, org.id, user.id, invitationId, roles, now],
  );
  const session = await makeSession(fx, {
    userId: user.id,
    roles: options.platformAdmin ? ['admin', 'user'] : ['user'],
  });
  return { user, session, membershipId };
}

export async function platformSession() {
  const user = await makeUser(f());
  return makeSession(f(), { userId: user.id, roles: ['admin', 'user'] });
}

export const list = (headers: Record<string, string>, orgId?: string) =>
  h.call(`/api/v1/api-keys?orgId=${encodeURIComponent(orgId ?? 'null')}`, { headers });
export const create = (headers: Record<string, string>, json: object) =>
  h.call('/api/v1/api-keys', { method: 'POST', headers, json });
export const revoke = (headers: Record<string, string>, id: string, orgId?: string) =>
  h.call(
    `/api/v1/api-keys/${encodeURIComponent(id)}?orgId=${encodeURIComponent(orgId ?? 'null')}`,
    { method: 'DELETE', headers },
  );

export async function keyState() {
  return {
    keys: await all(h.env.DB, 'SELECT * FROM api_keys ORDER BY id'),
    audits: await all(
      h.env.DB,
      "SELECT * FROM audit_log WHERE action IN ('api_key.create', 'api_key.revoke') ORDER BY id",
    ),
  };
}

export interface CreatedKey {
  id: string;
  orgId: string | null;
  createdBy: string;
  secret: string;
  scopes: string[];
  mode: string;
}
export interface KeyPage {
  items: { id: string; orgId: string | null }[];
  revokedCount: number;
}
