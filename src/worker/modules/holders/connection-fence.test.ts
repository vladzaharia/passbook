import { beforeEach, describe, expect, it } from 'vitest';
import { makeOrg, makeUser } from '../../../../test/helpers/index.ts';
import { first, run } from '../../platform/db.ts';
import type { AppEnv } from '../../platform/env.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { jobCtxOf } from '../delivery/delivery-test-fixtures.ts';
import { depsOf, overrideDeps } from '../passes/deps.ts';
import { type Kit, setupKit } from '../passes/pass-test-fixtures.ts';
import { getPass } from '../passes/repo-read-pass.ts';
import { runAttachHookA } from './service.ts';

let kit: Kit;
beforeEach(async () => {
  kit = await setupKit();
});

async function waitingPass() {
  const connection = { id: kit.fx.ids.id() };
  await run(
    kit.env.DB,
    `INSERT INTO connections
    (id, org_id, connector_type, name, created_at, updated_at)
    VALUES (?, ?, 'demo', 'Holder source', ?, ?)`,
    [connection.id, kit.org.id, kit.clock.now(), kit.clock.now()],
  );
  // Storage lasts for the whole file, so each case needs its own address.
  const email = `holder-${kit.fx.ids.id()}@example.test`;
  const pass = await kit.pass({ holderEmail: email });
  const holder = await makeUser(kit.fx, { primaryEmail: email });
  await run(kit.env.DB, 'UPDATE passes SET connection_id = ?, external_ref = ? WHERE id = ?', [
    connection.id,
    'member-1',
    pass.id,
  ]);
  return {
    pass,
    holder,
    connection,
    fence: {
      orgId: kit.org.id,
      connectionId: connection.id,
      externalRef: 'member-1',
      generation: 1,
    },
  };
}

