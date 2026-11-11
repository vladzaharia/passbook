import { describe, expect, it } from 'vitest';
import { makeApiKey } from '../../../test/helpers/index.ts';
import { grant } from './authority.ts';
import { codeOf, count, db, refusal } from './authority-ext-fixtures.ts';
import type { Principal } from './authority-principal.ts';
import { setupGrant } from './authority-test-fixtures.ts';
import { first, run } from './db.ts';

const entry = (orgId: string | null, action: string) => ({
  at: 1,
  orgId,
  actorType: 'api_key',
  actorId: 'k',
  action,
  targetType: null,
  targetId: null,
  requestId: null,
  ipPrefix: null,
  detail: null,
});
const audited = (action: string) =>
  first<{ org_id: string | null }>(db, 'SELECT org_id FROM audit_log WHERE action = ?', [action]);

describe('api_key principal naming an org', () => {
  const key = (keyId: string, orgId?: string, extra: Record<string, unknown> = {}): Principal =>
    ({
      kind: 'api_key',
      keyId,
      scope: 'passes:write',
      ...(orgId ? { orgId } : {}),
      ...extra,
    }) as Principal;

  it('a platform key writes the org it names, with its own mode', async () => {
    const { s, route } = await setupGrant('pk-ok');
    const platformKey = await makeApiKey(s.f, { orgId: null, mode: 'test' });
    const h = grant(route, {
      purpose: 'org_mode.test.pk',
      principal: key(platformKey.id, s.org.id),
    });
    h.audit(entry(s.org.id, 'pk.ok2'));
    h.upsert(
      'scans',
      [
        'id',
        'actor_type',
        'actor_id',
        'actor_key',
        'idempotency_key',
        'request_hash',
        'method',
        'at',
      ],
      ['pk-scan', 'user', 'u', 'k', 'i', 'h', 'manual', 1],
      { doNothing: true },
    );
    await h.commit();
    expect((await audited('pk.ok2'))?.org_id).toBe(s.org.id);
    expect(await first(db, "SELECT org_id, mode FROM scans WHERE id = 'pk-scan'")).toEqual({
      org_id: s.org.id,
      mode: 'test',
    });
  });

  it('refuses a platform key that names no org, an org-bound key naming another org, and a bad scope', async () => {
    const a = await setupGrant('pk-a');
    const b = await setupGrant('pk-b');
    const platformKey = await makeApiKey(a.s.f, { orgId: null });
    const bound = await makeApiKey(a.s.f, { orgId: a.s.org.id });
    const commit = (p: Principal, purpose = 'org_mode.test.pk') =>
      grant(a.route, { purpose, principal: p }).commit();
    expect(await refusal(commit(key(platformKey.id)))).toMatchObject({ code: 'ACTOR_CHANGED' });
    expect(await refusal(commit(key(bound.id, b.s.org.id)))).toMatchObject({
      code: 'ACTOR_CHANGED',
    });
    await expect(commit(key(bound.id, a.s.org.id))).resolves.toBeDefined();
    await expect(commit(key(bound.id))).resolves.toBeDefined();
    expect(
      codeOf(() =>
        grant(a.route, { purpose: 'platform.test.pk', principal: key(platformKey.id, a.s.org.id) }),
      ),
    ).toBe('GRANT_BAD_PRINCIPAL');
    expect(await refusal(commit(key(platformKey.id, 'no-such-org')))).toMatchObject({
      code: 'ORG_ACCESS_CHANGED',
    });
  });

  it('refuses a suspended named org, a stale org revision and a revoked key', async () => {
    const { s, route } = await setupGrant('pk-state');
    const platformKey = await makeApiKey(s.f, { orgId: null });
    const commit = (extra: Record<string, unknown> = {}) =>
      grant(route, {
        purpose: 'org_mode.test.pk',
        principal: key(platformKey.id, s.org.id, extra),
      }).commit();
    const rev =
      (
        await first<{ r: number }>(db, 'SELECT access_revision AS r FROM orgs WHERE id = ?', [
          s.org.id,
        ])
      )?.r ?? 0;
    await expect(commit({ orgAccessRevision: rev })).resolves.toBeDefined();
    await run(db, "UPDATE orgs SET status = 'suspended' WHERE id = ?", [s.org.id]);
    expect(await refusal(commit())).toMatchObject({ code: 'ORG_ACCESS_CHANGED' });
    await run(db, "UPDATE orgs SET status = 'active' WHERE id = ?", [s.org.id]);
    expect(await refusal(commit({ orgAccessRevision: rev }))).toMatchObject({
      code: 'ORG_ACCESS_CHANGED',
    });
    await expect(commit()).resolves.toBeDefined();
    await run(db, 'UPDATE api_keys SET revoked_at = 1 WHERE id = ?', [platformKey.id]);
    expect(await refusal(commit())).toMatchObject({ code: 'ACTOR_CHANGED' });
  });
});

