import { describe, expect, it } from 'vitest';
import { makeUser } from '../../../../test/helpers/index.ts';
import { first, run } from '../../platform/db.ts';
import type { AppEnv } from '../../platform/env.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { createAuthStores } from '../../stores.ts';
import { signInMagicLink } from '../auth/service.ts';
import { jobCtxOf } from '../delivery/delivery-test-fixtures.ts';
import { ensureCredentialRefKeyset } from '../passes/credential-keyset.ts';
import { depsOf, overrideDeps } from '../passes/deps.ts';
import { tenantAuthorityOf } from '../passes/http.ts';
import type { Kit } from '../passes/pass-test-fixtures.ts';
import { setDownloadToken } from '../passes/repo.ts';
import { getPass } from '../passes/repo-read-pass.ts';
import { voidPass } from '../passes/service.ts';
import { fixedBarcodePass } from './fixed-barcode-test-fixtures.ts';
import { getHolderPass, holderReissueCurrentSql, markHolderReissueRequired } from './repo.ts';
import { getHolder, reassignHolder, runAttachHookA } from './service.ts';
import { attachWaitingPassesForEmail } from './service-attach.ts';
import { eventMember } from './test-auth-fixtures.ts';
import { resumeVerifiedHolderAttachments } from './transfer-jobs.ts';

