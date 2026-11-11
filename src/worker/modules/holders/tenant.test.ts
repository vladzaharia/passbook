import { beforeAll, describe, expect, it, vi } from 'vitest';
import {
  editApiKeyIdentity,
  makeApiKey,
  makeOrg,
  makeSession,
  makeUser,
} from '../../../../test/helpers/index.ts';
import { createApp } from '../../app.ts';
import { all, first, run } from '../../platform/db.ts';
import type { AppEnv } from '../../platform/env.ts';
import { sha256Hex } from '../../platform/ids.ts';
import { createAuthStores } from '../../stores.ts';
import { createBundle } from '../bundles/service.ts';
import { jobCtxOf } from '../delivery/delivery-test-fixtures.ts';
import {
  finishCredentialTransfer,
  startCredentialTransfer,
} from '../passes/credential-transfer.ts';
import { depsOf, overrideDeps } from '../passes/deps.ts';
import { tenantAuthorityOf } from '../passes/http.ts';
import { type Kit, setupKit } from '../passes/pass-test-fixtures.ts';
import { getPass } from '../passes/repo-read-pass.ts';
import { updateSettings } from '../settings/service.ts';
import { getHolderPass } from './repo.ts';
import {
  assignHolder,
  clearBlock,
  reassignHolder,
  runAttachHookA,
  unassignHolder,
} from './service.ts';
import { eventMember, tenantKeyAuthority } from './test-auth-fixtures.ts';

