import { describe, expect, it } from 'vitest';
import { first, run } from '../../platform/db.ts';
import { createAuthStores } from '../../stores.ts';
import { signInMagicLink } from '../auth/service.ts';
import { jobCtxOf } from '../delivery/delivery-test-fixtures.ts';
import { ensureCredentialRefKeyset } from '../passes/credential-keyset.ts';
import { tenantAuthorityOf } from '../passes/http.ts';
import type { Kit } from '../passes/pass-test-fixtures.ts';
import { setDownloadToken } from '../passes/repo.ts';
import { getPass } from '../passes/repo-read-pass.ts';
import { atOwnerWrite, fixedBarcodePass } from './fixed-barcode-fixtures.ts';
import { getHolderPass, markHolderReissueRequired } from './repo.ts';
import { attachWaitingPassesForEmail, getHolder, runAttachHookA } from './service.ts';
import { eventMember } from './test-auth-fixtures.ts';

const count = (kit: Kit, sql: string, id: string) =>
  first<{ n: number }>(kit.env.DB, sql, [id]).then((row) => row?.n);
const attachAudits = (kit: Kit, id: string, action: string) =>
  count(
    kit,
    `SELECT count(*) AS n FROM audit_log WHERE action = '${action}' AND target_id = ?`,
    id,
  );
const noMarker = async (kit: Kit, id: string) =>
  expect(
    await first(kit.env.DB, 'SELECT 1 FROM pass_holder_reissue_required WHERE pass_id = ?', [id]),
  ).toBeNull();

