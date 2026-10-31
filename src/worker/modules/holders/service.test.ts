import { beforeAll, describe, expect, it } from 'vitest';
import { makeUser } from '../../../../test/helpers/index.ts';
import { all, first, run } from '../../platform/db.ts';
import { getPass } from '../passes/repo.ts';
import { type Kit, setupKit } from '../passes/test-kit.ts';
import {
  assignHolder,
  attachWaitingPassesForEmail,
  clearBlock,
  listHolders,
  reassignHolder,
  removePassFromUser,
  runAttachHookA,
  unassignHolder,
} from './service.ts';

let kit: Kit;
beforeAll(async () => {
  kit = await setupKit();
});

const admin = { type: 'user', id: 'admin-1' } as const;
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

  it('stays waiting when two accounts verified the address', async () => {
    const e = email();
    await makeUser(kit.fx, { primaryEmail: e });
    const other = await makeUser(kit.fx, { verified: false });
    await run(
      kit.env.DB,
      `INSERT INTO auth_identities (provider, subject, user_id, email_claim, email_verified, created_at)
       VALUES ('oidc', ?, ?, ?, 1, 1)`,
      [`sub-${other.id}`, other.id, e],
    );
    const pass = await kit.pass({ holderEmail: e });
    expect(await owner(pass.id)).toBeNull();
  });

  it('does nothing for a pass without an email', async () => {
    const pass = await kit.pass();
    expect(await runAttachHookA(kit.ctx, pass.id)).toBe(false);
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
    const [a, b, blocked, taken] = await Promise.all([
      kit.pass({ holderEmail: e }),
      kit.pass({ holderEmail: e }),
      kit.pass({ holderEmail: e }),
      kit.pass({ holderEmail: e }),
    ]);
    const rival = await makeUser(kit.fx);
    await run(kit.env.DB, 'UPDATE passes SET owner_user_id = ? WHERE id = ?', [
      rival.id,
      taken?.id,
    ]);
    const user = await makeUser(kit.fx, { primaryEmail: e });
    await run(
      kit.env.DB,
      'INSERT INTO pass_attach_blocks (pass_id, user_id, created_at) VALUES (?, ?, 1)',
      [blocked?.id, user.id],
    );
    // Hook A ran at creation, before the user existed; the user now verifies.
    const attached = await attachWaitingPassesForEmail(kit.ctx, user.id, e.toUpperCase());
    expect(attached).toBe(2);
    expect(await owner(a?.id ?? '')).toBe(user.id);
    expect(await owner(b?.id ?? '')).toBe(user.id);
    expect(await owner(blocked?.id ?? '')).toBeNull();
    expect(await owner(taken?.id ?? '')).toBe(rival.id);
  });

  it('does not take the caller’s word that an address is verified', async () => {
    const e = email();
    const pass = await kit.pass({ holderEmail: e });
    const stranger = await makeUser(kit.fx);
    expect(await attachWaitingPassesForEmail(kit.ctx, stranger.id, e)).toBe(0);
    expect(await owner(pass.id)).toBeNull();
  });

  it('ignores addresses that are not valid emails', async () => {
    const user = await makeUser(kit.fx);
    expect(await attachWaitingPassesForEmail(kit.ctx, user.id, 'a@b.com, c@d.com')).toBe(0);
  });
});

describe('removal and blocks', () => {
  it('removing writes a block, clears the owner and keeps the email', async () => {
    const e = email();
    const user = await makeUser(kit.fx, { primaryEmail: e });
    const pass = await kit.pass({ holderEmail: e });
    await removePassFromUser(kit.ctx, pass.id, user.id);
    const after = await getPass(kit.env.DB, pass.id);
    expect(after?.ownerUserId).toBeNull();
    expect(after?.holderEmail).toBe(e);
    // A later verification must not re-attach.
    expect(await attachWaitingPassesForEmail(kit.ctx, user.id, e)).toBe(0);
    expect(await runAttachHookA(kit.ctx, pass.id)).toBe(false);
  });

  it('is a no-op for someone who does not own the pass', async () => {
    const pass = await kit.pass();
    const stranger = await makeUser(kit.fx);
    await removePassFromUser(kit.ctx, pass.id, stranger.id);
    const block = await first(kit.env.DB, 'SELECT 1 FROM pass_attach_blocks WHERE pass_id = ?', [
      pass.id,
    ]);
    expect(block).toBeNull();
  });

  it('clearing a block lets the user attach again', async () => {
    const e = email();
    const user = await makeUser(kit.fx, { primaryEmail: e });
    const pass = await kit.pass({ holderEmail: e });
    await removePassFromUser(kit.ctx, pass.id, user.id);
    await clearBlock(kit.ctx, admin, { passId: pass.id, userId: user.id }, null);
    expect(await owner(pass.id)).toBe(user.id);
    await expect(
      clearBlock(kit.ctx, admin, { passId: pass.id, userId: user.id }, null),
    ).rejects.toMatchObject({ code: 'BLOCK_NOT_FOUND' });
  });
});

