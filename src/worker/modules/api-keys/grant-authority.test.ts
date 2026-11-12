import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { makeApiKey, runOne } from '../../../../test/helpers/index.ts';
import { all, first } from '../../platform/db.ts';
import { createServiceContext } from '../../platform/service-context.ts';
import { createSessionStore } from '../auth/sessions.ts';
import { tenantAuthorityOf } from '../passes/http.ts';
import { updateSettings } from '../settings/service.ts';
import type { ApiKeyAuthority } from './access.ts';
import { type ApiKeyRow, createKey, revokeKey } from './repo.ts';
import { f, h, member, org, other, setup, teardown } from './test-kit.ts';

beforeEach(setup);
afterEach(teardown);

const ctx = () => createServiceContext(h.env, { clock: h.clock });
const row = (orgId: string | null, scopes: string[], id = f().ids.id()): ApiKeyRow => ({
  id,
  org_id: orgId,
  name: 'Grant key',
  prefix: id.slice(-8),
  key_hash: `hash-${id}`,
  scopes: JSON.stringify(scopes),
  mode: 'live',
  created_by: null,
  created_at: h.clock.now(),
  last_used_at: null,
  expires_at: null,
  revoked_at: null,
});
const entry = (action: string, targetId: string) => ({
  orgId: org.id,
  actorType: 'user' as const,
  actorId: 'x',
  action,
  targetType: 'api_key',
  targetId,
});
const keyRow = (id: string) =>
  first<{ revoked_at: number | null }>(h.env.DB, 'SELECT revoked_at FROM api_keys WHERE id = ?', [
    id,
  ]);

async function authorityFor(role: 'integration_admin' | 'org_admin') {
  const m = await member(role);
  const auth = await createSessionStore(h.env, h.clock).resolve(m.session.cookieValue);
  if (!auth) throw new Error('session fixture missing');
  const authority = await tenantAuthorityOf(ctx(), auth, org.id, 'integrations:manage');
  if (authority.kind !== 'session') throw new Error('expected session authority');
  return { ...m, authority: authority as ApiKeyAuthority & { kind: 'session' } };
}

