import { OpenAPIHono } from '@hono/zod-openapi';
import { beforeEach, describe, expect, it } from 'vitest';
import { installKeysetTestEnv } from '../../../../test/helpers/credential-keyset.ts';
import { expectProblem } from '../../../../test/helpers/denial.ts';
import {
  makeApiKey,
  makeOrg,
  makePass,
  makeSession,
  makeUser,
} from '../../../../test/helpers/index.ts';
import { WalletProviderPassStatusSchema } from '../../../shared/contracts/wallet-provider-status.ts';
import { type AppBindings, requestContext } from '../../platform/context.ts';
import { first, run } from '../../platform/db.ts';
import type { AppEnv } from '../../platform/env.ts';
import { handleError } from '../../platform/error-handler.ts';
import { jobCtxOf } from '../delivery/delivery-test-fixtures.ts';
import { eventMember, eventStores } from '../events/test-auth-fixtures.ts';
import { getHolderPass } from '../holders/repo.ts';
import {
  credentialRefKeysetCommitment,
  ensureCredentialRefKeyset,
} from '../passes/credential-keyset.ts';
import {
  finishCredentialTransfer,
  startCredentialTransfer,
} from '../passes/credential-transfer.ts';
import { type Kit, setupKit } from '../passes/pass-test-fixtures.ts';
import { makeTenantTestApiKey } from '../passes/repo-tenant-test-fixtures.ts';
import { setupSamsungCallbacks } from './callbacks-test-fixtures.ts';
import {
  claimWalletOperation,
  completeWalletOperation,
  getWalletInstanceById,
  newWalletClaimHandle,
} from './instance.ts';
import { reconcileWalletInstance } from './lifecycle.ts';
import { setupWalletOfferKit } from './offers-test-fixtures.ts';
import { walletProviderStatusRoutes } from './routes-status.ts';
import { finishWalletProviderRetirement } from './sync-operation-retirement.ts';
import { walletJobCtx } from './wallet-job-ctx-test-fixtures.ts';

const base = 'https://wallet.test/api/v1/wallet-providers/passes';
const makeEnv = installKeysetTestEnv();
let kit: Kit;
beforeEach(async () => {
  kit = await setupKit({ db: (await makeEnv()).DB });
});

/** Exercise the independently mountable group using real session and API-key stores. */
function appFor(fixture: Kit) {
  const app = new OpenAPIHono<AppBindings>();
  app.use('*', requestContext({ stores: eventStores(fixture), clock: fixture.clock }));
  app.onError(handleError);
  app.route('/api/v1/wallet-providers/passes', walletProviderStatusRoutes);
  return app;
}
function call(
  fixture: Kit,
  id: string,
  headers: Record<string, string> = {},
  env: AppEnv = fixture.env,
) {
  return appFor(fixture).request(`${base}/${id}`, { headers }, env);
}
async function read(response: Response) {
  expect(response.status).toBe(200);
  expect(response.headers.get('cache-control')).toContain('no-store');
  return WalletProviderPassStatusSchema.parse(await response.json());
}

async function unavailable(response: Response) {
  expect(response.status).toBe(503);
  const raw = await response.text();
  expect(JSON.parse(raw)).toMatchObject({ status: 503, code: 'CREDENTIAL_REF_KEYSET_UNAVAILABLE' });
  expect(raw).not.toMatch(
    /"providers"|"credentialGeneration"|"lifecycle"|"priorGenerationRetirementPending"/,
  );
  return raw;
}

