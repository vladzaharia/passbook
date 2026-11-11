import { beforeAll, describe, expect, it } from 'vitest';
import { makeApiKey, makeSession, makeUser, runOne } from '../../../../test/helpers/index.ts';
import { first } from '../../platform/db.ts';
import { createApiKeyStore } from '../api-keys/service.ts';
import { createSessionStore } from '../auth/sessions.ts';
import { getOrgRow } from '../orgs/repo.ts';
import { saveOrgBranding } from '../orgs/repo-org-writes.ts';
import { updateSettings } from '../settings/service.ts';
import { grantKitMembership } from './apple-release-test-fixtures.ts';
import { tenantAuthorityOf } from './http.ts';
import { type Kit, setupKit } from './pass-test-fixtures.ts';
import { tenantPassAuthorityValid } from './repo-authority.ts';

let kit: Kit;
beforeAll(async () => {
  kit = await setupKit();
});

async function sessionAuthority() {
  const user = await makeUser(kit.fx);
  await grantKitMembership(kit, kit.org.id, user.id, ['org_admin']);
  const session = await makeSession(kit.fx, { userId: user.id });
  const auth = await createSessionStore(kit.env, kit.clock).resolve(session.cookieValue);
  if (!auth) throw new Error('session fixture missing');
  return tenantAuthorityOf(kit.ctx, auth, kit.org.id, 'passes:operate');
}

const valid = (authority: Awaited<ReturnType<typeof sessionAuthority>>) =>
  tenantPassAuthorityValid(kit.env.DB, authority, kit.clock.now());
const epochs = () =>
  first<{ access_revision: number; config_revision: number }>(
    kit.env.DB,
    'SELECT access_revision, config_revision FROM orgs WHERE id = ?',
    [kit.org.id],
  );

describe('access epoch: org edits do not move it', () => {
  it('keeps captured authority valid across a settings save, a branding save and a rename', async () => {
    const authority = await sessionAuthority();
    const key = await makeApiKey(kit.fx, { orgId: kit.org.id, scopes: ['passes:write'] });
    const keyAuth = await createApiKeyStore(kit.env, kit.clock).resolve(key.secret);
    if (!keyAuth) throw new Error('key fixture missing');
    const before = await epochs();

    await updateSettings(
      kit.ctx,
      { type: 'system', id: null },
      {
        scope: `org:${kit.org.id}`,
        values: { 'support.email': `${kit.fx.ids.id()}@example.test` },
      },
    );
    const row = await getOrgRow(kit.env.DB, kit.org.id);
    if (!row) throw new Error('org fixture missing');
    await saveOrgBranding(
      kit.ctx,
      row,
      JSON.stringify({ accent: kit.fx.ids.id() }),
      kit.clock.now(),
    );
    await runOne(kit.env.DB, 'UPDATE orgs SET name = ? WHERE id = ?', ['Renamed', kit.org.id]);

    const after = await epochs();
    expect(after?.access_revision).toBe(before?.access_revision);
    expect(after?.config_revision).toBeGreaterThan(before?.config_revision ?? 0);
    expect(await valid(authority)).toBe(true);
  });

  it('refuses captured authority once the org was suspended, even after reactivation', async () => {
    const authority = await sessionAuthority();
    const before = await epochs();
    await runOne(kit.env.DB, "UPDATE orgs SET status = 'suspended' WHERE id = ?", [kit.org.id]);
    expect(await valid(authority)).toBe(false);
    await runOne(kit.env.DB, "UPDATE orgs SET status = 'active' WHERE id = ?", [kit.org.id]);
    expect(await valid(authority)).toBe(false);
    expect((await epochs())?.access_revision).toBeGreaterThan(before?.access_revision ?? 0);
    // A fresh capture after reactivation works again.
    expect(await valid(await sessionAuthority())).toBe(true);
  });

  it('refuses revoked membership, session and key', async () => {
    const authority = await sessionAuthority();
    if (authority.kind !== 'session') throw new Error('expected session authority');
    expect(await valid(authority)).toBe(true);
    await runOne(kit.env.DB, 'UPDATE sessions SET revoked_at = ? WHERE id_hash = ?', [
      kit.clock.now(),
      authority.sessionId,
    ]);
    expect(await valid(authority)).toBe(false);

    const membership = await sessionAuthority();
    if (membership.kind !== 'session') throw new Error('expected session authority');
    await runOne(kit.env.DB, 'UPDATE org_memberships SET revoked_at = ? WHERE id = ?', [
      kit.clock.now(),
      membership.membershipId,
    ]);
    expect(await valid(membership)).toBe(false);

    const key = await makeApiKey(kit.fx, { orgId: kit.org.id, scopes: ['passes:write'] });
    const keyAuth = await createApiKeyStore(kit.env, kit.clock).resolve(key.secret);
    if (!keyAuth) throw new Error('key fixture missing');
    const captured = {
      kind: 'api_key' as const,
      orgId: kit.org.id,
      orgUpdatedAt: (await epochs())?.access_revision ?? 0,
      keyId: key.id,
      keyOrgId: kit.org.id,
      scopes: ['passes:write' as const],
      scope: 'passes:write' as const,
      mode: 'live' as const,
    };
    expect(await valid(captured)).toBe(true);
    // Cross-org: the same key never validates against another org's target.
    expect(await valid({ ...captured, orgId: 'other-org' })).toBe(false);
    // Cross-mode: a key bound to live is not valid for test.
    expect(await valid({ ...captured, mode: 'test' })).toBe(false);
    // A scope the key does not hold is not granted by a hand-built snapshot.
    expect(await valid({ ...captured, scope: 'holders:write' })).toBe(false);
    await runOne(kit.env.DB, 'UPDATE api_keys SET revoked_at = ? WHERE id = ?', [
      kit.clock.now(),
      key.id,
    ]);
    expect(await valid(captured)).toBe(false);
  });

  it('accepts work queued before cutover (a persisted updated_at in ms) while the org is active', async () => {
    const authority = await sessionAuthority();
    if (authority.kind !== 'session') throw new Error('expected session authority');
    const legacy = { ...authority, orgUpdatedAt: kit.clock.now() };
    expect(await valid(legacy)).toBe(true);
    // A small wrong revision is still refused: only the ms-sized legacy shape is relaxed.
    expect(await valid({ ...authority, orgUpdatedAt: 999 })).toBe(false);
    await runOne(kit.env.DB, "UPDATE orgs SET status = 'suspended' WHERE id = ?", [kit.org.id]);
    expect(await valid(legacy)).toBe(false);
    await runOne(kit.env.DB, "UPDATE orgs SET status = 'active' WHERE id = ?", [kit.org.id]);
  });
});