/** Invalidate the connection or pass after the hook's reads but immediately before its CAS. */
function atAttachCommit(change: () => Promise<unknown>): {
  ctx: ServiceContext;
  fired: () => boolean;
} {
  let injected = false;
  const writes = new WeakSet<D1PreparedStatement>();
  const db = new Proxy(kit.env.DB, {
    get(target, prop) {
      if (prop === 'prepare')
        return (sql: string) => {
          const prepared = target.prepare(sql);
          if (!/^\s*INSERT INTO pass_credential_transfers\b/i.test(sql)) return prepared;
          return new Proxy(prepared, {
            get(statement, key) {
              if (key === 'bind')
                return (...values: unknown[]) => {
                  const bound = statement.bind(...values);
                  writes.add(bound);
                  return bound;
                };
              const value = Reflect.get(statement, key, statement);
              return typeof value === 'function' ? value.bind(statement) : value;
            },
          });
        };
      if (prop === 'batch')
        return async (statements: D1PreparedStatement[]) => {
          if (!injected && statements.some((statement) => writes.has(statement))) {
            injected = true;
            await change();
          }
          return target.batch(statements);
        };
      const value = Reflect.get(target, prop, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  const env: AppEnv = { ...kit.env, DB: db };
  overrideDeps(env, depsOf(kit.env));
  return { ctx: { ...jobCtxOf(kit), env }, fired: () => injected };
}

async function state(passId: string) {
  return first<{ owner_user_id: string | null; link_generation: number }>(
    kit.env.DB,
    'SELECT owner_user_id, link_generation FROM passes WHERE id = ?',
    [passId],
  );
}

async function attachAudits(passId: string) {
  return first<{ n: number }>(
    kit.env.DB,
    "SELECT count(*) AS n FROM audit_log WHERE target_id = ? AND action = 'holder.attach'",
    [passId],
  );
}

describe('connection-created holder attachment', () => {
  it('attaches when the original live connection and organization are still current', async () => {
    const { pass, holder, fence } = await waitingPass();
    const before = await state(pass.id);
    expect(
      await runAttachHookA(jobCtxOf(kit), pass.id, undefined, { connection: fence }),
    ).toMatchObject({
      state: 'completed',
      ownerUserId: holder.id,
    });
    expect(await state(pass.id)).toEqual({
      owner_user_id: holder.id,
      link_generation: (before?.link_generation ?? 0) + 1,
    });
    expect(await attachAudits(pass.id)).toEqual({ n: 1 });
  });

  it.each([
    [
      'generation changes',
      'UPDATE connections SET generation = generation + 1 WHERE id = ?',
      'connection',
    ],
    ['connection is disabled', 'UPDATE connections SET enabled = 0 WHERE id = ?', 'connection'],
    ['organization is suspended', "UPDATE orgs SET status = 'suspended' WHERE id = ?", 'org'],
    ['pass is unbound', 'UPDATE passes SET connection_id = NULL WHERE id = ?', 'pass'],
    ['upstream reference changes', "UPDATE passes SET external_ref = 'other' WHERE id = ?", 'pass'],
    ['pass is voided', "UPDATE passes SET status = 'voided' WHERE id = ?", 'pass'],
    ['pass is deleted', 'UPDATE passes SET deleted_at = 1 WHERE id = ?', 'pass'],
    ['pass is removed', 'UPDATE passes SET removed_at = 1 WHERE id = ?', 'pass'],
  ] as const)('does not attach or audit if the %s at the CAS', async (_label, sql, which) => {
    const { pass, connection, fence } = await waitingPass();
    const before = await state(pass.id);
    const target = which === 'connection' ? connection.id : which === 'org' ? kit.org.id : pass.id;
    const race = atAttachCommit(() => run(kit.env.DB, sql, [target]));
    expect(await runAttachHookA(race.ctx, pass.id, undefined, { connection: fence })).toBeNull();
    expect(race.fired()).toBe(true);
    expect(await state(pass.id)).toEqual(before);
    expect(await attachAudits(pass.id)).toEqual({ n: 0 });
  });

  it('does not attach with a connection fence belonging to another organization', async () => {
    const { pass, fence } = await waitingPass();
    const foreign = await makeOrg(kit.fx);
    expect(
      await runAttachHookA(jobCtxOf(kit), pass.id, undefined, {
        connection: { ...fence, orgId: foreign.id },
      }),
    ).toBeNull();
    expect((await state(pass.id))?.owner_user_id).toBeNull();
    expect(await attachAudits(pass.id)).toEqual({ n: 0 });
  });

  it.each([true, false])(
    'rejects an out-of-transfer organization move before attachment (connection=%s)',
    async (withConnection) => {
      const { pass, holder, fence } = await waitingPass();
      const foreign = await makeOrg(kit.fx);
      await expect(
        run(kit.env.DB, 'UPDATE passes SET org_id = ? WHERE id = ?', [foreign.id, pass.id]),
      ).rejects.toBeDefined();
      const options = withConnection ? { connection: fence } : undefined;
      expect(await runAttachHookA(jobCtxOf(kit), pass.id, undefined, options)).toMatchObject({
        state: 'completed',
        ownerUserId: holder.id,
      });
    },
  );

  it('rejects an out-of-transfer mode change before connection attachment', async () => {
    const { pass, holder, fence } = await waitingPass();
    await expect(
      run(kit.env.DB, "UPDATE passes SET mode = 'test' WHERE id = ?", [pass.id]),
    ).rejects.toBeDefined();
    expect(
      await runAttachHookA(jobCtxOf(kit), pass.id, undefined, { connection: fence }),
    ).toMatchObject({
      state: 'completed',
      ownerUserId: holder.id,
    });
  });

  it.each(['blocked', 'disabled', 'unverified'] as const)(
    'rechecks that the chosen holder is not %s at the attachment batch',
    async (change) => {
      const { pass, holder, fence } = await waitingPass();
      const before = await state(pass.id);
      const race = atAttachCommit(() => {
        if (change === 'blocked')
          return run(
            kit.env.DB,
            'INSERT INTO pass_attach_blocks (pass_id, user_id, created_at) VALUES (?, ?, ?)',
            [pass.id, holder.id, kit.clock.now()],
          );
        if (change === 'disabled')
          return run(kit.env.DB, "UPDATE users SET status = 'disabled' WHERE id = ?", [holder.id]);
        return run(kit.env.DB, 'DELETE FROM user_emails WHERE user_id = ? AND email = ?', [
          holder.id,
          holder.primaryEmail,
        ]);
      });
      expect(await runAttachHookA(race.ctx, pass.id, undefined, { connection: fence })).toBeNull();
      expect(race.fired()).toBe(true);
      expect(await state(pass.id)).toEqual(before);
      expect(await attachAudits(pass.id)).toEqual({ n: 0 });
    },
  );

  it('fences attachment to the exact pass observed by issuance', async () => {
    const { pass, fence } = await waitingPass();
    const expectedSource = await getPass(kit.env.DB, pass.id);
    if (!expectedSource) throw new Error('Missing source pass');
    await run(kit.env.DB, 'UPDATE passes SET link_generation = link_generation + 1 WHERE id = ?', [
      pass.id,
    ]);
    expect(
      await runAttachHookA(jobCtxOf(kit), pass.id, undefined, {
        connection: fence,
        expectedSource,
      }),
    ).toBeNull();
    expect((await state(pass.id))?.owner_user_id).toBeNull();
    expect(await attachAudits(pass.id)).toEqual({ n: 0 });
  });

  it('retains the trusted manual hook behavior without a connection fence', async () => {
    const { pass, holder, connection } = await waitingPass();
    await run(kit.env.DB, 'UPDATE connections SET enabled = 0 WHERE id = ?', [connection.id]);
    expect(await runAttachHookA(jobCtxOf(kit), pass.id)).toMatchObject({
      state: 'completed',
      ownerUserId: holder.id,
    });
    expect((await state(pass.id))?.owner_user_id).toBe(holder.id);
  });
});