describe('admin assign, reassign, unassign', () => {
  it('assign sets the email and attaches; an owned pass needs reassign', async () => {
    const e = email();
    const user = await makeUser(kit.fx, { primaryEmail: e });
    const pass = await kit.pass();
    const holder = await assignHolder(
      kit.ctx,
      admin,
      { passId: pass.id, email: ` ${e.toUpperCase()} ` },
      null,
    );
    expect(holder).toMatchObject({ state: 'owned', email: e, ownerUserId: user.id });
    await expect(
      assignHolder(kit.ctx, admin, { passId: pass.id, email: email() }, null),
    ).rejects.toMatchObject({ code: 'HOLDER_OWNED' });
    // Case-only repeat is idempotent.
    expect((await assignHolder(kit.ctx, admin, { passId: pass.id, email: e }, null)).state).toBe(
      'owned',
    );
  });

  it('rejects invalid addresses', async () => {
    const pass = await kit.pass();
    await expect(
      assignHolder(kit.ctx, admin, { passId: pass.id, email: 'nope' }, null),
    ).rejects.toMatchObject({ code: 'EMAIL_INVALID' });
  });

  it('reassign clears the owner, sets the new email, runs hook A and is audited', async () => {
    const oldEmail = email();
    const newEmail = email();
    const oldUser = await makeUser(kit.fx, { primaryEmail: oldEmail });
    const newUser = await makeUser(kit.fx, { primaryEmail: newEmail });
    const pass = await kit.pass({ holderEmail: oldEmail });
    expect(await owner(pass.id)).toBe(oldUser.id);
    const holder = await reassignHolder(kit.ctx, admin, { passId: pass.id, email: newEmail }, null);
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
      await reassignHolder(kit.ctx, admin, { passId: pass.id, email: null }, null),
    ).toMatchObject({
      state: 'unassigned',
    });
    await assignHolder(kit.ctx, admin, { passId: pass.id, email: e }, null);
    expect(await unassignHolder(kit.ctx, admin, pass.id, null)).toMatchObject({
      state: 'unassigned',
      email: null,
    });
  });

  it('an org-scoped caller cannot touch another organization’s pass', async () => {
    const pass = await kit.pass();
    await expect(
      assignHolder(kit.ctx, admin, { passId: pass.id, email: email() }, 'some-other-org'),
    ).rejects.toMatchObject({ status: 404 });
  });
});

describe('list', () => {
  it('filters by state and email and includes blocks', async () => {
    const e = email();
    const user = await makeUser(kit.fx, { primaryEmail: e });
    const pass = await kit.pass({ holderEmail: e });
    await removePassFromUser(kit.ctx, pass.id, user.id);
    const waiting = await listHolders(kit.ctx, {
      orgId: kit.org.id,
      state: 'waiting',
      email: e,
      limit: 10,
    });
    expect(waiting.items).toHaveLength(1);
    expect(waiting.items[0]).toMatchObject({ passId: pass.id, blockedUserIds: [user.id] });
    const owned = await listHolders(kit.ctx, {
      orgId: kit.org.id,
      state: 'owned',
      email: e,
      limit: 10,
    });
    expect(owned.items).toHaveLength(0);
    expect((await listHolders(kit.ctx, { email: 'not an email', limit: 10 })).items).toEqual([]);
  });
});