describe('verified attach of a pass whose credential cannot change', () => {
  it('links the account without rotating the credential', async () => {
    const { kit, pass, user, email } = await fixedBarcodePass();
    expect(await attachWaitingPassesForEmail(jobCtxOf(kit), user.id, email)).toBe(1);
    const after = await getPass(kit.env.DB, pass.id);
    expect(after).toMatchObject({
      ownerUserId: user.id,
      holderEmail: email,
      credentialGeneration: pass.credentialGeneration,
      linkGeneration: pass.linkGeneration,
      downloadToken: pass.downloadToken,
      serial: pass.serial,
      scanCode: pass.scanCode,
      authToken: pass.authToken,
      version: pass.version,
    });
    expect(await getHolder(jobCtxOf(kit), pass.id, null)).toMatchObject({
      state: 'owned',
      ownerUserId: user.id,
      transfer: null,
      reissueRequired: false,
    });
    const audit = await first<{ detail: string }>(
      kit.env.DB,
      "SELECT detail FROM audit_log WHERE action = 'holder.attach' AND target_id = ?",
      [pass.id],
    );
    expect(JSON.parse(audit?.detail ?? 'null')).toEqual({
      via: 'email',
      userId: user.id,
      rotated: false,
    });
    expect(await attachAudits(kit, pass.id, 'holder.attach_reissue_required')).toBe(0);
    expect(await attachAudits(kit, pass.id, 'pass.transfer_started')).toBe(0);
    await noMarker(kit, pass.id);
    expect(
      await first(kit.env.DB, 'SELECT 1 FROM pass_credential_tombstones WHERE pass_id = ?', [
        pass.id,
      ]),
    ).toBeNull();
  }, 120_000);

  it('clears a recorded reissue requirement when it links', async () => {
    const { kit, pass, user } = await fixedBarcodePass();
    const source = await getHolderPass(kit.env.DB, pass.id, null);
    if (!source) throw new Error('Missing holder source');
    await markHolderReissueRequired(
      kit.env.DB,
      pass.id,
      source,
      user.id,
      kit.clock.now(),
      await ensureCredentialRefKeyset(kit.env.DB, kit.env),
      undefined,
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
    expect((await getHolder(jobCtxOf(kit), pass.id, null)).reissueRequired).toBe(true);
    expect(await runAttachHookA(jobCtxOf(kit), pass.id)).toMatchObject({
      state: 'completed',
      ownerUserId: user.id,
    });
    await noMarker(kit, pass.id);
  }, 120_000);

  it('links at magic-link sign-in', async () => {
    const { kit, pass, user, email } = await fixedBarcodePass();
    const session = await signInMagicLink(jobCtxOf(kit), email, {
      ipPrefix: null,
      userAgent: null,
    });
    expect(session.userId).toBe(user.id);
    expect(await getHolder(jobCtxOf(kit), pass.id, null)).toMatchObject({
      state: 'owned',
      reissueRequired: false,
    });
  }, 120_000);

  it('still requires a reissue when a target reference was retired', async () => {
    const { kit, pass, user, email } = await fixedBarcodePass({ retired: true });
    expect(await attachWaitingPassesForEmail(jobCtxOf(kit), user.id, email)).toBe(0);
    expect(await getPass(kit.env.DB, pass.id)).toMatchObject({
      ownerUserId: null,
      downloadToken: pass.downloadToken,
    });
    expect(await getHolder(jobCtxOf(kit), pass.id, null)).toMatchObject({ reissueRequired: true });
    expect(await attachAudits(kit, pass.id, 'holder.attach_reissue_required')).toBe(1);
    expect(await attachAudits(kit, pass.id, 'holder.attach')).toBe(0);
  }, 120_000);

  it.each(['disabled', 'unverified', 'blocked', 'changed'] as const)(
    'does not link when the user or pass is %s at the write',
    async (change) => {
      const { kit, pass, user, email } = await fixedBarcodePass();
      const race = atOwnerWrite(kit, async () => {
        if (change === 'disabled')
          return run(kit.env.DB, "UPDATE users SET status = 'disabled' WHERE id = ?", [user.id]);
        if (change === 'unverified')
          return run(kit.env.DB, 'DELETE FROM user_emails WHERE user_id = ? AND email = ?', [
            user.id,
            email,
          ]);
        if (change === 'blocked')
          return run(
            kit.env.DB,
            'INSERT INTO pass_attach_blocks (pass_id, user_id, created_at) VALUES (?, ?, ?)',
            [pass.id, user.id, kit.clock.now()],
          );
        const current = await getPass(kit.env.DB, pass.id);
        if (!current) throw new Error('Missing pass');
        return setDownloadToken(kit.env.DB, current, kit.fx.ids.token(), kit.clock.now());
      });
      expect(await runAttachHookA(race.ctx, pass.id)).toBeNull();
      expect(race.fired()).toBe(true);
      expect((await getPass(kit.env.DB, pass.id))?.ownerUserId).toBeNull();
      expect(await attachAudits(kit, pass.id, 'holder.attach')).toBe(0);
    },
    120_000,
  );

  it('does not link after the initiating tenant authority is revoked', async () => {
    const { kit, pass } = await fixedBarcodePass();
    const member = await eventMember(kit, kit.org.id, ['pass_operator']);
    const auth = await createAuthStores(kit.env).sessions.resolve(member.session.cookieValue);
    if (!auth) throw new Error('Missing session');
    const authority = await tenantAuthorityOf(jobCtxOf(kit), auth, kit.org.id, 'passes:operate');
    const race = atOwnerWrite(kit, () =>
      run(kit.env.DB, 'UPDATE org_memberships SET revoked_at = ? WHERE id = ?', [
        kit.clock.now(),
        member.membership,
      ]),
    );
    // A revoked tenant authority is a 403 the caller sees, as on the transfer path.
    await expect(
      runAttachHookA(race.ctx, pass.id, { type: 'user', id: member.user.id }, { authority }),
    ).rejects.toMatchObject({ status: 403 });
    expect(race.fired()).toBe(true);
    expect((await getPass(kit.env.DB, pass.id))?.ownerUserId).toBeNull();
    expect(await attachAudits(kit, pass.id, 'holder.attach')).toBe(0);
  }, 120_000);

  it('does not link after its source connection is disabled', async () => {
    const { kit, pass } = await fixedBarcodePass();
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
    const race = atOwnerWrite(kit, () =>
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
    expect((await getPass(kit.env.DB, pass.id))?.ownerUserId).toBeNull();
  }, 120_000);

  it('links a connection-backed pass', async () => {
    const { kit, pass } = await fixedBarcodePass();
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
    expect(
      await runAttachHookA(
        jobCtxOf(kit),
        pass.id,
        { type: 'connection', id: connectionId },
        {
          connection: { orgId: kit.org.id, connectionId, externalRef: 'member-1', generation: 1 },
        },
      ),
    ).toMatchObject({ state: 'completed' });
    expect((await getPass(kit.env.DB, pass.id))?.ownerUserId).not.toBeNull();
  }, 120_000);
});