describe('users.access_revision and deferred membership principals', () => {
  const rev = async (id: string) =>
    (await first<{ r: number }>(db, 'SELECT access_revision AS r FROM users WHERE id = ?', [id]))
      ?.r ?? 0;

  it('moves with status only; a name or login change does not bump it', async () => {
    const { s } = await setupGrant('ue-bump');
    const base = await rev(s.user.id);
    await run(
      db,
      "UPDATE users SET name = 'New', last_login_at = 5, last_roles = '[]' WHERE id = ?",
      [s.user.id],
    );
    expect(await rev(s.user.id)).toBe(base);
    await run(db, "UPDATE users SET status = 'disabled' WHERE id = ?", [s.user.id]);
    expect(await rev(s.user.id)).toBe(base + 1);
    await run(db, "UPDATE users SET status = 'active' WHERE id = ?", [s.user.id]);
    expect(await rev(s.user.id)).toBe(base + 2);
    await expect(
      run(db, 'UPDATE users SET access_revision = 1 WHERE id = ?', [s.user.id]),
    ).rejects.toThrow(/epoch_monotonic/);
  });

  it('disable, re-enable, run: a deferred grant that captured the revision is refused (actor)', async () => {
    const { s, route, member } = await setupGrant('ue-revive');
    const captured = await rev(s.user.id);
    const run1 = () =>
      grant(route, {
        purpose: 'org_mode.test.ue',
        principal: member({ userAccessRevision: captured }),
      }).commit();
    await expect(run1()).resolves.toBeDefined();
    await run(db, "UPDATE users SET status = 'disabled' WHERE id = ?", [s.user.id]);
    expect(await refusal(run1())).toMatchObject({ code: 'ACTOR_CHANGED' });
    await run(db, "UPDATE users SET status = 'active' WHERE id = ?", [s.user.id]);
    expect(await refusal(run1())).toMatchObject({ code: 'ACTOR_CHANGED' });
    expect(
      await refusal(grant(route, { purpose: 'org_mode.test.ue', principal: member() }).commit()),
    ).toMatchObject({ code: 'ACTOR_CHANGED' });
    await expect(
      grant(route, {
        purpose: 'org_mode.test.ue',
        principal: member({ userAccessRevision: captured + 2 }),
      }).commit(),
    ).resolves.toBeDefined();
  });

  it('only a job context builds a deferred principal, unless the caller names allowRequestContext', async () => {
    const { s, ctx, route } = await setupGrant('ue-context');
    const deferred = (extra: Record<string, unknown> = {}): Principal =>
      ({
        kind: 'membership',
        membershipId: s.membershipId,
        mode: 'live',
        via: 'deferred',
        userAccessRevision: 1,
        orgAccessRevision: 1,
        ...extra,
      }) as Principal;
    const build = (c: typeof ctx, extra?: Record<string, unknown>) =>
      codeOf(() => grant(c, { purpose: 'org_mode.test.ue', principal: deferred(extra) }));
    expect(build(route)).toBe('GRANT_BAD_PRINCIPAL');
    expect(build(ctx)).toBeNull();
    expect(build(route, { allowRequestContext: true })).toBeNull();
    const session = { ...deferred(), via: 'session', sessionIdHash: 'h' } as unknown as Principal;
    expect(
      codeOf(() => grant(route, { purpose: 'org_mode.test.ue', principal: session })),
    ).toBeNull();
    expect(await count('SELECT count(*) AS n FROM authority_grants')).toBe(0);
  });
});
