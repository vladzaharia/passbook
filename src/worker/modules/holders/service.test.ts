import { beforeAll, describe, expect, it } from 'vitest';
import { installKeysetTestEnv } from '../../../../test/helpers/credential-keyset.ts';
import { makeUser } from '../../../../test/helpers/index.ts';
import { all, first, run } from '../../platform/db.ts';
import { jobCtxOf } from '../delivery/delivery-test-fixtures.ts';
import { createPassRow } from '../passes/create.ts';
import {
  finishCredentialTransfer,
  startCredentialTransfer,
} from '../passes/credential-transfer.ts';
import { type Kit, setupKit } from '../passes/pass-test-fixtures.ts';
import { removePass } from '../passes/remove.ts';
import { setDownloadToken } from '../passes/repo.ts';
import { getPass } from '../passes/repo-read-pass.ts';
import { voidPass } from '../passes/service.ts';
import { setupSamsungCallbacks } from '../wallet-providers/callbacks-test-fixtures.ts';
import {
  claimWalletOperation,
  completeWalletOperation,
  getWalletInstanceById,
  newWalletClaimHandle,
} from '../wallet-providers/instance.ts';
import { reconcileWalletInstance } from '../wallet-providers/lifecycle.ts';
import { finishWalletProviderRetirement } from '../wallet-providers/sync-operation-retirement.ts';
import { getHolderPass, listSweepWaitingPasses, waitingHolderSweepUpper } from './repo.ts';
import {
  assignHolder,
  clearBlock,
  listHolders,
  reassignHolder,
  runAttachHookA,
  unassignHolder,
} from './service.ts';
import { attachWaitingPassesForEmail } from './service-attach.ts';
import { removePassFromUser } from './service-remove.ts';
import { ownerSessionId } from './test-auth-fixtures.ts';
import { resumeVerifiedHolderAttachments } from './transfer-jobs.ts';

// Storage lasts for the whole file; the credential keyset is immutable, so Samsung cases get their own D1.
const makeEnv = installKeysetTestEnv();

let kit: Kit;
beforeAll(async () => {
  kit = await setupKit();
});

const admin = { type: 'system', id: null } as const;
const email = () =>
  `holder-${kit.fx.ids.token(6).toLowerCase()}@example.com`.replace(/[^a-z0-9@.-]/g, 'x');

async function owner(passId: string) {
  return (await getPass(kit.env.DB, passId))?.ownerUserId ?? null;
}

describe('hook A: a pass gets a holder email', () => {
  it('attaches to the single user who verified the address', async () => {
    const e = email();
    const user = await makeUser(kit.fx, { primaryEmail: e });
    const pass = await kit.pass({ holderEmail: e.toUpperCase() });
    expect(await owner(pass.id)).toBe(user.id);
  });

  it('leaves the pass waiting when the address is not verified', async () => {
    const e = email();
    await makeUser(kit.fx, { primaryEmail: e, verified: false });
    const pass = await kit.pass({ holderEmail: e });
    expect(await owner(pass.id)).toBeNull();
    expect((await getPass(kit.env.DB, pass.id))?.holderEmail).toBe(e);
  });

  it('does not attach to a disabled user', async () => {
    const e = email();
    const user = await makeUser(kit.fx, { primaryEmail: e });
    await run(kit.env.DB, "UPDATE users SET status = 'disabled' WHERE id = ?", [user.id]);
    const pass = await kit.pass({ holderEmail: e });
    expect(await owner(pass.id)).toBeNull();
  });

  async function claimOnly(e: string) {
    const other = await makeUser(kit.fx, { verified: false });
    await run(
      kit.env.DB,
      `INSERT INTO auth_identities (provider, subject, user_id, email_claim, email_verified, created_at)
       VALUES ('oidc', ?, ?, ?, 1, 1)`,
      [`sub-${other.id}`, other.id, e],
    );
    return other;
  }

  it('ignores an OIDC email claim that is not in user_emails (trustEmail off)', async () => {
    const e = email();
    await claimOnly(e);
    const pass = await kit.pass({ holderEmail: e });
    expect(await owner(pass.id)).toBeNull();
  });

  it('attaches to the account in user_emails even when another identity claims the address', async () => {
    const e = email();
    const verified = await makeUser(kit.fx, { primaryEmail: e });
    await claimOnly(e);
    const pass = await kit.pass({ holderEmail: e });
    expect(await owner(pass.id)).toBe(verified.id);
  });

  it('does nothing for a pass without an email', async () => {
    const pass = await kit.pass();
    expect(await runAttachHookA(jobCtxOf(kit), pass.id)).toBeNull();
    expect(await owner(pass.id)).toBeNull();
  });

  it('writes audit rows with ids and no email address', async () => {
    const e = email();
    const user = await makeUser(kit.fx, { primaryEmail: e });
    const pass = await kit.pass({ holderEmail: e });
    const rows = await all<{ action: string; detail: string }>(
      kit.env.DB,
      "SELECT action, detail FROM audit_log WHERE target_id = ? AND action = 'holder.attach'",
      [pass.id],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.detail).toContain(user.id);
    expect(rows[0]?.detail).not.toContain('@');
  });
});