function atReissueWrite(kit: Kit, change: () => Promise<unknown>) {
  let fired = false;
  const writes = new WeakSet<D1PreparedStatement>();
  const db = new Proxy(kit.env.DB, {
    get(target, prop) {
      if (prop === 'prepare')
        return (sql: string) => {
          const prepared = target.prepare(sql);
          if (!/^\s*INSERT INTO pass_holder_reissue_required\b/i.test(sql)) return prepared;
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
          if (!fired && statements.some((statement) => writes.has(statement))) {
            fired = true;
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
  return { ctx: { ...jobCtxOf(kit), env } as ServiceContext, fired: () => fired };
}

describe('verified attachment requiring credential reissue', () => {
  it('records one private current requirement and audit without claiming attachment', async () => {
    const { kit, pass, user, email } = await fixedBarcodePass({ retired: true });
    expect(await attachWaitingPassesForEmail(jobCtxOf(kit), user.id, email)).toBe(0);
    expect(await getHolder(jobCtxOf(kit), pass.id, null)).toMatchObject({
      ownerUserId: null,
      email,
      transfer: null,
      reissueRequired: true,
    });
    const requirement = await first<Record<string, unknown>>(
      kit.env.DB,
      'SELECT * FROM pass_holder_reissue_required WHERE pass_id = ?',
      [pass.id],
    );
    expect(requirement).toMatchObject({
      pass_id: pass.id,
      org_id: pass.orgId,
      user_id: user.id,
      credential_generation: pass.credentialGeneration,
    });
    expect(JSON.stringify(requirement)).not.toContain(email);
    expect(JSON.stringify(requirement)).not.toContain(pass.downloadToken);
    const eligible = (userId: string) =>
      first(
        kit.env.DB,
        `SELECT p.id FROM passes p WHERE p.id = ? AND ${holderReissueCurrentSql('p', '?')}`,
        [pass.id, userId],
      );
    expect(await eligible(user.id)).not.toBeNull();
    expect(await eligible((await makeUser(kit.fx)).id)).toBeNull();

    kit.clock.advance(1_000);
    expect(await runAttachHookA(jobCtxOf(kit), pass.id)).toBeNull();
    await resumeVerifiedHolderAttachments(jobCtxOf(kit));
    expect(
      await first(kit.env.DB, 'SELECT * FROM pass_holder_reissue_required WHERE pass_id = ?', [
        pass.id,
      ]),
    ).toEqual(requirement);
    expect(
      await first(
        kit.env.DB,
        `SELECT count(*) AS n FROM audit_log
      WHERE action = 'holder.attach_reissue_required' AND target_id = ?`,
        [pass.id],
      ),
    ).toEqual({ n: 1 });
    expect(await getPass(kit.env.DB, pass.id)).toMatchObject({
      ownerUserId: null,
      credentialGeneration: pass.credentialGeneration,
      downloadToken: pass.downloadToken,
    });

    await run(kit.env.DB, "UPDATE users SET status = 'disabled' WHERE id = ?", [user.id]);
    expect((await getHolder(jobCtxOf(kit), pass.id, null)).reissueRequired).toBe(false);
    await run(kit.env.DB, "UPDATE users SET status = 'active' WHERE id = ?", [user.id]);
    expect((await getHolder(jobCtxOf(kit), pass.id, null)).reissueRequired).toBe(true);
    const current = await getPass(kit.env.DB, pass.id);
    if (!current) throw new Error('Missing pass');
    expect(await setDownloadToken(kit.env.DB, current, kit.fx.ids.token(), kit.clock.now())).toBe(
      true,
    );
    expect((await getHolder(jobCtxOf(kit), pass.id, null)).reissueRequired).toBe(false);
    await resumeVerifiedHolderAttachments(jobCtxOf(kit));
    expect((await getHolder(jobCtxOf(kit), pass.id, null)).reissueRequired).toBe(true);
    expect(
      await first(
        kit.env.DB,
        `SELECT count(*) AS n FROM audit_log
      WHERE action = 'holder.attach_reissue_required' AND target_id = ?`,
        [pass.id],
      ),
    ).toEqual({ n: 2 });
  }, 120_000);

  it('completes verified sign-in while reporting the unattachable pass separately', async () => {
    const { kit, pass, user, email } = await fixedBarcodePass({ retired: true });
    const session = await signInMagicLink(jobCtxOf(kit), email, {
      ipPrefix: null,
      userAgent: null,
    });
    expect(session.userId).toBe(user.id);
    expect(await getHolder(jobCtxOf(kit), pass.id, null)).toMatchObject({
      ownerUserId: null,
      transfer: null,
      reissueRequired: true,
    });
    expect(
      await first(
        kit.env.DB,
        `SELECT count(*) AS n FROM audit_log
      WHERE action = 'holder.attach_reissue_required' AND target_id = ?`,
        [pass.id],
      ),
    ).toEqual({ n: 1 });
  }, 120_000);

  it('rejects a direct administrator transfer instead of recording an autoattach requirement', async () => {
    const { kit, pass } = await fixedBarcodePass();
    await expect(
      reassignHolder(
        jobCtxOf(kit),
        { type: 'system', id: null },
        { passId: pass.id, email: 'new-holder@example.test' },
        null,
      ),
    ).rejects.toMatchObject({ code: 'PASS_REISSUE_REQUIRED' });
    expect(
      await first(kit.env.DB, 'SELECT 1 FROM pass_holder_reissue_required WHERE pass_id = ?', [
        pass.id,
      ]),
    ).toBeNull();
    expect(
      await first(kit.env.DB, 'SELECT 1 FROM pass_credential_transfers WHERE pass_id = ?', [
        pass.id,
      ]),
    ).toBeNull();
  }, 120_000);

  it('does not record an attachment diagnosis from a different credential keyset', async () => {
    const { kit, pass, user } = await fixedBarcodePass({ retired: true });
    const source = await getHolderPass(kit.env.DB, pass.id, null);
    if (!source) throw new Error('Missing holder source');
    const keyset = await ensureCredentialRefKeyset(kit.env.DB, kit.env);
    const stale = keyset === '0'.repeat(64) ? '1'.repeat(64) : '0'.repeat(64);
    await markHolderReissueRequired(
      kit.env.DB,
      pass.id,
      source,
      user.id,
      kit.clock.now(),
      stale,
      undefined,
      {
        ctx: jobCtxOf(kit),
        entry: {
          orgId: pass.orgId,
          actorType: 'system',
          actorId: null,
          action: 'holder.attach_reissue_required',
          targetType: 'pass',
          targetId: pass.id,
          detail: { userId: user.id },
        },
      },
    );
    expect(
      await first(kit.env.DB, 'SELECT 1 FROM pass_holder_reissue_required WHERE pass_id = ?', [
        pass.id,
      ]),
    ).toBeNull();
    expect(
      await first(
        kit.env.DB,
        `SELECT 1 FROM audit_log
      WHERE action = 'holder.attach_reissue_required' AND target_id = ?`,
        [pass.id],
      ),
    ).toBeNull();
  }, 120_000);

  it('records the requirement for a voided waiting pass without attaching it', async () => {
    const { kit, pass } = await fixedBarcodePass({ retired: true });
    await voidPass(jobCtxOf(kit), { type: 'system', id: null }, pass.id, null);
    expect(await runAttachHookA(jobCtxOf(kit), pass.id)).toBeNull();
    expect(await getHolder(jobCtxOf(kit), pass.id, null)).toMatchObject({
      ownerUserId: null,
      reissueRequired: true,
    });
    expect((await getPass(kit.env.DB, pass.id))?.status).toBe('voided');
  }, 120_000);

  it('rolls back the requirement if its audit cannot be recorded', async () => {
    const { kit, pass } = await fixedBarcodePass({ retired: true });
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
    await expect(runAttachHookA({ ...jobCtxOf(kit), env }, pass.id)).rejects.toBeDefined();
    expect(
      await first(kit.env.DB, 'SELECT 1 FROM pass_holder_reissue_required WHERE pass_id = ?', [
        pass.id,
      ]),
    ).toBeNull();
  }, 120_000);

  it.each(['blocked', 'disabled', 'unverified', 'link'] as const)(
    'does not record a stale requirement when the user or pass becomes %s at the write',
    async (change) => {
      const { kit, pass, user, email } = await fixedBarcodePass({ retired: true });
      const race = atReissueWrite(kit, async () => {
        if (change === 'blocked')
          return run(
            kit.env.DB,
            'INSERT INTO pass_attach_blocks (pass_id, user_id, created_at) VALUES (?, ?, ?)',
            [pass.id, user.id, kit.clock.now()],
          );
        if (change === 'disabled')
          return run(kit.env.DB, "UPDATE users SET status = 'disabled' WHERE id = ?", [user.id]);
        if (change === 'unverified')
          return run(kit.env.DB, 'DELETE FROM user_emails WHERE user_id = ? AND email = ?', [
            user.id,
            email,
          ]);
        const current = await getPass(kit.env.DB, pass.id);
        if (!current) throw new Error('Missing pass');
        return setDownloadToken(kit.env.DB, current, kit.fx.ids.token(), kit.clock.now());
      });
      expect(await runAttachHookA(race.ctx, pass.id)).toBeNull();
      expect(race.fired()).toBe(true);
      expect(
        await first(kit.env.DB, 'SELECT 1 FROM pass_holder_reissue_required WHERE pass_id = ?', [
          pass.id,
        ]),
      ).toBeNull();
      expect(
        await first(
          kit.env.DB,
          `SELECT 1 FROM audit_log
        WHERE action = 'holder.attach_reissue_required' AND target_id = ?`,
          [pass.id],
        ),
      ).toBeNull();
    },
    120_000,
  );

  it('does not record a requirement after the initiating tenant authority is revoked', async () => {
    const { kit, pass } = await fixedBarcodePass({ retired: true });
    const member = await eventMember(kit, kit.org.id, ['pass_operator']);
    const auth = await createAuthStores(kit.env).sessions.resolve(member.session.cookieValue);
    if (!auth) throw new Error('Missing session');
    const authority = await tenantAuthorityOf(jobCtxOf(kit), auth, kit.org.id, 'passes:operate');
    const race = atReissueWrite(kit, () =>
      run(kit.env.DB, 'UPDATE org_memberships SET revoked_at = ? WHERE id = ?', [
        kit.clock.now(),
        member.membership,
      ]),
    );
    expect(
      await runAttachHookA(race.ctx, pass.id, { type: 'user', id: member.user.id }, { authority }),
    ).toBeNull();
    expect(race.fired()).toBe(true);
    expect(
      await first(kit.env.DB, 'SELECT 1 FROM pass_holder_reissue_required WHERE pass_id = ?', [
        pass.id,
      ]),
    ).toBeNull();
    expect(
      await first(
        kit.env.DB,
        `SELECT 1 FROM audit_log
      WHERE action = 'holder.attach_reissue_required' AND target_id = ?`,
        [pass.id],
      ),
    ).toBeNull();
  }, 120_000);

  it('does not record a requirement after its source connection is disabled', async () => {
    const { kit, pass } = await fixedBarcodePass({ retired: true });
    const connectionId = kit.fx.ids.id();
    await run(
      kit.env.DB,
      `INSERT INTO connections
      (id, org_id, connector_type, name, created_at, updated_at) VALUES (?, ?, 'demo', 'Source', ?, ?)`,
      [connectionId, kit.org.id, kit.clock.now(), kit.clock.now()],
    );
    await run(kit.env.DB, 'UPDATE passes SET connection_id = ?, external_ref = ? WHERE id = ?', [
      connectionId,
      'member-1',
      pass.id,
    ]);
    const race = atReissueWrite(kit, () =>
      run(kit.env.DB, 'UPDATE connections SET enabled = 0 WHERE id = ?', [connectionId]),
    );
    expect(
      await runAttachHookA(
        race.ctx,
        pass.id,
        { type: 'connection', id: connectionId },
        {
          connection: { orgId: kit.org.id, connectionId, externalRef: 'member-1', generation: 1 },
        },
      ),
    ).toBeNull();
    expect(race.fired()).toBe(true);
    expect(
      await first(kit.env.DB, 'SELECT 1 FROM pass_holder_reissue_required WHERE pass_id = ?', [
        pass.id,
      ]),
    ).toBeNull();
    expect(
      await first(
        kit.env.DB,
        `SELECT 1 FROM audit_log
      WHERE action = 'holder.attach_reissue_required' AND target_id = ?`,
        [pass.id],
      ),
    ).toBeNull();
  }, 120_000);
});