describe('API key grants: safety', () => {
  it('refuses scope escalation even when the authority snapshot claims more roles', async () => {
    const { authority } = await authorityFor('integration_admin');
    const forged = { ...authority, roles: ['org_admin' as const] };
    const key = row(org.id, ['passes:write']);
    await expect(
      createKey(ctx(), key, forged, entry('api_key.create', key.id)),
    ).rejects.toMatchObject({ status: 403, code: 'ACTOR_CHANGED' });
    expect(await keyRow(key.id)).toBeNull();
    // The scope the role really holds is fine.
    const ok = row(org.id, ['connections:read']);
    await createKey(ctx(), ok, authority, entry('api_key.create', ok.id));
    expect(await keyRow(ok.id)).toEqual({ revoked_at: null });
  });

  it('refuses a hand-built capability the membership does not hold', async () => {
    const { authority } = await authorityFor('integration_admin');
    const reader = await member('read_only');
    const auth = await createSessionStore(h.env, h.clock).resolve(reader.session.cookieValue);
    if (!auth) throw new Error('session fixture missing');
    const read = await tenantAuthorityOf(ctx(), auth, org.id, 'org:read');
    if (read.kind !== 'session') throw new Error('expected session authority');
    const forged = { ...read, capability: 'integrations:manage' as const };
    const key = row(org.id, ['connections:read']);
    await expect(
      createKey(ctx(), key, forged, entry('api_key.create', key.id)),
    ).rejects.toMatchObject({ status: 403, code: 'ACTOR_CHANGED' });
    expect(authority.capability).toBe('integrations:manage');
  });

  it('refuses a key for another org than the authority, and a cross-org revoke', async () => {
    const { authority } = await authorityFor('org_admin');
    const foreign = row(other.id, ['passes:read']);
    await expect(
      createKey(ctx(), foreign, authority, entry('api_key.create', foreign.id)),
    ).rejects.toMatchObject({ status: 403 });
    expect(await keyRow(foreign.id)).toBeNull();

    const theirs = await makeApiKey(f(), { orgId: other.id });
    await expect(
      revokeKey(ctx(), theirs.id, authority, entry('api_key.revoke', theirs.id)),
    ).rejects.toMatchObject({ status: 409, code: 'API_KEY_NOT_FOUND' });
    expect(await keyRow(theirs.id)).toEqual({ revoked_at: null });
    const platform = await makeApiKey(f());
    await expect(
      revokeKey(ctx(), platform.id, authority, entry('api_key.revoke', platform.id)),
    ).rejects.toMatchObject({ status: 409 });
    expect(await keyRow(platform.id)).toEqual({ revoked_at: null });
  });

  it.each([
    [
      'membership revoked',
      'UPDATE org_memberships SET revoked_at = ? WHERE id = ?',
      'm',
      'ACTOR_CHANGED',
    ],
    [
      'session revoked',
      'UPDATE sessions SET revoked_at = ? WHERE user_id = ?',
      'u',
      'ACTOR_CHANGED',
    ],
    [
      'org suspended',
      "UPDATE orgs SET status = 'suspended', updated_at = ? WHERE id = ?",
      'o',
      'ORG_ACCESS_CHANGED',
    ],
  ] as const)('refuses create and revoke after %s', async (_name, sql, bind, code) => {
    const { authority, membershipId, user } = await authorityFor('org_admin');
    const existing = await makeApiKey(f(), { orgId: org.id });
    const id = bind === 'm' ? membershipId : bind === 'u' ? user.id : org.id;
    await runOne(h.env.DB, sql, [h.clock.now(), id]);
    const key = row(org.id, ['passes:read']);
    await expect(
      createKey(ctx(), key, authority, entry('api_key.create', key.id)),
    ).rejects.toMatchObject({ status: 403, code });
    await expect(
      revokeKey(ctx(), existing.id, authority, entry('api_key.revoke', existing.id)),
    ).rejects.toMatchObject({ status: 403, code });
    expect(await keyRow(key.id)).toBeNull();
    expect(await keyRow(existing.id)).toEqual({ revoked_at: null });
  });

  it('refuses an authority captured before a suspension and reactivation', async () => {
    const { authority } = await authorityFor('org_admin');
    await runOne(h.env.DB, "UPDATE orgs SET status = 'suspended' WHERE id = ?", [org.id]);
    await runOne(h.env.DB, "UPDATE orgs SET status = 'active' WHERE id = ?", [org.id]);
    const key = row(org.id, ['passes:read']);
    await expect(
      createKey(ctx(), key, authority, entry('api_key.create', key.id)),
    ).rejects.toMatchObject({ status: 403, code: 'ORG_ACCESS_CHANGED' });
    expect(await keyRow(key.id)).toBeNull();
  });

  it('refuses a platform key from a session that is not an admin, and writes nothing', async () => {
    const m = await member('org_admin');
    const key = row(null, ['passes:read']);
    await expect(
      createKey(
        ctx(),
        key,
        { kind: 'platform', userId: m.user.id, sessionId: 'not-a-session' },
        entry('api_key.create', key.id),
      ),
    ).rejects.toMatchObject({ status: 403, code: 'ACTOR_CHANGED' });
    expect(await keyRow(key.id)).toBeNull();
  });
});

describe('API key grants: liveness', () => {
  it('creates and revokes after a settings save, and audits a revoke once', async () => {
    const { authority } = await authorityFor('org_admin');
    await updateSettings(
      ctx(),
      { type: 'system', id: null },
      {
        scope: `org:${org.id}`,
        values: { 'support.email': 'help@example.test' },
      },
    );
    const key = row(org.id, ['passes:read']);
    await createKey(ctx(), key, authority, entry('api_key.create', key.id));
    await revokeKey(ctx(), key.id, authority, entry('api_key.revoke', key.id));
    await revokeKey(ctx(), key.id, authority, entry('api_key.revoke', key.id));
    expect((await keyRow(key.id))?.revoked_at).not.toBeNull();
    expect(
      await all(h.env.DB, 'SELECT action FROM audit_log WHERE target_id = ? ORDER BY id', [key.id]),
    ).toEqual([{ action: 'api_key.create' }, { action: 'api_key.revoke' }]);
  });
});