describe('hook B: a user verifies an address', () => {
  it('attaches every waiting pass with that address, skipping owned and blocked ones', async () => {
    const e = email();
    const [a, b, blocked] = await Promise.all([
      kit.pass({ holderEmail: e }),
      kit.pass({ holderEmail: e }),
      kit.pass({ holderEmail: e }),
    ]);
    const user = await makeUser(kit.fx, { primaryEmail: e });
    const taken = await kit.pass({ holderEmail: e });
    await run(
      kit.env.DB,
      'INSERT INTO pass_attach_blocks (pass_id, user_id, created_at) VALUES (?, ?, 1)',
      [blocked?.id, user.id],
    );
    // Hook A ran at creation, before the user existed; the user now verifies.
    const attached = await attachWaitingPassesForEmail(jobCtxOf(kit), user.id, e.toUpperCase());
    expect(attached).toBe(2);
    expect(await owner(a?.id ?? '')).toBe(user.id);
    expect(await owner(b?.id ?? '')).toBe(user.id);
    expect(await owner(blocked?.id ?? '')).toBeNull();
    expect(await owner(taken.id)).toBe(user.id);
  });

  it('sweeps an eligible initially-issued waiting pass without transfer history', async () => {
    const isolated = await setupKit();
    const email = 'eligible-waiting@example.test';
    const pass = await isolated.pass({ holderEmail: email });
    const user = await makeUser(isolated.fx, { primaryEmail: email });
    expect(
      await first(isolated.env.DB, 'SELECT 1 FROM pass_credential_transfers WHERE pass_id = ?', [
        pass.id,
      ]),
    ).toBeNull();
    await resumeVerifiedHolderAttachments(jobCtxOf(isolated));
    expect(await getPass(isolated.env.DB, pass.id)).toMatchObject({ ownerUserId: user.id });
    expect(
      await first(
        isolated.env.DB,
        `SELECT state, target_owner_user_id
      FROM pass_credential_transfers WHERE pass_id = ?`,
        [pass.id],
      ),
    ).toEqual({ state: 'completed', target_owner_user_id: user.id });
  }, 120_000);

  it('pages eligible waiting passes within a fixed high-water mark', async () => {
    const isolated = await setupKit();
    const email = 'paged-waiting@example.test';
    const passes = await Promise.all(
      Array.from({ length: 3 }, () => isolated.pass({ holderEmail: email })),
    );
    const user = await makeUser(isolated.fx, { primaryEmail: email });
    const upper = await waitingHolderSweepUpper(isolated.env.DB);
    if (!upper) throw new Error('Missing sweep boundary');
    const firstPage = await listSweepWaitingPasses(isolated.env.DB, { after: null, upper }, 2);
    expect(firstPage).toHaveLength(2);
    const secondPage = await listSweepWaitingPasses(
      isolated.env.DB,
      { after: firstPage[1]!.id, upper },
      2,
    );
    expect([...firstPage, ...secondPage].map((row) => row.id).sort()).toEqual(
      passes.map((pass) => pass.id).sort(),
    );
    await run(
      isolated.env.DB,
      'INSERT INTO pass_attach_blocks (pass_id, user_id, created_at) VALUES (?, ?, ?)',
      [passes[0]!.id, user.id, isolated.clock.now()],
    );
    const eligible = await listSweepWaitingPasses(isolated.env.DB, { after: null, upper }, 10);
    expect(eligible.map((row) => row.id)).not.toContain(passes[0]!.id);
  }, 120_000);

  it('attaches an address verified while its preceding transfer was pending', async () => {
    const t = await setupSamsungCallbacks({ db: (await makeEnv()).DB });
    const nextEmail = 'verified-during-transfer@example.test';
    const staged = await reassignHolder(
      jobCtxOf(t.kit),
      { type: 'system', id: null },
      { passId: t.pass.id, email: nextEmail },
      null,
    );
    expect(staged.transfer?.state).toBe('pending');
    const user = await makeUser(t.kit.fx, { primaryEmail: nextEmail });
    expect(await attachWaitingPassesForEmail(jobCtxOf(t.kit), user.id, nextEmail)).toBe(0);

    const { credentialKeysetCommitment } = t;
    const scope = {
      orgId: t.pass.orgId,
      mode: t.pass.mode,
      provider: 'samsung' as const,
      instanceId: t.operation.instanceId,
      credentialKeysetCommitment,
    };
    const old = await getWalletInstanceById(t.kit.env.DB, scope);
    if (!old || !staged.transfer) throw new Error('Missing old instance or transfer');
    expect(await reconcileWalletInstance(jobCtxOf(t.kit), old)).toBe('scheduled');
    const retiring = await getWalletInstanceById(t.kit.env.DB, scope);
    if (!retiring) throw new Error('Missing retiring instance');
    const claim = {
      ...scope,
      version: retiring.desiredVersion,
      claimHandle: newWalletClaimHandle(),
      now: t.kit.clock.now(),
    };
    expect(await claimWalletOperation(t.kit.env.DB, claim)).toBe('claimed');
    expect(
      await completeWalletOperation(jobCtxOf(t.kit), {
        ...claim,
        result: { kind: 'success', httpStatus: 200 },
      }),
    ).toBe('succeeded');
    expect(await finishWalletProviderRetirement(jobCtxOf(t.kit), claim)).toBe(true);
    expect(
      await finishCredentialTransfer(jobCtxOf(t.kit), staged.transfer.transferId),
    ).toMatchObject({
      state: 'completed',
    });
    expect((await getPass(t.kit.env.DB, t.pass.id))?.ownerUserId).toBeNull();
    await resumeVerifiedHolderAttachments(jobCtxOf(t.kit));
    await t.kit.settle();
    expect(await getPass(t.kit.env.DB, t.pass.id)).toMatchObject({
      holderEmail: nextEmail,
      ownerUserId: user.id,
    });
    await resumeVerifiedHolderAttachments(jobCtxOf(t.kit));
    expect(
      await first(
        t.kit.env.DB,
        `SELECT count(*) AS n FROM pass_credential_transfers
      WHERE pass_id = ? AND state = 'completed'`,
        [t.pass.id],
      ),
    ).toEqual({ n: 2 });
    expect(
      await first(
        t.kit.env.DB,
        `SELECT count(*) AS n FROM pass_credential_transfers
      WHERE pass_id = ?`,
        [t.pass.id],
      ),
    ).toEqual({ n: 2 });
  }, 120_000);

  it('does not take the caller’s word that an address is verified', async () => {
    const e = email();
    const pass = await kit.pass({ holderEmail: e });
    const stranger = await makeUser(kit.fx);
    expect(await attachWaitingPassesForEmail(jobCtxOf(kit), stranger.id, e)).toBe(0);
    expect(await owner(pass.id)).toBeNull();
  });

  it('ignores addresses that are not valid emails', async () => {
    const user = await makeUser(kit.fx);
    expect(await attachWaitingPassesForEmail(jobCtxOf(kit), user.id, 'a@b.com, c@d.com')).toBe(0);
  });
});