let kit: Kit;
let app: ReturnType<typeof createApp>;
beforeAll(async () => {
  kit = await setupKit();
  app = createApp({ stores: createAuthStores, clock: kit.clock });
});
const request = (path: string, headers: Record<string, string>, body?: unknown) =>
  app.request(
    `https://wallet.test/api/v1/holders${path}`,
    {
      method: body === undefined ? 'GET' : 'POST',
      headers: {
        ...headers,
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    },
    kit.env,
  );
const actor = { type: 'system', id: null } as const;
const holderEmail = () => `holder-${kit.fx.ids.id()}@example.test`;

function interceptHolderMutation(
  db: D1Database,
  when: 'before' | 'after',
  change: () => Promise<unknown>,
) {
  const writes = new WeakSet<D1PreparedStatement>();
  const prepare = db.prepare.bind(db);
  const batch = db.batch.bind(db);
  let fired = false;
  const prepareSpy = vi.spyOn(db, 'prepare').mockImplementation((sql) => {
    const statement = prepare(sql);
    if (
      !/^\s*(?:INSERT INTO pass_credential_transfers|DELETE FROM pass_attach_blocks)\b/i.test(sql)
    )
      return statement;
    return new Proxy(statement, {
      get(prepared, key) {
        if (key === 'bind')
          return (...values: unknown[]) => {
            const bound = prepared.bind(...values);
            writes.add(bound);
            return bound;
          };
        const value = Reflect.get(prepared, key, prepared);
        return typeof value === 'function' ? value.bind(prepared) : value;
      },
    });
  });
  const batchSpy = vi.spyOn(db, 'batch').mockImplementation(async (statements) => {
    if (fired || !statements.some((statement) => writes.has(statement))) return batch(statements);
    fired = true;
    if (when === 'before') await change();
    const result = await batch(statements);
    if (when === 'after') await change();
    return result;
  });
  return () => {
    batchSpy.mockRestore();
    prepareSpy.mockRestore();
  };
}

describe('holder tenant access', () => {
  it('requires explicit organization and membership even for a platform admin', async () => {
    const user = await makeUser(kit.fx);
    const session = await makeSession(kit.fx, { userId: user.id, roles: ['admin', 'user'] });
    const pass = await kit.pass();
    expect((await request('', session.headers)).status).toBe(422);
    expect((await request(`?orgId=${kit.org.id}`, session.headers)).status).toBe(403);
    expect(
      (await request('/assign', session.headers, { passId: pass.id, email: 'new@example.com' }))
        .status,
    ).toBe(404);
  });

  it('allows operators, allows read-only lists but masks denied mutations and foreign passes', async () => {
    const operator = await eventMember(kit, kit.org.id, ['pass_operator']);
    const reader = await eventMember(kit, kit.org.id, ['read_only']);
    const ordinary = await makeSession(kit.fx, { userId: operator.user.id, roles: ['user'] });
    const own = await kit.pass();
    const other = await makeOrg(kit.fx);
    const foreign = await kit.pass({ orgId: other.id });
    expect((await request(`?orgId=${kit.org.id}`, reader.session.headers)).status).toBe(200);
    expect((await request(`/${own.id}`, reader.session.headers)).status).toBe(200);
    expect((await request(`/${foreign.id}`, reader.session.headers)).status).toBe(403);
    expect(
      (
        await request('/assign', reader.session.headers, {
          passId: own.id,
          email: 'reader@example.com',
        })
      ).status,
    ).toBe(404);
    expect(
      (await request('/assign', ordinary.headers, { passId: own.id, email: 'member@example.com' }))
        .status,
    ).toBe(200);
    expect((await request('/unassign', ordinary.headers, { passId: foreign.id })).status).toBe(404);
    expect(
      (
        await request(
          '/unassign',
          { ...ordinary.headers, 'x-passbook-mode': 'test' },
          { passId: foreign.id },
        )
      ).status,
    ).toBe(404);
    const untouched = await kit.pass();
    expect(
      (
        await request('/assign-bulk', ordinary.headers, {
          items: [
            { passId: untouched.id, email: 'first@example.com' },
            { passId: foreign.id, email: 'foreign@example.com' },
          ],
        })
      ).status,
    ).toBe(404);
    expect((await getPass(kit.env.DB, untouched.id))?.holderEmail).toBeNull();
  });

  it.each(['list', 'detail'] as const)(
    'rechecks tenant authority after reading holder %s',
    async (kind) => {
      const reader = await eventMember(kit, kit.org.id, ['read_only']);
      const pass = await kit.pass();
      let revoked = false;
      const db = new Proxy(kit.env.DB, {
        get(target, prop) {
          if (prop === 'prepare')
            return (sql: string) => {
              const statement = target.prepare(sql);
              if (!/SELECT (?:pass_id, )?user_id FROM pass_attach_blocks/i.test(sql))
                return statement;
              return new Proxy(statement, {
                get(prepared, key) {
                  if (key === 'bind')
                    return (...values: unknown[]) => {
                      const bound = prepared.bind(...values);
                      return new Proxy(bound, {
                        get(query, method) {
                          if (method === 'all')
                            return async () => {
                              if (!revoked) {
                                revoked = true;
                                await run(
                                  kit.env.DB,
                                  'UPDATE org_memberships SET revoked_at = ? WHERE id = ?',
                                  [kit.clock.now(), reader.membership],
                                );
                              }
                              return query.all();
                            };
                          const value = Reflect.get(query, method, query);
                          return typeof value === 'function' ? value.bind(query) : value;
                        },
                      });
                    };
                  const value = Reflect.get(prepared, key, prepared);
                  return typeof value === 'function' ? value.bind(prepared) : value;
                },
              });
            };
          const value = Reflect.get(target, prop, target);
          return typeof value === 'function' ? value.bind(target) : value;
        },
      });
      const env: AppEnv = { ...kit.env, DB: db };
      const path = kind === 'list' ? `?orgId=${kit.org.id}` : `/${pass.id}`;
      const response = await app.request(
        `https://wallet.test/api/v1/holders${path}`,
        { headers: reader.session.headers },
        env,
      );
      expect(revoked).toBe(true);
      expect(response.status).toBe(403);
    },
  );

  it.each([
    ['/assign', (passId: string) => ({ passId, email: 'x@example.com' })],
    ['/assign-bulk', (passId: string) => ({ items: [{ passId, email: 'x@example.com' }] })],
    ['/reassign', (passId: string) => ({ passId, email: 'x@example.com' })],
    ['/unassign', (passId: string) => ({ passId })],
    ['/clear-block', (passId: string) => ({ passId, userId: 'missing' })],
  ] as const)('masks read-only and cross-org denial for %s', async (path, body) => {
    const reader = await eventMember(kit, kit.org.id, ['read_only']);
    const operator = await eventMember(kit, kit.org.id, ['pass_operator']);
    const own = await kit.pass();
    const foreign = await kit.pass({ orgId: (await makeOrg(kit.fx)).id });
    expect((await request(path, reader.session.headers, body(own.id))).status).toBe(404);
    expect((await request(path, operator.session.headers, body(foreign.id))).status).toBe(404);
    expect((await getPass(kit.env.DB, own.id))?.holderEmail).toBeNull();
    expect((await getPass(kit.env.DB, foreign.id))?.holderEmail).toBeNull();
  });
  it.each(['/assign', '/assign-bulk', '/reassign', '/unassign', '/clear-block'])(
    'allows an operator to perform %s in their organization',
    async (path) => {
      const operator = await eventMember(kit, kit.org.id, ['pass_operator']);
      const pass = await kit.pass();
      const user = await makeUser(kit.fx);
      await run(
        kit.env.DB,
        'INSERT INTO pass_attach_blocks (pass_id, user_id, created_at) VALUES (?, ?, ?)',
        [pass.id, user.id, kit.clock.now()],
      );
      const item = { passId: pass.id, email: 'operator@example.com' };
      const body =
        path === '/assign-bulk'
          ? { items: [item] }
          : path === '/clear-block'
            ? { passId: pass.id, userId: user.id }
            : path === '/unassign'
              ? { passId: pass.id }
              : item;
      expect((await request(path, operator.session.headers, body)).status).toBe(200);
    },
  );

  it('preserves key scopes and organization fences', async () => {
    const pass = await kit.pass();
    const read = await makeApiKey(kit.fx, { orgId: kit.org.id, scopes: ['passes:read'] });
    const write = await makeApiKey(kit.fx, { orgId: kit.org.id, scopes: ['holders:write'] });
    const foreignOrg = await makeOrg(kit.fx);
    const foreign = await kit.pass({ orgId: foreignOrg.id });
    // /api/v1 compatibility: an organization-bound key defaults to its own organization.
    expect((await request('', read.headers)).status).toBe(200);
    expect((await request(`?orgId=${foreignOrg.id}`, read.headers)).status).toBe(403);
    expect(
      (
        await request('/assign', write.headers, {
          passId: foreign.id,
          email: 'foreign@example.com',
        })
      ).status,
    ).toBe(404);
    expect((await request(`/${pass.id}`, read.headers)).status).toBe(200);
    expect((await request(`/${foreign.id}`, read.headers)).status).toBe(404);
    expect((await request(`/${pass.id}`, write.headers)).status).toBe(403);
    expect((await request(`?orgId=${kit.org.id}`, read.headers)).status).toBe(200);
    expect(
      (await request('/assign', read.headers, { passId: pass.id, email: 'no@example.com' })).status,
    ).toBe(403);
    expect(
      (await request('/assign', write.headers, { passId: pass.id, email: 'yes@example.com' }))
        .status,
    ).toBe(200);
    expect((await getPass(kit.env.DB, foreign.id))?.holderEmail).toBeNull();
  });

  it.each(['membership', 'session', 'key', 'key-scope', 'key-mode'] as const)(
    'fences a changed %s at the write and leaves side effects unchanged',
    async (which) => {
      const member = await eventMember(kit, kit.org.id, ['pass_operator']);
      const key = await makeApiKey(kit.fx, { orgId: kit.org.id, scopes: ['holders:write'] });
      const stores = createAuthStores(kit.env);
      const auth = which.startsWith('key')
        ? null
        : await stores.sessions.resolve(member.session.cookieValue);
      if (!which.startsWith('key') && !auth) throw new Error('Missing credential fixture');
      const requester = which.startsWith('key')
        ? { type: 'api_key' as const, id: key.id }
        : { type: 'user' as const, id: member.user.id };
      const pass = await kit.pass();
      const bundle = await createBundle(
        jobCtxOf(kit),
        actor,
        'live',
        {
          orgId: kit.org.id,
          passIds: [pass.id],
          name: 'Preserved',
          holderEmail: 'preserved@example.com',
        },
        { kind: 'system' },
      );
      const before = await getPass(kit.env.DB, pass.id);
      const authorize = async (orgId: string) => {
        const authority = auth
          ? await tenantAuthorityOf(jobCtxOf(kit), auth, orgId, 'passes:operate')
          : await tenantKeyAuthority(kit, key, 'holders:write', orgId);
        if (which === 'membership')
          await run(kit.env.DB, 'UPDATE org_memberships SET revoked_at = ? WHERE id = ?', [
            kit.clock.now(),
            member.membership,
          ]);
        if (which === 'session')
          await run(kit.env.DB, 'UPDATE sessions SET revoked_at = ? WHERE id_hash = ?', [
            kit.clock.now(),
            await sha256Hex(member.session.cookieValue),
          ]);
        if (which === 'key')
          await run(kit.env.DB, 'UPDATE api_keys SET revoked_at = ? WHERE id = ?', [
            kit.clock.now(),
            key.id,
          ]);
        if (which === 'key-scope')
          await editApiKeyIdentity(kit.env.DB, 'UPDATE api_keys SET scopes = ? WHERE id = ?', [
            JSON.stringify(['passes:read']),
            key.id,
          ]);
        if (which === 'key-mode')
          await editApiKeyIdentity(kit.env.DB, "UPDATE api_keys SET mode = 'test' WHERE id = ?", [
            key.id,
          ]);
        return authority;
      };
      await expect(
        assignHolder(
          jobCtxOf(kit),
          requester,
          { passId: pass.id, email: 'revoked@example.com' },
          null,
          authorize,
        ),
      ).rejects.toBeDefined();
      const after = await getPass(kit.env.DB, pass.id);
      expect(after).toMatchObject({
        holderEmail: before?.holderEmail,
        ownerUserId: before?.ownerUserId,
        version: before?.version,
        downloadToken: before?.downloadToken,
        linkGeneration: before?.linkGeneration,
      });
      expect(
        await first(kit.env.DB, 'SELECT 1 FROM bundle_passes WHERE bundle_id = ? AND pass_id = ?', [
          bundle.id,
          pass.id,
        ]),
      ).not.toBeNull();
      expect(
        await first(
          kit.env.DB,
          "SELECT 1 FROM audit_log WHERE target_id = ? AND action = 'holder.assign'",
          [pass.id],
        ),
      ).toBeNull();
    },
  );

  // updated_at is a timestamp, not authority: moving it changes nothing for a holder change.
  it('does not fence a holder change on the org timestamp', async () => {
    const org = await makeOrg(kit.fx);
    const member = await eventMember(kit, org.id, ['pass_operator']);
    const session = await createAuthStores(kit.env).sessions.resolve(member.session.cookieValue);
    if (!session) throw new Error('Missing session fixture');
    const pass = await kit.pass({ orgId: org.id });
    const authority = await tenantAuthorityOf(jobCtxOf(kit), session, org.id, 'passes:operate');
    await run(kit.env.DB, 'UPDATE orgs SET updated_at = updated_at + 1 WHERE id = ?', [org.id]);
    await assignHolder(
      jobCtxOf(kit),
      { type: 'user', id: member.user.id },
      { passId: pass.id, email: 'changed@example.com' },
      null,
      async () => authority,
    );
    expect((await getPass(kit.env.DB, pass.id))?.holderEmail).toBe('changed@example.com');
  });

  it.each(['suspend', 'suspend and reactivate'] as const)(
    'fences organization %s at mutation time',
    async (change) => {
      const org = await makeOrg(kit.fx);
      const member = await eventMember(kit, org.id, ['pass_operator']);
      const session = await createAuthStores(kit.env).sessions.resolve(member.session.cookieValue);
      if (!session) throw new Error('Missing session fixture');
      const pass = await kit.pass({ orgId: org.id });
      const before = await getPass(kit.env.DB, pass.id);
      const authority = await tenantAuthorityOf(jobCtxOf(kit), session, org.id, 'passes:operate');
      await run(kit.env.DB, "UPDATE orgs SET status = 'suspended' WHERE id = ?", [org.id]);
      if (change === 'suspend and reactivate')
        await run(kit.env.DB, "UPDATE orgs SET status = 'active' WHERE id = ?", [org.id]);
      await expect(
        assignHolder(
          jobCtxOf(kit),
          { type: 'user', id: member.user.id },
          { passId: pass.id, email: 'changed@example.com' },
          null,
          async () => authority,
        ),
      ).rejects.toMatchObject({
        code: expect.stringMatching(/^(ORG_ACCESS_CHANGED|HOLDER_CHANGED)$/),
      });
      const after = await getPass(kit.env.DB, pass.id);
      expect(after).toMatchObject({
        holderEmail: before?.holderEmail,
        version: before?.version,
        linkGeneration: before?.linkGeneration,
        downloadToken: before?.downloadToken,
      });
      expect(
        await first(
          kit.env.DB,
          "SELECT 1 FROM audit_log WHERE target_id = ? AND action = 'holder.assign'",
          [pass.id],
        ),
      ).toBeNull();
    },
  );

  it('does not accept a read-only authority as a write capability', async () => {
    const member = await eventMember(kit, kit.org.id, ['read_only']);
    const session = await createAuthStores(kit.env).sessions.resolve(member.session.cookieValue);
    if (!session) throw new Error('Missing session fixture');
    const authority = await tenantAuthorityOf(jobCtxOf(kit), session, kit.org.id, 'passes:read');
    const pass = await kit.pass();
    await expect(
      assignHolder(
        jobCtxOf(kit),
        { type: 'user', id: member.user.id },
        { passId: pass.id, email: 'read-only@example.com' },
        null,
        async () => authority,
      ),
    ).rejects.toMatchObject({ code: 'HOLDER_CHANGED' });
    expect((await getPass(kit.env.DB, pass.id))?.holderEmail).toBeNull();
    expect(
      await first(
        kit.env.DB,
        "SELECT 1 FROM audit_log WHERE target_id = ? AND action = 'holder.assign'",
        [pass.id],
      ),
    ).toBeNull();
  });

  it.each(['assign', 'clear_block'] as const)(
    'does not %s when an attempted organization move is rejected',
    async (operation) => {
      const member = await eventMember(kit, kit.org.id, ['pass_operator']);
      const session = await createAuthStores(kit.env).sessions.resolve(member.session.cookieValue);
      if (!session) throw new Error('Missing session fixture');
      const foreignOrg = await makeOrg(kit.fx);
      const user = await makeUser(kit.fx);
      const pass = await kit.pass();
      const bundle = await createBundle(
        jobCtxOf(kit),
        actor,
        'live',
        {
          orgId: kit.org.id,
          passIds: [pass.id],
          name: 'Org race',
          holderEmail: 'bundle@example.com',
        },
        { kind: 'system' },
      );
      await run(
        kit.env.DB,
        'INSERT INTO pass_attach_blocks (pass_id, user_id, created_at) VALUES (?, ?, ?)',
        [pass.id, user.id, kit.clock.now()],
      );
      const before = await getPass(kit.env.DB, pass.id);
      const authorize = async (orgId: string) => {
        const authority = await tenantAuthorityOf(jobCtxOf(kit), session, orgId, 'passes:operate');
        await run(kit.env.DB, 'UPDATE passes SET org_id = ? WHERE id = ?', [
          foreignOrg.id,
          pass.id,
        ]);
        return authority;
      };
      const requester = { type: 'user' as const, id: member.user.id };
      const result =
        operation === 'assign'
          ? assignHolder(
              jobCtxOf(kit),
              requester,
              { passId: pass.id, email: 'after@example.com' },
              null,
              authorize,
            )
          : clearBlock(
              jobCtxOf(kit),
              requester,
              { passId: pass.id, userId: user.id },
              null,
              authorize,
            );
      await expect(result).rejects.toBeDefined();
      const after = await getPass(kit.env.DB, pass.id);
      expect(after).toMatchObject({
        orgId: before?.orgId,
        holderEmail: before?.holderEmail,
        ownerUserId: before?.ownerUserId,
        version: before?.version,
        downloadToken: before?.downloadToken,
        linkGeneration: before?.linkGeneration,
      });
      expect(
        await first(kit.env.DB, 'SELECT 1 FROM bundle_passes WHERE bundle_id = ? AND pass_id = ?', [
          bundle.id,
          pass.id,
        ]),
      ).not.toBeNull();
      expect(
        await first(
          kit.env.DB,
          'SELECT 1 FROM pass_attach_blocks WHERE pass_id = ? AND user_id = ?',
          [pass.id, user.id],
        ),
      ).not.toBeNull();
      expect(
        await first(kit.env.DB, 'SELECT 1 FROM audit_log WHERE target_id = ? AND action = ?', [
          pass.id,
          `holder.${operation}`,
        ]),
      ).toBeNull();
    },
  );

  it('does not clear a block or attach an owner after membership revocation', async () => {
    const member = await eventMember(kit, kit.org.id, ['pass_operator']);
    const email = holderEmail();
    const pass = await kit.pass({ holderEmail: email });
    const user = await makeUser(kit.fx, { primaryEmail: email });
    await run(
      kit.env.DB,
      'INSERT INTO pass_attach_blocks (pass_id, user_id, created_at) VALUES (?, ?, ?)',
      [pass.id, user.id, kit.clock.now()],
    );
    const auth = await createAuthStores(kit.env).sessions.resolve(member.session.cookieValue);
    if (!auth) throw new Error('Missing session fixture');
    const authority = await tenantAuthorityOf(jobCtxOf(kit), auth, kit.org.id, 'passes:operate');
    await run(kit.env.DB, 'UPDATE org_memberships SET revoked_at = ? WHERE id = ?', [
      kit.clock.now(),
      member.membership,
    ]);
    await expect(
      clearBlock(
        jobCtxOf(kit),
        { type: 'user', id: member.user.id },
        { passId: pass.id, userId: user.id },
        null,
        async () => authority,
      ),
    ).rejects.toBeDefined();
    expect(
      await first(
        kit.env.DB,
        'SELECT 1 FROM pass_attach_blocks WHERE pass_id = ? AND user_id = ?',
        [pass.id, user.id],
      ),
    ).not.toBeNull();
    await run(kit.env.DB, 'DELETE FROM pass_attach_blocks WHERE pass_id = ? AND user_id = ?', [
      pass.id,
      user.id,
    ]);
    // A revoked tenant authority is an actor refusal (403), not a silent no-attach.
    await expect(
      runAttachHookA(jobCtxOf(kit), pass.id, { type: 'user', id: member.user.id }, { authority }),
    ).rejects.toMatchObject({ status: 403 });
    expect((await getPass(kit.env.DB, pass.id))?.ownerUserId).toBeNull();
    expect(
      await first(
        kit.env.DB,
        "SELECT 1 FROM audit_log WHERE target_id = ? AND action = 'holder.clear_block'",
        [pass.id],
      ),
    ).toBeNull();
    const attachRows = await all(
      kit.env.DB,
      "SELECT 1 FROM audit_log WHERE target_id = ? AND action = 'holder.attach'",
      [pass.id],
    );
    expect(attachRows).toHaveLength(0);
  });
  it.each(['reassign', 'unassign'] as const)(
    'does not mutate or audit %s after revocation at the batch',
    async (operation) => {
      const member = await eventMember(kit, kit.org.id, ['pass_operator']);
      const auth = await createAuthStores(kit.env).sessions.resolve(member.session.cookieValue);
      if (!auth) throw new Error('Missing session fixture');
      const authority = await tenantAuthorityOf(jobCtxOf(kit), auth, kit.org.id, 'passes:operate');
      const pass = await kit.pass({ holderEmail: 'before@example.com' });
      const bundle = await createBundle(
        jobCtxOf(kit),
        actor,
        'live',
        {
          orgId: kit.org.id,
          passIds: [pass.id],
          name: 'Revoked holder',
          holderEmail: 'bundle@example.com',
        },
        { kind: 'system' },
      );
      const db = kit.env.DB;
      const restore = interceptHolderMutation(db, 'before', () =>
        run(db, 'UPDATE org_memberships SET revoked_at = ? WHERE id = ?', [
          kit.clock.now(),
          member.membership,
        ]),
      );
      const requester = { type: 'user' as const, id: member.user.id };
      try {
        const result =
          operation === 'reassign'
            ? reassignHolder(
                jobCtxOf(kit),
                requester,
                { passId: pass.id, email: 'after@example.com' },
                null,
                async () => authority,
              )
            : unassignHolder(jobCtxOf(kit), requester, pass.id, null, async () => authority);
        await expect(result).rejects.toMatchObject({ status: 403 });
      } finally {
        restore();
      }
      expect((await getPass(db, pass.id))?.holderEmail).toBe('before@example.com');
      expect(
        await first(db, 'SELECT 1 FROM bundle_passes WHERE bundle_id = ? AND pass_id = ?', [
          bundle.id,
          pass.id,
        ]),
      ).not.toBeNull();
      expect(
        await first(db, 'SELECT 1 FROM audit_log WHERE target_id = ? AND action = ?', [
          pass.id,
          `holder.${operation}`,
        ]),
      ).toBeNull();
    },
  );

  // Liveness (authority-epochs.md WP1): a settings save moves config_revision, not access_revision or
  // updated_at, so it never fails a holder change. (A branding save still fails the credential-transfer
  // source fence in passes/repo-credential-transfer-source.ts, which WP2 converts.)
  it.each(['reassign', 'unassign'] as const)(
    'completes %s when an org settings save lands before the batch',
    async (operation) => {
      const member = await eventMember(kit, kit.org.id, ['pass_operator']);
      const auth = await createAuthStores(kit.env).sessions.resolve(member.session.cookieValue);
      if (!auth) throw new Error('Missing session fixture');
      const authority = await tenantAuthorityOf(jobCtxOf(kit), auth, kit.org.id, 'passes:operate');
      const pass = await kit.pass({ holderEmail: 'before@example.com' });
      const db = kit.env.DB;
      const revisions = () =>
        first<{ access_revision: number; config_revision: number; updated_at: number }>(
          db,
          'SELECT access_revision, config_revision, updated_at FROM orgs WHERE id = ?',
          [kit.org.id],
        );
      const before = await revisions();
      const restore = interceptHolderMutation(db, 'before', () =>
        updateSettings(
          jobCtxOf(kit),
          { type: 'system', id: null },
          {
            scope: `org:${kit.org.id}`,
            values: { 'support.email': `${kit.fx.ids.id()}@example.test` },
          },
        ),
      );
      const requester = { type: 'user' as const, id: member.user.id };
      try {
        if (operation === 'reassign')
          await reassignHolder(
            jobCtxOf(kit),
            requester,
            { passId: pass.id, email: 'after@example.com' },
            null,
            async () => authority,
          );
        else await unassignHolder(jobCtxOf(kit), requester, pass.id, null, async () => authority);
      } finally {
        restore();
      }
      const after = await revisions();
      expect(after?.access_revision).toBe(before?.access_revision);
      expect(after?.updated_at).toBe(before?.updated_at);
      expect(after?.config_revision).toBeGreaterThan(before?.config_revision ?? 0);
      expect((await getPass(db, pass.id))?.holderEmail).not.toBe('before@example.com');
    },
  );

  it('still refuses a holder change after an org suspension and reactivation', async () => {
    const member = await eventMember(kit, kit.org.id, ['pass_operator']);
    const auth = await createAuthStores(kit.env).sessions.resolve(member.session.cookieValue);
    if (!auth) throw new Error('Missing session fixture');
    const authority = await tenantAuthorityOf(jobCtxOf(kit), auth, kit.org.id, 'passes:operate');
    const pass = await kit.pass({ holderEmail: 'before@example.com' });
    const db = kit.env.DB;
    const restore = interceptHolderMutation(db, 'before', async () => {
      await run(db, "UPDATE orgs SET status = 'suspended' WHERE id = ?", [kit.org.id]);
      await run(db, "UPDATE orgs SET status = 'active' WHERE id = ?", [kit.org.id]);
    });
    try {
      await expect(
        reassignHolder(
          jobCtxOf(kit),
          { type: 'user', id: member.user.id },
          { passId: pass.id, email: 'after@example.com' },
          null,
          async () => authority,
        ),
      ).rejects.toMatchObject({ status: 403 });
    } finally {
      restore();
    }
    expect((await getPass(db, pass.id))?.holderEmail).toBe('before@example.com');
  });

  it.each(['assign', 'reassign', 'unassign', 'clear_block', 'attach'] as const)(
    'keeps the %s audit when membership is revoked immediately after its mutation batch',
    async (operation) => {
      const member = await eventMember(kit, kit.org.id, ['pass_operator']);
      const auth = await createAuthStores(kit.env).sessions.resolve(member.session.cookieValue);
      if (!auth) throw new Error('Missing session fixture');
      const authority = await tenantAuthorityOf(jobCtxOf(kit), auth, kit.org.id, 'passes:operate');
      const email = holderEmail();
      const pass = await kit.pass(operation === 'attach' ? { holderEmail: email } : {});
      const user = await makeUser(kit.fx, { primaryEmail: email });
      if (operation === 'clear_block')
        await run(
          kit.env.DB,
          'INSERT INTO pass_attach_blocks (pass_id, user_id, created_at) VALUES (?, ?, ?)',
          [pass.id, user.id, kit.clock.now()],
        );
      const db = kit.env.DB;
      const restore = interceptHolderMutation(db, 'after', () =>
        run(db, 'UPDATE org_memberships SET revoked_at = ? WHERE id = ?', [
          kit.clock.now(),
          member.membership,
        ]),
      );
      const tenantActor = { type: 'user', id: member.user.id } as const;
      try {
        if (operation === 'assign')
          await assignHolder(
            jobCtxOf(kit),
            tenantActor,
            { passId: pass.id, email: 'atomic@example.com' },
            null,
            async () => authority,
          );
        if (operation === 'reassign')
          await reassignHolder(
            jobCtxOf(kit),
            tenantActor,
            { passId: pass.id, email: 'atomic@example.com' },
            null,
            async () => authority,
          );
        if (operation === 'unassign')
          await unassignHolder(jobCtxOf(kit), tenantActor, pass.id, null, async () => authority);
        if (operation === 'clear_block')
          await clearBlock(
            jobCtxOf(kit),
            tenantActor,
            { passId: pass.id, userId: user.id },
            null,
            async () => authority,
          );
        if (operation === 'attach')
          expect(
            await runAttachHookA(jobCtxOf(kit), pass.id, tenantActor, { authority }),
          ).toMatchObject({
            // The tenant was revoked after the start, so its inline finish is refused; a job finishes it.
            state: 'pending',
            ownerUserId: user.id,
          });
      } finally {
        restore();
      }
      for (const row of await all<{ id: string }>(
        db,
        "SELECT id FROM pass_credential_transfers WHERE pass_id = ? AND state = 'pending'",
        [pass.id],
      ))
        await finishCredentialTransfer(jobCtxOf(kit), row.id);
      const rows = await all<{ org_id: string; actor_id: string }>(
        db,
        'SELECT org_id, actor_id FROM audit_log WHERE target_id = ? AND action = ?',
        [pass.id, `holder.${operation}`],
      );
      expect(rows).toEqual([{ org_id: kit.org.id, actor_id: member.user.id }]);
      if (operation === 'attach') expect((await getPass(db, pass.id))?.ownerUserId).toBe(user.id);
      if (operation === 'clear_block')
        expect(
          await first(db, 'SELECT 1 FROM pass_attach_blocks WHERE pass_id = ? AND user_id = ?', [
            pass.id,
            user.id,
          ]),
        ).toBeNull();
      if (operation === 'assign' || operation === 'reassign')
        expect((await getPass(db, pass.id))?.holderEmail).toBe('atomic@example.com');
    },
  );

  it('does not attach after authority is revoked between clearing the block and its hook', async () => {
    const member = await eventMember(kit, kit.org.id, ['pass_operator']);
    const session = await createAuthStores(kit.env).sessions.resolve(member.session.cookieValue);
    if (!session) throw new Error('Missing session fixture');
    const authority = await tenantAuthorityOf(jobCtxOf(kit), session, kit.org.id, 'passes:operate');
    const email = holderEmail();
    const pass = await kit.pass({ holderEmail: email });
    const user = await makeUser(kit.fx, { primaryEmail: email });
    await run(
      kit.env.DB,
      'INSERT INTO pass_attach_blocks (pass_id, user_id, created_at) VALUES (?, ?, ?)',
      [pass.id, user.id, kit.clock.now()],
    );
    const db = kit.env.DB;
    const restore = interceptHolderMutation(db, 'after', () =>
      run(db, 'UPDATE org_memberships SET revoked_at = ? WHERE id = ?', [
        kit.clock.now(),
        member.membership,
      ]),
    );
    const tenantActor = { type: 'user', id: member.user.id } as const;
    try {
      // The hook's attach runs under the revoked tenant: an actor refusal after the block cleared.
      await expect(
        clearBlock(
          jobCtxOf(kit),
          tenantActor,
          { passId: pass.id, userId: user.id },
          null,
          async () => authority,
        ),
      ).rejects.toMatchObject({ status: 403 });
    } finally {
      restore();
    }
    expect(await getPass(db, pass.id)).toMatchObject({
      holderEmail: user.primaryEmail,
      ownerUserId: null,
    });
    expect(
      await first(
        db,
        "SELECT 1 FROM audit_log WHERE target_id = ? AND action = 'holder.clear_block'",
        [pass.id],
      ),
    ).not.toBeNull();
    expect(
      await first(db, "SELECT 1 FROM audit_log WHERE target_id = ? AND action = 'holder.attach'", [
        pass.id,
      ]),
    ).toBeNull();
    expect(
      await first(db, 'SELECT 1 FROM pass_attach_blocks WHERE pass_id = ? AND user_id = ?', [
        pass.id,
        user.id,
      ]),
    ).toBeNull();
  });
  it.each(['assign', 'reassign', 'unassign'] as const)(
    'commits %s and its audit together',
    async (operation) => {
      const member = await eventMember(kit, kit.org.id, ['pass_operator']);
      const auth = await createAuthStores(kit.env).sessions.resolve(member.session.cookieValue);
      if (!auth) throw new Error('Missing session fixture');
      const authority = await tenantAuthorityOf(jobCtxOf(kit), auth, kit.org.id, 'passes:operate');
      const pass = await kit.pass();
      const bundle = await createBundle(
        jobCtxOf(kit),
        actor,
        'live',
        {
          orgId: kit.org.id,
          passIds: [pass.id],
          name: 'Holder audit',
          holderEmail: 'bundle@example.com',
        },
        { kind: 'system' },
      );
      const tenantActor = { type: 'user', id: member.user.id } as const;
      const authorize = async () => authority;
      if (operation === 'assign')
        await assignHolder(
          jobCtxOf(kit),
          tenantActor,
          { passId: pass.id, email: 'new@example.com' },
          null,
          authorize,
        );
      if (operation === 'reassign')
        await reassignHolder(
          jobCtxOf(kit),
          tenantActor,
          { passId: pass.id, email: 'new@example.com' },
          null,
          authorize,
        );
      if (operation === 'unassign')
        await unassignHolder(jobCtxOf(kit), tenantActor, pass.id, null, authorize);
      expect((await getPass(kit.env.DB, pass.id))?.holderEmail).toBe(
        operation === 'unassign' ? null : 'new@example.com',
      );
      expect(
        await first(kit.env.DB, 'SELECT 1 FROM bundle_passes WHERE bundle_id = ? AND pass_id = ?', [
          bundle.id,
          pass.id,
        ]),
      ).toBeNull();
      const rows = await all<{
        org_id: string;
        actor_type: string;
        actor_id: string;
        detail: string;
      }>(
        kit.env.DB,
        'SELECT org_id, actor_type, actor_id, detail FROM audit_log WHERE target_id = ? AND action = ?',
        [pass.id, `holder.${operation}`],
      );
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        org_id: kit.org.id,
        actor_type: 'user',
        actor_id: member.user.id,
      });
      expect(JSON.parse(rows[0]!.detail)).toEqual(
        operation === 'assign' ? { changed: true } : { fromUserId: null },
      );
    },
  );

  it('does not audit or invalidate a bundle when the holder CAS is stale', async () => {
    const member = await eventMember(kit, kit.org.id, ['pass_operator']);
    const auth = await createAuthStores(kit.env).sessions.resolve(member.session.cookieValue);
    if (!auth) throw new Error('Missing session fixture');
    const authority = await tenantAuthorityOf(jobCtxOf(kit), auth, kit.org.id, 'passes:operate');
    const pass = await kit.pass();
    const bundle = await createBundle(
      jobCtxOf(kit),
      actor,
      'live',
      {
        orgId: kit.org.id,
        passIds: [pass.id],
        name: 'Stale holder',
        holderEmail: 'bundle@example.com',
      },
      { kind: 'system' },
    );
    const snapshot = await getHolderPass(kit.env.DB, pass.id, null);
    if (!snapshot) throw new Error('Missing pass fixture');
    await run(kit.env.DB, 'UPDATE passes SET version = version + 1 WHERE id = ?', [pass.id]);
    const entry = {
      orgId: kit.org.id,
      actorType: 'user' as const,
      actorId: member.user.id,
      action: 'holder.assign',
      targetType: 'pass',
      targetId: pass.id,
      detail: { changed: true },
    };
    await expect(
      startCredentialTransfer(
        jobCtxOf(kit),
        { type: 'user', id: member.user.id },
        pass.id,
        { holderEmail: 'stale@example.com', ownerUserId: null },
        null,
        { kind: 'tenant-holder', expected: snapshot, authority, audit: entry },
      ),
    ).rejects.toMatchObject({ code: 'PASS_CONFLICT' });
    expect((await getPass(kit.env.DB, pass.id))?.holderEmail).toBeNull();
    expect(
      await first(kit.env.DB, 'SELECT 1 FROM bundle_passes WHERE bundle_id = ? AND pass_id = ?', [
        bundle.id,
        pass.id,
      ]),
    ).not.toBeNull();
    expect(
      await first(
        kit.env.DB,
        "SELECT 1 FROM audit_log WHERE target_id = ? AND action = 'holder.assign'",
        [pass.id],
      ),
    ).toBeNull();
  });

  it.each(['assign', 'clear_block', 'attach'] as const)(
    'rolls back %s and its side effects if its audit insert fails',
    async (operation) => {
      const member = await eventMember(kit, kit.org.id, ['pass_operator']);
      const auth = await createAuthStores(kit.env).sessions.resolve(member.session.cookieValue);
      if (!auth) throw new Error('Missing session fixture');
      const authority = await tenantAuthorityOf(jobCtxOf(kit), auth, kit.org.id, 'passes:operate');
      const email = holderEmail();
      const pass = await kit.pass(operation === 'attach' ? { holderEmail: email } : {});
      const user = await makeUser(kit.fx, { primaryEmail: email });
      if (operation === 'clear_block')
        await run(
          kit.env.DB,
          'INSERT INTO pass_attach_blocks (pass_id, user_id, created_at) VALUES (?, ?, ?)',
          [pass.id, user.id, kit.clock.now()],
        );
      const bundle = await createBundle(
        jobCtxOf(kit),
        actor,
        'live',
        {
          orgId: kit.org.id,
          passIds: [pass.id],
          name: 'Audit rollback',
          holderEmail: 'bundle@example.com',
        },
        { kind: 'system' },
      );
      const before = await getPass(kit.env.DB, pass.id);
      const db = new Proxy(kit.env.DB, {
        get(target, prop) {
          if (prop === 'prepare')
            return (sql: string) => {
              const prepared = target.prepare(sql);
              if (!/^\s*INSERT INTO audit_log\b/i.test(sql)) return prepared;
              return new Proxy(prepared, {
                get(statement, key) {
                  if (key === 'bind')
                    return () =>
                      target.prepare('INSERT INTO audit_log (action) VALUES (NULL)').bind();
                  const value = Reflect.get(statement, key, statement);
                  return typeof value === 'function' ? value.bind(statement) : value;
                },
              });
            };
          const value = Reflect.get(target, prop, target);
          return typeof value === 'function' ? value.bind(target) : value;
        },
      });
      const env: AppEnv = { ...kit.env, DB: db };
      overrideDeps(env, depsOf(kit.env));
      const ctx = { ...jobCtxOf(kit), env };
      const tenantActor = { type: 'user', id: member.user.id } as const;
      const result =
        operation === 'assign'
          ? assignHolder(
              ctx,
              tenantActor,
              { passId: pass.id, email: 'after@example.com' },
              null,
              async () => authority,
            )
          : operation === 'clear_block'
            ? clearBlock(
                ctx,
                tenantActor,
                { passId: pass.id, userId: user.id },
                null,
                async () => authority,
              )
            : runAttachHookA(ctx, pass.id, tenantActor, { authority });
      await expect(result).rejects.toBeDefined();
      const after = await getPass(kit.env.DB, pass.id);
      expect(after).toMatchObject({
        holderEmail: before?.holderEmail,
        ownerUserId: before?.ownerUserId,
        version: before?.version,
        linkGeneration: before?.linkGeneration,
        downloadToken: before?.downloadToken,
      });
      expect(
        await first(kit.env.DB, 'SELECT 1 FROM bundle_passes WHERE bundle_id = ? AND pass_id = ?', [
          bundle.id,
          pass.id,
        ]),
      ).not.toBeNull();
      if (operation === 'clear_block')
        expect(
          await first(
            kit.env.DB,
            'SELECT 1 FROM pass_attach_blocks WHERE pass_id = ? AND user_id = ?',
            [pass.id, user.id],
          ),
        ).not.toBeNull();
      expect(
        await first(kit.env.DB, 'SELECT 1 FROM audit_log WHERE target_id = ? AND action = ?', [
          pass.id,
          `holder.${operation}`,
        ]),
      ).toBeNull();
    },
  );

  it('commits block removal and attachment with separate matching audits', async () => {
    const member = await eventMember(kit, kit.org.id, ['pass_operator']);
    const auth = await createAuthStores(kit.env).sessions.resolve(member.session.cookieValue);
    if (!auth) throw new Error('Missing session fixture');
    const authority = await tenantAuthorityOf(jobCtxOf(kit), auth, kit.org.id, 'passes:operate');
    const email = holderEmail();
    const pass = await kit.pass({ holderEmail: email });
    const user = await makeUser(kit.fx, { primaryEmail: email });
    await run(
      kit.env.DB,
      'INSERT INTO pass_attach_blocks (pass_id, user_id, created_at) VALUES (?, ?, ?)',
      [pass.id, user.id, kit.clock.now()],
    );
    await clearBlock(
      jobCtxOf(kit),
      { type: 'user', id: member.user.id },
      { passId: pass.id, userId: user.id },
      null,
      async () => authority,
    );
    expect(
      await first(
        kit.env.DB,
        'SELECT 1 FROM pass_attach_blocks WHERE pass_id = ? AND user_id = ?',
        [pass.id, user.id],
      ),
    ).toBeNull();
    expect((await getPass(kit.env.DB, pass.id))?.ownerUserId).toBe(user.id);
    const rows = await all<{ action: string; org_id: string; actor_id: string; detail: string }>(
      kit.env.DB,
      "SELECT action, org_id, actor_id, detail FROM audit_log WHERE target_id = ? AND action IN ('holder.clear_block', 'holder.attach') ORDER BY id",
      [pass.id],
    );
    expect(rows.map((row) => row.action)).toEqual(['holder.clear_block', 'holder.attach']);
    expect(rows.map((row) => [row.org_id, row.actor_id, JSON.parse(row.detail)])).toEqual([
      [kit.org.id, member.user.id, { userId: user.id }],
      [kit.org.id, member.user.id, { via: 'email', userId: user.id }],
    ]);
    expect(
      await runAttachHookA(
        jobCtxOf(kit),
        pass.id,
        { type: 'user', id: member.user.id },
        { authority },
      ),
    ).toBeNull();
    await expect(
      clearBlock(
        jobCtxOf(kit),
        { type: 'user', id: member.user.id },
        { passId: pass.id, userId: user.id },
        null,
        async () => authority,
      ),
    ).rejects.toBeDefined();
    expect(
      await all(
        kit.env.DB,
        "SELECT 1 FROM audit_log WHERE target_id = ? AND action IN ('holder.clear_block', 'holder.attach')",
        [pass.id],
      ),
    ).toHaveLength(2);
  });
});