/** Change the real database immediately before the final status SELECT. */
async function atStatusRead(
  fixture: Kit,
  change: (db: D1Database) => Promise<void>,
  request: (env: AppEnv) => Response | Promise<Response>,
) {
  const real = fixture.env.DB;
  let intercepted = false;
  const wrap = (statement: D1PreparedStatement, sql: string): D1PreparedStatement =>
    new Proxy(statement, {
      get(target, property) {
        if (property === 'bind') return (...values: unknown[]) => wrap(target.bind(...values), sql);
        if (property === 'all')
          return async () => {
            if (!intercepted && sql.includes('AS priorRetirementPending')) {
              intercepted = true;
              await change(real);
            }
            return target.all();
          };
        const value = Reflect.get(target, property, target);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
  const db = new Proxy(real, {
    get(target, property) {
      if (property === 'prepare') return (sql: string) => wrap(target.prepare(sql), sql);
      const value = Reflect.get(target, property, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  const response = await request({ ...fixture.env, DB: db });
  expect(intercepted).toBe(true);
  return response;
}

describe('provider pass status read', () => {
  it('requires a tenant reader or passes:read key in the selected mode', async () => {
    const pass = await kit.pass();
    const member = await eventMember(kit, kit.org.id, ['read_only']);
    const integrationOnly = await eventMember(kit, kit.org.id, ['integration_admin']);
    const outsider = await makeUser(kit.fx);
    const outsiderSession = await makeSession(kit.fx, {
      userId: outsider.id,
      roles: ['admin', 'user'],
    });
    const other = await makeOrg(kit.fx);
    const key = await makeApiKey(kit.fx, { orgId: kit.org.id, scopes: ['passes:read'] });
    const global = await makeApiKey(kit.fx, { orgId: null, scopes: ['passes:read'] });
    const foreign = await makeApiKey(kit.fx, { orgId: other.id, scopes: ['passes:read'] });
    const noScope = await makeApiKey(kit.fx, { orgId: kit.org.id, scopes: ['passes:write'] });
    expect((await call(kit, pass.id)).status).toBe(401);
    await expectProblem(await call(kit, pass.id, outsiderSession.headers), 404, 'PASS_NOT_FOUND');
    await expectProblem(
      await call(kit, pass.id, integrationOnly.session.headers),
      404,
      'PASS_NOT_FOUND',
    );
    await expectProblem(await call(kit, pass.id, foreign.headers), 404, 'PASS_NOT_FOUND');
    await expectProblem(await call(kit, pass.id, noScope.headers), 403, 'MISSING_SCOPE');
    expect(
      (await call(kit, pass.id, { ...member.session.headers, 'x-passbook-mode': 'test' })).status,
    ).toBe(404);
    expect((await read(await call(kit, pass.id, member.session.headers))).providers).toEqual([
      {
        provider: 'google',
        lifecycle: 'absent',
        desiredOperation: null,
        priorGenerationRetirementPending: false,
        installation: 'unknown',
        issuance: { state: 'disabled', reason: 'not_released' },
      },
      {
        provider: 'samsung',
        lifecycle: 'absent',
        desiredOperation: null,
        priorGenerationRetirementPending: false,
        installation: 'unknown',
        issuance: { state: 'disabled', reason: 'not_released' },
      },
    ]);
    expect((await read(await call(kit, pass.id, key.headers))).credentialGeneration).toBe(1);
    expect((await read(await call(kit, pass.id, global.headers))).credentialGeneration).toBe(1);
    const testPass = await kit.pass({ mode: 'test' });
    await expectProblem(await call(kit, testPass.id, key.headers), 404, 'PASS_NOT_FOUND');
    await expectProblem(
      await call(kit, testPass.id, member.session.headers),
      404,
      'PASS_NOT_FOUND',
    );
    expect(
      (
        await read(
          await call(kit, testPass.id, { ...member.session.headers, 'x-passbook-mode': 'test' }),
        )
      ).credentialGeneration,
    ).toBe(1);
    const testKey = await makeTenantTestApiKey(kit.fx, {
      orgId: kit.org.id,
      scopes: ['passes:read'],
      mode: 'test',
    });
    await expectProblem(await call(kit, pass.id, testKey.headers), 404, 'PASS_NOT_FOUND');
    expect((await read(await call(kit, testPass.id, testKey.headers))).credentialGeneration).toBe(
      1,
    );
  });

  it('does not mistake a configured provider with no pass instance for an unconfigured provider', async () => {
    const f = await setupWalletOfferKit({
      google: 'configured',
      samsung: 'absent',
      db: kit.env.DB,
    });
    const reader = await eventMember(f.kit, f.kit.org.id);
    const result = await read(await call(f.kit, f.pass.id, reader.session.headers));
    expect(result.providers[0]).toEqual({
      provider: 'google',
      lifecycle: 'absent',
      desiredOperation: null,
      priorGenerationRetirementPending: false,
      installation: 'unknown',
      issuance: { state: 'disabled', reason: 'not_released' },
    });
    expect(JSON.stringify(result)).not.toMatch(/configured|unconfigured/i);
  });

  it('returns only sanitized current operation results, never provider or holder secrets', async () => {
    const f = await setupSamsungCallbacks({
      holderEmail: 'private-holder@example.test',
      db: kit.env.DB,
    });
    const member = await eventMember(f.kit, f.kit.org.id);
    const ref = {
      instanceId: f.operation.instanceId,
      version: f.operation.version,
      orgId: f.kit.org.id,
      mode: 'live' as const,
      provider: 'samsung' as const,
      claimHandle: newWalletClaimHandle(),
      now: f.kit.clock.now(),
    };
    expect(await claimWalletOperation(walletJobCtx(f.kit.env.DB), ref)).toBe('claimed');
    expect(
      await completeWalletOperation(jobCtxOf(f.kit), {
        ...ref,
        result: {
          kind: 'failure',
          reason: 'rate_limited',
          retryable: true,
          httpStatus: 429,
          rawBody: new TextEncoder().encode('private-provider-response'),
        },
      }),
    ).toBe('retry');
    const response = await call(f.kit, f.pass.id, member.session.headers);
    const raw = await response.clone().text();
    const status = await read(response);
    expect(status.providers[1]).toEqual({
      provider: 'samsung',
      lifecycle: 'active',
      desiredOperation: {
        version: ref.version,
        kind: 'upsert',
        state: 'retry',
        reason: 'rate_limited',
      },
      priorGenerationRetirementPending: false,
      installation: 'unknown',
      issuance: { state: 'enabled' },
    });
    for (const secret of [
      f.operation.instanceId,
      f.operation.id,
      f.refId,
      f.referenceId,
      f.pass.id,
      f.pass.downloadToken,
      f.samsung.partnerId,
      f.samsung.cardId,
      'private-holder@example.test',
      'private-provider-response',
    ])
      expect(raw).not.toContain(secret);
    expect(raw).not.toMatch(/accountId|operationId|httpStatus|token|refId|url|callback|rawBody/i);
    f.kit.clock.advance(5_000);
    const retry = { ...ref, now: f.kit.clock.now(), claimHandle: newWalletClaimHandle() };
    expect(await claimWalletOperation(walletJobCtx(f.kit.env.DB), retry)).toBe('claimed');
    expect(
      await completeWalletOperation(jobCtxOf(f.kit), {
        ...retry,
        result: { kind: 'success', httpStatus: 200 },
      }),
    ).toBe('succeeded');
    const accepted = await read(await call(f.kit, f.pass.id, member.session.headers));
    expect(accepted.providers[1]).toMatchObject({
      lifecycle: 'active',
      installation: 'unknown',
      issuance: { state: 'enabled' },
      desiredOperation: { version: ref.version, kind: 'upsert', state: 'succeeded', reason: 'ok' },
    });
    expect(accepted.providers[1]).not.toHaveProperty('reported');
    // A provider callback's report shows as a report; installation stays unknown.
    await run(
      f.kit.env.DB,
      "UPDATE wallet_provider_instances SET saved_at = 100 WHERE pass_id = ? AND provider = 'samsung'",
      [f.pass.id],
    );
    const saved = await read(await call(f.kit, f.pass.id, member.session.headers));
    expect(saved.providers[1]).toMatchObject({
      installation: 'unknown',
      reported: { event: 'saved', at: 100 },
    });
    await run(
      f.kit.env.DB,
      "UPDATE wallet_provider_instances SET holder_removed_at = 200 WHERE pass_id = ? AND provider = 'samsung'",
      [f.pass.id],
    );
    const removed = await read(await call(f.kit, f.pass.id, member.session.headers));
    expect(removed.providers[1]).toMatchObject({ reported: { event: 'removed', at: 200 } });
  });

  it('reports the current staged incarnation and unresolved older retirement during transfer', async () => {
    const f = await setupSamsungCallbacks({
      holderEmail: 'old-holder@example.test',
      db: kit.env.DB,
    });
    const member = await eventMember(f.kit, f.kit.org.id);
    const expected = await getHolderPass(f.kit.env.DB, f.pass.id, null);
    if (!expected) throw new Error('Missing holder pass fixture');
    const transfer = await startCredentialTransfer(
      jobCtxOf(f.kit),
      { type: 'system', id: null },
      f.pass.id,
      { holderEmail: 'new-holder@example.test', ownerUserId: null },
      null,
      { kind: 'tenant-holder', expected },
    );
    expect(transfer.state).toBe('pending');
    const response = await call(f.kit, f.pass.id, member.session.headers);
    const raw = await response.clone().text();
    const result = await read(response);
    expect(result.credentialGeneration).toBe(2);
    expect(result.providers[1]).toMatchObject({
      provider: 'samsung',
      lifecycle: 'blocked',
      desiredOperation: null,
      priorGenerationRetirementPending: true,
      installation: 'unknown',
      issuance: { state: 'enabled' },
    });
    expect(result.providers[0]).toMatchObject({
      provider: 'google',
      lifecycle: 'blocked',
      desiredOperation: null,
      priorGenerationRetirementPending: false,
      installation: 'unknown',
      issuance: { state: 'enabled' },
    });
    for (const secret of [
      'old-holder@example.test',
      'new-holder@example.test',
      f.operation.instanceId,
      f.refId,
    ])
      expect(raw).not.toContain(secret);
    const oldScope = {
      instanceId: f.operation.instanceId,
      orgId: f.pass.orgId,
      mode: f.pass.mode,
      provider: 'samsung' as const,
    };
    const old = await getWalletInstanceById(f.kit.env.DB, oldScope);
    if (!old) throw new Error('Missing old instance');
    expect(await reconcileWalletInstance(jobCtxOf(f.kit), old)).toBe('scheduled');
    const retiring = await getWalletInstanceById(f.kit.env.DB, oldScope);
    if (!retiring) throw new Error('Missing retiring instance');
    const claim = {
      ...oldScope,
      version: retiring.desiredVersion,
      claimHandle: newWalletClaimHandle(),
      now: f.kit.clock.now(),
    };
    expect(await claimWalletOperation(walletJobCtx(f.kit.env.DB), claim)).toBe('claimed');
    expect(
      await completeWalletOperation(jobCtxOf(f.kit), {
        ...claim,
        result: { kind: 'success', httpStatus: 200 },
      }),
    ).toBe('succeeded');
    const accepted = await read(await call(f.kit, f.pass.id, member.session.headers));
    expect(accepted.providers[1]).toMatchObject({
      lifecycle: 'blocked',
      priorGenerationRetirementPending: true,
      installation: 'unknown',
      issuance: { state: 'enabled' },
    });
    expect(await finishWalletProviderRetirement(f.kit.ctx, claim)).toBe(true);
    const retired = await read(await call(f.kit, f.pass.id, member.session.headers));
    expect(retired.providers[1]).toMatchObject({
      lifecycle: 'blocked',
      priorGenerationRetirementPending: false,
      installation: 'unknown',
      issuance: { state: 'enabled' },
    });
    expect(await finishCredentialTransfer(jobCtxOf(f.kit), transfer.transferId)).toMatchObject({
      state: 'completed',
    });
    const completed = await read(await call(f.kit, f.pass.id, member.session.headers));
    expect(completed.providers).toEqual([
      {
        provider: 'google',
        lifecycle: 'ready',
        desiredOperation: null,
        priorGenerationRetirementPending: false,
        installation: 'unknown',
        issuance: { state: 'enabled' },
      },
      {
        provider: 'samsung',
        lifecycle: 'ready',
        desiredOperation: null,
        priorGenerationRetirementPending: false,
        installation: 'unknown',
        issuance: { state: 'enabled' },
      },
    ]);
  });

  it('does not initialize a missing credential keyset from a read-only status request', async () => {
    const f = await setupKit({ db: kit.env.DB });
    const pass = await makePass(f.fx, { orgId: f.org.id, template: f.template });
    const member = await eventMember(f, f.org.id);
    expect(
      await first(f.env.DB, 'SELECT commitment FROM credential_ref_keyset WHERE id = 1'),
    ).toBeNull();
    await unavailable(await call(f, pass.id, member.session.headers));
    expect(
      await first(f.env.DB, 'SELECT commitment FROM credential_ref_keyset WHERE id = 1'),
    ).toBeNull();

    const credentialKeysetCommitment = await ensureCredentialRefKeyset(f.env.DB, f.env);
    expect(
      await first(f.env.DB, 'SELECT commitment FROM credential_ref_keyset WHERE id = 1'),
    ).toEqual({ commitment: credentialKeysetCommitment });
    expect((await read(await call(f, pass.id, member.session.headers))).providers).toEqual([
      {
        provider: 'google',
        lifecycle: 'absent',
        desiredOperation: null,
        priorGenerationRetirementPending: false,
        installation: 'unknown',
        issuance: { state: 'enabled' },
      },
      {
        provider: 'samsung',
        lifecycle: 'absent',
        desiredOperation: null,
        priorGenerationRetirementPending: false,
        installation: 'unknown',
        issuance: { state: 'enabled' },
      },
    ]);
  });

  it('pins the KEK bindings before asynchronous pass authorization', async () => {
    const pass = await kit.pass();
    const member = await eventMember(kit, kit.org.id);
    const credentialKeysetCommitment = await ensureCredentialRefKeyset(kit.env.DB, kit.env);
    const wrongKey = btoa('x'.repeat(32));
    expect(await credentialRefKeysetCommitment({ ...kit.env, KEK_V1: wrongKey })).not.toBe(
      credentialKeysetCommitment,
    );
    const baseline = await read(await call(kit, pass.id, member.session.headers));

    async function requestWithKeyChange(startsWrong: boolean) {
      const realKey = kit.env.KEK_V1;
      const env = { ...kit.env, KEK_V1: startsWrong ? wrongKey : realKey };
      let intercepted = false;
      const wrap = (statement: D1PreparedStatement, sql: string): D1PreparedStatement =>
        new Proxy(statement, {
          get(target, property) {
            if (property === 'bind')
              return (...values: unknown[]) => wrap(target.bind(...values), sql);
            if (property === 'first')
              return () => {
                if (!intercepted && sql.includes('AS org_slug FROM passes')) {
                  intercepted = true;
                  env.KEK_V1 = startsWrong ? realKey : wrongKey;
                }
                return target.first();
              };
            const value = Reflect.get(target, property, target);
            return typeof value === 'function' ? value.bind(target) : value;
          },
        });
      const real = env.DB;
      env.DB = new Proxy(real, {
        get(target, property) {
          if (property === 'prepare') return (sql: string) => wrap(target.prepare(sql), sql);
          const value = Reflect.get(target, property, target);
          return typeof value === 'function' ? value.bind(target) : value;
        },
      });
      const response = await call(kit, pass.id, member.session.headers, env);
      expect(intercepted).toBe(true);
      return response;
    }

    expect(await read(await requestWithKeyChange(false))).toEqual(baseline);
    await unavailable(await requestWithKeyChange(true));
  });

  it('refuses a mismatched keyset pin at entry', async () => {
    const f = await setupSamsungCallbacks({
      holderEmail: 'private-holder@example.test',
      db: kit.env.DB,
    });
    const db = f.kit.env.DB;
    const member = await eventMember(f.kit, f.kit.org.id);
    const outsider = await makeUser(f.kit.fx);
    const outsiderSession = await makeSession(f.kit.fx, {
      userId: outsider.id,
      roles: ['admin', 'user'],
    });
    const expected = await getHolderPass(db, f.pass.id, null);
    if (!expected) throw new Error('Missing holder pass fixture');
    await startCredentialTransfer(
      jobCtxOf(f.kit),
      { type: 'system', id: null },
      f.pass.id,
      { holderEmail: 'next-holder@example.test', ownerUserId: null },
      null,
      { kind: 'tenant-holder', expected },
    );

    const credentialKeysetCommitment = await ensureCredentialRefKeyset(db, f.kit.env);
    expect(await first(db, 'SELECT commitment FROM credential_ref_keyset WHERE id = 1')).toEqual({
      commitment: credentialKeysetCommitment,
    });
    const baseline = await read(await call(f.kit, f.pass.id, member.session.headers));
    expect(baseline.providers[1]).toMatchObject({
      lifecycle: 'blocked',
      priorGenerationRetirementPending: true,
    });

    const wrongEnv = { ...f.kit.env, KEK_V1: btoa('x'.repeat(32)) };
    const replacement = await credentialRefKeysetCommitment(wrongEnv);
    expect(replacement).not.toBe(credentialKeysetCommitment);
    const mismatch = await unavailable(
      await call(f.kit, f.pass.id, member.session.headers, wrongEnv),
    );
    for (const secret of [
      f.pass.id,
      f.operation.instanceId,
      f.refId,
      'private-holder@example.test',
    ])
      expect(mismatch).not.toContain(secret);
    await expectProblem(
      await call(f.kit, f.pass.id, outsiderSession.headers, wrongEnv),
      404,
      'PASS_NOT_FOUND',
    );
    expect(
      (
        await call(
          f.kit,
          f.pass.id,
          { ...member.session.headers, 'x-passbook-mode': 'test' },
          wrongEnv,
        )
      ).status,
    ).toBe(404);
    expect(await first(db, 'SELECT commitment FROM credential_ref_keyset WHERE id = 1')).toEqual({
      commitment: credentialKeysetCommitment,
    });

    expect(await read(await call(f.kit, f.pass.id, member.session.headers))).toEqual(baseline);
  });

  it.each(['membership', 'session', 'key'] as const)(
    'rechecks %s at the final D1 read',
    async (kind) => {
      const pass = await kit.pass();
      const member = await eventMember(kit, kit.org.id);
      const key = await makeApiKey(kit.fx, { orgId: kit.org.id, scopes: ['passes:read'] });
      const headers = kind === 'key' ? key.headers : member.session.headers;
      const response = await atStatusRead(
        kit,
        async (db) => {
          if (kind === 'membership')
            await run(db, 'UPDATE org_memberships SET revoked_at = ? WHERE id = ?', [
              kit.clock.now(),
              member.membership,
            ]);
          else if (kind === 'session')
            await run(db, 'UPDATE sessions SET revoked_at = ? WHERE user_id = ?', [
              kit.clock.now(),
              member.user.id,
            ]);
          else
            await run(db, 'UPDATE api_keys SET revoked_at = ? WHERE id = ?', [
              kit.clock.now(),
              key.id,
            ]);
        },
        (env) => call(kit, pass.id, headers, env),
      );
      await expectProblem(response, 404, 'PASS_NOT_FOUND');
    },
  );

  it('does not return a stale pre-transfer snapshot when a transfer starts before the status read', async () => {
    const f = await setupSamsungCallbacks({
      holderEmail: 'old-holder@example.test',
      db: kit.env.DB,
    });
    const member = await eventMember(f.kit, f.kit.org.id);
    const expected = await getHolderPass(f.kit.env.DB, f.pass.id, null);
    if (!expected) throw new Error('Missing holder pass fixture');
    const response = await atStatusRead(
      f.kit,
      async () => {
        await startCredentialTransfer(
          jobCtxOf(f.kit),
          { type: 'system', id: null },
          f.pass.id,
          { holderEmail: 'new-holder@example.test', ownerUserId: null },
          null,
          { kind: 'tenant-holder', expected },
        );
      },
      (env) => call(f.kit, f.pass.id, member.session.headers, env),
    );
    await expectProblem(response, 404, 'PASS_NOT_FOUND');
    expect(await response.text()).not.toContain('old-holder@example.test');
  });
});