describe('removal and blocks', () => {
  it('removing writes a block, clears the owner and keeps the email', async () => {
    const e = email();
    const user = await makeUser(kit.fx, { primaryEmail: e });
    const pass = await kit.pass({ holderEmail: e });
    await removePassFromUser(jobCtxOf(kit), pass.id, user.id, await ownerSessionId(kit, user.id));
    const after = await getPass(kit.env.DB, pass.id);
    expect(after?.ownerUserId).toBeNull();
    expect(after?.holderEmail).toBe(e);
    // A later verification must not re-attach.
    expect(await attachWaitingPassesForEmail(jobCtxOf(kit), user.id, e)).toBe(0);
    expect(await runAttachHookA(jobCtxOf(kit), pass.id)).toBeNull();
  });

  it.each(['voided', 'removed'] as const)(
    'lets a holder remove a %s pass without restoring its lifecycle',
    async (status) => {
      const e = email();
      const user = await makeUser(kit.fx, { primaryEmail: e });
      const pass = await kit.pass({ holderEmail: e });
      if (status === 'voided') await voidPass(jobCtxOf(kit), admin, pass.id, null);
      else await removePass(jobCtxOf(kit), admin, pass.id, {}, null);
      const before = await getPass(kit.env.DB, pass.id);
      const result = await removePassFromUser(
        jobCtxOf(kit),
        pass.id,
        user.id,
        await ownerSessionId(kit, user.id),
      );
      expect(result.state).toBe('completed');
      const after = await getPass(kit.env.DB, pass.id);
      expect(after).toMatchObject({
        ownerUserId: null,
        holderEmail: e,
        status: before?.status,
        removedAt: before?.removedAt,
      });
      expect(after?.authToken).not.toBe(before?.authToken);
    },
  );

  it('rejects someone who does not own the pass', async () => {
    const pass = await kit.pass();
    const stranger = await makeUser(kit.fx);
    await expect(
      removePassFromUser(
        jobCtxOf(kit),
        pass.id,
        stranger.id,
        await ownerSessionId(kit, stranger.id),
      ),
    ).rejects.toMatchObject({
      code: 'PASS_CONFLICT',
    });
    const block = await first(kit.env.DB, 'SELECT 1 FROM pass_attach_blocks WHERE pass_id = ?', [
      pass.id,
    ]);
    expect(block).toBeNull();
  });

  it('does not remove or block a different incarnation after an owned-pass read', async () => {
    const e = email();
    const user = await makeUser(kit.fx, { primaryEmail: e });
    const pass = await kit.pass({ holderEmail: e });
    const source = await getPass(kit.env.DB, pass.id);
    if (!source) throw new Error('Missing owned pass');
    expect(await setDownloadToken(kit.env.DB, source, kit.fx.ids.token(), kit.clock.now())).toBe(
      true,
    );
    await expect(
      removePassFromUser(
        jobCtxOf(kit),
        pass.id,
        user.id,
        await ownerSessionId(kit, user.id),
        source,
      ),
    ).rejects.toMatchObject({
      code: 'PASS_CONFLICT',
    });
    expect((await getPass(kit.env.DB, pass.id))?.ownerUserId).toBe(user.id);
    expect(
      await first(
        kit.env.DB,
        'SELECT 1 FROM pass_attach_blocks WHERE pass_id = ? AND user_id = ?',
        [pass.id, user.id],
      ),
    ).toBeNull();
  });

  it('clearing a block lets the user attach again', async () => {
    const e = email();
    const user = await makeUser(kit.fx, { primaryEmail: e });
    const pass = await kit.pass({ holderEmail: e });
    await removePassFromUser(jobCtxOf(kit), pass.id, user.id, await ownerSessionId(kit, user.id));
    await clearBlock(jobCtxOf(kit), admin, { passId: pass.id, userId: user.id }, null);
    expect(await owner(pass.id)).toBe(user.id);
    await expect(
      clearBlock(jobCtxOf(kit), admin, { passId: pass.id, userId: user.id }, null),
    ).rejects.toMatchObject({ code: 'BLOCK_NOT_FOUND' });
  });
});

describe('admin assign, reassign, unassign', () => {
  it('assign sets the email and attaches; an owned pass needs reassign', async () => {
    const e = email();
    const user = await makeUser(kit.fx, { primaryEmail: e });
    const pass = await kit.pass();
    const holder = await assignHolder(
      jobCtxOf(kit),
      admin,
      { passId: pass.id, email: ` ${e.toUpperCase()} ` },
      null,
    );
    expect(holder).toMatchObject({ state: 'owned', email: e, ownerUserId: user.id });
    await expect(
      assignHolder(jobCtxOf(kit), admin, { passId: pass.id, email: email() }, null),
    ).rejects.toMatchObject({ code: 'HOLDER_OWNED' });
    // Case-only repeat is idempotent.
    expect(
      (await assignHolder(jobCtxOf(kit), admin, { passId: pass.id, email: e }, null)).state,
    ).toBe('owned');
  });

  it('commits a fresh credential incarnation before reporting a completed assignment', async () => {
    const pass = await kit.pass();
    const nextEmail = email();
    const user = await makeUser(kit.fx, { primaryEmail: nextEmail });
    const holder = await assignHolder(
      jobCtxOf(kit),
      admin,
      { passId: pass.id, email: nextEmail },
      null,
    );
    expect(holder).toMatchObject({
      email: nextEmail,
      ownerUserId: user.id,
      transfer: { transferId: expect.any(String), state: 'completed' },
    });
    const after = await getPass(kit.env.DB, pass.id);
    expect(after).toMatchObject({
      holderEmail: nextEmail,
      ownerUserId: user.id,
      credentialGeneration: pass.credentialGeneration + 1,
    });
    expect(after?.serial).not.toBe(pass.serial);
    expect(after?.authToken).not.toBe(pass.authToken);
    expect(after?.scanCode).not.toBe(pass.scanCode);
    expect(after?.downloadToken).not.toBe(pass.downloadToken);
    expect(
      await first(
        kit.env.DB,
        'SELECT state, source_generation, target_generation FROM pass_credential_transfers WHERE id = ?',
        [holder.transfer!.transferId],
      ),
    ).toEqual({
      state: 'completed',
      source_generation: pass.credentialGeneration,
      target_generation: pass.credentialGeneration + 1,
    });
    expect(
      (await assignHolder(jobCtxOf(kit), admin, { passId: pass.id, email: nextEmail }, null))
        .transfer,
    ).toBeNull();
    expect(
      await first(
        kit.env.DB,
        'SELECT count(*) AS n FROM pass_credential_transfers WHERE pass_id = ?',
        [pass.id],
      ),
    ).toEqual({ n: 1 });
  });

  it('rejects a stale credential generation even when every other source field is current', async () => {
    const pass = await kit.pass();
    const nextEmail = email();
    const user = await makeUser(kit.fx, { primaryEmail: nextEmail });
    await assignHolder(jobCtxOf(kit), admin, { passId: pass.id, email: nextEmail }, null);
    const current = await getHolderPass(kit.env.DB, pass.id, null);
    if (!current) throw new Error('Missing current holder snapshot');
    await expect(
      startCredentialTransfer(
        jobCtxOf(kit),
        admin,
        pass.id,
        { holderEmail: null, ownerUserId: null },
        null,
        {
          kind: 'tenant-holder',
          expected: { ...current, credentialGeneration: pass.credentialGeneration },
        },
      ),
    ).rejects.toMatchObject({ code: 'PASS_CONFLICT' });
    expect(await getPass(kit.env.DB, pass.id)).toMatchObject({
      ownerUserId: user.id,
      credentialGeneration: current.credentialGeneration,
    });
    expect(
      await first(
        kit.env.DB,
        'SELECT count(*) AS n FROM pass_credential_transfers WHERE pass_id = ?',
        [pass.id],
      ),
    ).toEqual({ n: 1 });
  });

  it('rejects invalid addresses', async () => {
    const pass = await kit.pass();
    await expect(
      assignHolder(jobCtxOf(kit), admin, { passId: pass.id, email: 'nope' }, null),
    ).rejects.toMatchObject({ code: 'EMAIL_INVALID' });
  });

  it('reassign clears the owner, sets the new email, runs hook A and is audited', async () => {
    const oldEmail = email();
    const newEmail = email();
    const oldUser = await makeUser(kit.fx, { primaryEmail: oldEmail });
    const newUser = await makeUser(kit.fx, { primaryEmail: newEmail });
    const pass = await kit.pass({ holderEmail: oldEmail });
    expect(await owner(pass.id)).toBe(oldUser.id);
    const holder = await reassignHolder(
      jobCtxOf(kit),
      admin,
      { passId: pass.id, email: newEmail },
      null,
    );
    expect(holder).toMatchObject({ state: 'owned', ownerUserId: newUser.id });
    const audit = await first<{ detail: string }>(
      kit.env.DB,
      "SELECT detail FROM audit_log WHERE target_id = ? AND action = 'holder.reassign'",
      [pass.id],
    );
    expect(audit?.detail).toContain(oldUser.id);
  });

  it('reassign to nothing and unassign leave the pass unassigned', async () => {
    const e = email();
    await makeUser(kit.fx, { primaryEmail: e });
    const pass = await kit.pass({ holderEmail: e });
    expect(
      await reassignHolder(jobCtxOf(kit), admin, { passId: pass.id, email: null }, null),
    ).toMatchObject({
      state: 'unassigned',
    });
    await assignHolder(jobCtxOf(kit), admin, { passId: pass.id, email: e }, null);
    expect(await unassignHolder(jobCtxOf(kit), admin, pass.id, null)).toMatchObject({
      state: 'unassigned',
      email: null,
    });
  });

  it('an org-scoped caller cannot touch another organization’s pass', async () => {
    const pass = await kit.pass();
    await expect(
      assignHolder(jobCtxOf(kit), admin, { passId: pass.id, email: email() }, 'some-other-org'),
    ).rejects.toMatchObject({ status: 404 });
  });

  it('does not expose, assign or auto-attach quarantined test passes', async () => {
    const e = email();
    const user = await makeUser(kit.fx, { primaryEmail: e });
    const pass = await createPassRow(jobCtxOf(kit), {
      orgId: kit.org.id,
      templateId: kit.template.id,
      templateVersion: kit.testRelease!.version,
      releaseId: kit.testRelease!.id,
      releaseGeneration: kit.testRelease!.generation,
      mode: 'test',
      source: 'manual',
      execution: { kind: 'system' },
      holderEmail: e,
      input: { memberName: 'Quarantined holder' },
      actor: { type: 'system', id: null },
    });
    await run(kit.env.DB, 'UPDATE passes SET test_data_quarantined = 1 WHERE id = ?', [pass.id]);
    await expect(
      assignHolder(jobCtxOf(kit), admin, { passId: pass.id, email: e }, null),
    ).rejects.toMatchObject({ status: 404 });
    expect(await attachWaitingPassesForEmail(jobCtxOf(kit), user.id, e)).toBe(0);
    expect(
      (await listHolders(jobCtxOf(kit), { orgId: kit.org.id, email: e, mode: 'test', limit: 10 }))
        .items,
    ).toEqual([]);
  });
});

describe('list', () => {
  it('filters by state and email and includes blocks', async () => {
    const e = email();
    const user = await makeUser(kit.fx, { primaryEmail: e });
    const pass = await kit.pass({ holderEmail: e });
    await removePassFromUser(jobCtxOf(kit), pass.id, user.id, await ownerSessionId(kit, user.id));
    const waiting = await listHolders(jobCtxOf(kit), {
      orgId: kit.org.id,
      state: 'waiting',
      email: e,
      limit: 10,
    });
    expect(waiting.items).toHaveLength(1);
    expect(waiting.items[0]).toMatchObject({ passId: pass.id, blockedUserIds: [user.id] });
    const owned = await listHolders(jobCtxOf(kit), {
      orgId: kit.org.id,
      state: 'owned',
      email: e,
      limit: 10,
    });
    expect(owned.items).toHaveLength(0);
    expect(
      (await listHolders(jobCtxOf(kit), { orgId: kit.org.id, email: 'not an email', limit: 10 }))
        .items,
    ).toEqual([]);
  });
});
