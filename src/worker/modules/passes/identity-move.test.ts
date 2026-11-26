import { beforeAll, describe, expect, it, vi } from 'vitest';
import type { BroadcastKit } from '../broadcasts/test-kit.ts';
import { jobCtxOf } from '../delivery/delivery-test-fixtures.ts';
import { PLATFORM_IDENTITY_ID } from '../identities/resolver.ts';
import { armOnRegister, remindDue, sweepIdentityMoves, voidDue } from './identity-move.ts';
import { SECOND_ID } from './identity-move-resolver-test-fixtures.ts';
import {
  count,
  DAY,
  HOUR,
  moveKit,
  moveOf,
  opRow,
  orgWithPasses,
  passOf,
  replacement,
  startAndRun,
  unregister,
} from './identity-move-test-fixtures.ts';
import { removePass } from './remove.ts';
import { moveById } from './repo-identity-move.ts';
import { updatePass, voidPass } from './service.ts';

vi.mock('../identities/resolver.ts', async (importOriginal) => {
  const original = await importOriginal<typeof import('../identities/resolver.ts')>();
  const { wrapResolver } = await import('./identity-move-resolver-test-fixtures.ts');
  return {
    ...original,
    createIdentityResolver: (...a: Parameters<typeof original.createIdentityResolver>) =>
      wrapResolver(original.createIdentityResolver(...a)),
  };
});

let kit: BroadcastKit;
beforeAll(async () => {
  kit = await moveKit();
});

const sweep = () => sweepIdentityMoves(jobCtxOf(kit));
const advance = (ms: number) => kit.clock.advance(ms);

/**
 * One org, one emailed pass, moved: the replacement exists and the old pass was told. The old pass sits on two
 * devices, `dev-1` and `dev-2`: only an add of the replacement on one of those starts its 24 hours.
 */
async function moved() {
  const { org, passes } = await orgWithPasses(kit, 1);
  const old = passes[0] as NonNullable<(typeof passes)[0]>;
  const op = await startAndRun(kit, org.id);
  const next = await replacement(kit, old);
  await kit.device(old, 'dev-1', 'o'.repeat(64));
  await kit.device(old, 'dev-2', 'p'.repeat(64));
  return { org, old, next, op };
}

describe('the replacement', () => {
  it('is made under the new identity, emailed, and the old pass is told', async () => {
    const { old, next, op } = await moved();
    expect((await opRow(kit, op.id)).status).toBe('succeeded');
    expect(next.identityId).toBe(SECOND_ID);
    expect(next.holderEmail).toBe(old.holderEmail);
    expect(next.personalization.memberName).toBe(old.personalization.memberName);
    expect(next.serial).not.toBe(old.serial);
    expect(
      await count(
        kit,
        "SELECT count(*) AS n FROM outbox WHERE kind = 'email' AND pass_id = ?",
        next.id,
      ),
    ).toBe(1);
    const told = await passOf(kit, old.id);
    expect(told.status).toBe('active');
    expect(String(told.personalization.message)).toContain('/p/');
    const move = await moveOf(kit, old.id);
    expect(move.state).toBe('notified');
    expect(move.remind_at).toBe(move.created_at + 30 * DAY);
  });

  it('voids nothing before the new pass registers', async () => {
    const { old } = await moved();
    for (const step of [HOUR, DAY, 5 * DAY]) {
      advance(step);
      await sweep();
      expect((await passOf(kit, old.id)).status).toBe('active');
    }
  });
});

describe('the void', () => {
  it('comes 24 hours after the replacement registers, not before', async () => {
    const { old, next } = await moved();
    await kit.device(next, 'dev-1', 'a'.repeat(64));
    await armOnRegister(jobCtxOf(kit), next.id);
    const armed = await moveOf(kit, old.id);
    expect(armed.state).toBe('registered');
    expect(armed.void_at).toBe((armed.registered_at as number) + DAY);
    advance(DAY - 1);
    await sweep();
    expect((await passOf(kit, old.id)).status).toBe('active');
    advance(1);
    await sweep();
    expect((await passOf(kit, old.id)).status).toBe('voided');
    expect((await moveOf(kit, old.id)).state).toBe('voided');
    expect((await passOf(kit, next.id)).status).toBe('active');
  });

  it('is armed by the sweep when the register hook was missed', async () => {
    const { old, next } = await moved();
    await kit.device(next, 'dev-1', 'a'.repeat(64));
    expect((await moveOf(kit, old.id)).state).toBe('notified');
    await sweep();
    expect((await moveOf(kit, old.id)).state).toBe('registered');
    advance(DAY);
    await sweep();
    expect((await passOf(kit, old.id)).status).toBe('voided');
  });

  it('does not void when the only device unregistered before the timer', async () => {
    const { old, next } = await moved();
    await kit.device(next, 'dev-1', 'a'.repeat(64));
    await armOnRegister(jobCtxOf(kit), next.id);
    advance(10 * HOUR);
    await unregister(kit, next.id, 'dev-1');
    advance(14 * HOUR);
    await sweep();
    expect((await passOf(kit, old.id)).status).toBe('active');
    const disarmed = await moveOf(kit, old.id);
    expect(disarmed.state).toBe('notified');
    expect(disarmed.void_at).toBeNull();
    // A later registration starts a fresh 24 hours.
    await kit.device(next, 'dev-2', 'b'.repeat(64));
    await armOnRegister(jobCtxOf(kit), next.id);
    advance(DAY - 1);
    await sweep();
    expect((await passOf(kit, old.id)).status).toBe('active');
    advance(1);
    await sweep();
    expect((await passOf(kit, old.id)).status).toBe('voided');
  });

  it('is one void when two sweeps race the same row', async () => {
    const { old, next } = await moved();
    await kit.device(next, 'dev-1', 'a'.repeat(64));
    await armOnRegister(jobCtxOf(kit), next.id);
    advance(DAY);
    const row = await moveOf(kit, old.id);
    const results = await Promise.all([voidDue(jobCtxOf(kit), row), voidDue(jobCtxOf(kit), row)]);
    expect(results.filter((r) => r === 'voided')).toHaveLength(1);
    expect(
      await count(
        kit,
        "SELECT count(*) AS n FROM audit_log WHERE action = 'pass.void' AND target_id = ?",
        old.id,
      ),
    ).toBe(1);
  });

  it('does not void when the replacement was voided or removed first', async () => {
    const { org, old, next } = await moved();
    await kit.device(next, 'dev-1', 'a'.repeat(64));
    await armOnRegister(jobCtxOf(kit), next.id);
    await voidPass(jobCtxOf(kit), { type: 'user', id: 'admin-1' }, next.id, org.id);
    advance(DAY);
    await sweep();
    expect((await passOf(kit, old.id)).status).toBe('active');
    const row = await moveOf(kit, old.id);
    expect([row.state, row.reason]).toEqual(['kept', 'new_gone']);
    await removePass(jobCtxOf(kit), { type: 'user', id: 'admin-1' }, next.id, {}, org.id);
  });

  it('waits while the org is suspended and voids when it is active again', async () => {
    const { org, old, next } = await moved();
    await kit.device(next, 'dev-1', 'a'.repeat(64));
    await armOnRegister(jobCtxOf(kit), next.id);
    advance(DAY);
    await kit.env.DB.prepare("UPDATE orgs SET status = 'suspended' WHERE id = ?")
      .bind(org.id)
      .run();
    await sweep();
    expect((await passOf(kit, old.id)).status).toBe('active');
    expect((await moveOf(kit, old.id)).state).toBe('registered');
    await kit.env.DB.prepare("UPDATE orgs SET status = 'active' WHERE id = ?").bind(org.id).run();
    await sweep();
    expect((await passOf(kit, old.id)).status).toBe('voided');
  });

  it('is claimed once: a crashed claim lapses and the next sweep finishes it', async () => {
    const { old, next } = await moved();
    await kit.device(next, 'dev-1', 'a'.repeat(64));
    await armOnRegister(jobCtxOf(kit), next.id);
    advance(DAY);
    await kit.env.DB.prepare('UPDATE pass_moves SET claim_until = ? WHERE old_pass_id = ?')
      .bind(kit.clock.now() + 60_000, old.id)
      .run();
    await sweep();
    expect((await passOf(kit, old.id)).status).toBe('active');
    advance(61_000);
    await sweep();
    expect((await passOf(kit, old.id)).status).toBe('voided');
  });

  it('with several devices: voids 24 hours after the first, and waits when that device left', async () => {
    const { old, next } = await moved();
    await kit.device(next, 'dev-1', 'a'.repeat(64));
    await armOnRegister(jobCtxOf(kit), next.id);
    advance(10 * HOUR);
    await kit.device(next, 'dev-2', 'b'.repeat(64));
    await armOnRegister(jobCtxOf(kit), next.id);
    // The second registration never moves the timer.
    expect((await moveOf(kit, old.id)).void_at).toBe(
      (await moveOf(kit, old.id)).registered_at! + DAY,
    );
    advance(5 * HOUR);
    await unregister(kit, next.id, 'dev-1');
    advance(9 * HOUR);
    // 24 hours since the first registration, but only the second device is left and it is 14 hours old.
    await sweep();
    expect((await passOf(kit, old.id)).status).toBe('active');
    expect((await moveOf(kit, old.id)).state).toBe('registered');
    advance(10 * HOUR);
    await sweep();
    expect((await passOf(kit, old.id)).status).toBe('voided');
  });

  it('carries an edit made to the old pass after the copy, then voids', async () => {
    const { org, old, next } = await moved();
    await updatePass(
      jobCtxOf(kit),
      { type: 'user', id: 'admin-1' },
      old.id,
      { input: { memberName: 'Renamed' } },
      { scope: org.id },
    );
    await kit.device(next, 'dev-1', 'a'.repeat(64));
    await armOnRegister(jobCtxOf(kit), next.id);
    advance(DAY);
    await sweep();
    expect((await passOf(kit, old.id)).status).toBe('voided');
    expect((await passOf(kit, next.id)).personalization.memberName).toBe('Renamed');
  });
});

describe('the reminder', () => {
  it('goes once at 30 days when the replacement never registered, and the old pass stays', async () => {
    const { old, next } = await moved();
    advance(30 * DAY - 1);
    await sweep();
    expect(kit.mailer.sent.filter((m) => m.to === old.holderEmail)).toHaveLength(0);
    advance(1);
    await sweep();
    await sweep();
    const mail = kit.mailer.sent.filter((m) => m.to === old.holderEmail);
    expect(mail).toHaveLength(1);
    expect(mail[0]?.text).toContain('/p/');
    expect((await passOf(kit, old.id)).status).toBe('active');
    const row = await moveOf(kit, old.id);
    expect([row.state, row.reason]).toEqual(['kept', 'reminded']);
    // Adding the new pass late still starts the 24 hours.
    await kit.device(next, 'dev-1', 'a'.repeat(64));
    await armOnRegister(jobCtxOf(kit), next.id);
    expect((await moveOf(kit, old.id)).state).toBe('registered');
    advance(DAY);
    await sweep();
    expect((await passOf(kit, old.id)).status).toBe('voided');
  });

  it('is not sent to a holder who registered in time', async () => {
    const { old, next } = await moved();
    const before = kit.mailer.sent.length;
    await kit.device(next, 'dev-1', 'a'.repeat(64));
    await armOnRegister(jobCtxOf(kit), next.id);
    advance(31 * DAY);
    await sweep();
    expect(kit.mailer.sent.length).toBe(before);
    expect((await moveOf(kit, old.id)).state).toBe('voided');
  });

  it('tries again the next day when the mail failed, without sending twice', async () => {
    const { old } = await moved();
    advance(30 * DAY);
    kit.mailer.fail = new Error('provider down');
    await sweep();
    kit.mailer.fail = null;
    expect((await moveOf(kit, old.id)).state).toBe('notified');
    await sweep();
    expect(kit.mailer.sent.filter((m) => m.to === old.holderEmail)).toHaveLength(0);
    advance(DAY);
    await sweep();
    expect(kit.mailer.sent.filter((m) => m.to === old.holderEmail)).toHaveLength(1);
    expect(
      await remindDue(jobCtxOf(kit), (await moveById(kit.env.DB, (await moveOf(kit, old.id)).id))!),
    ).toBe('skipped');
    expect(kit.mailer.sent.filter((m) => m.to === old.holderEmail)).toHaveLength(1);
  });

  it('is never sent for a pass with no holder email', async () => {
    const { org, passes } = await orgWithPasses(kit, 1, false);
    await startAndRun(kit, org.id);
    advance(31 * DAY);
    const before = kit.mailer.sent.length;
    await sweep();
    expect(kit.mailer.sent.length).toBe(before);
    expect((await moveOf(kit, (passes[0] as { id: string }).id)).state).toBe('kept');
  });
});

describe('identities', () => {
  it('is the platform default that a move leaves behind', () => {
    expect(PLATFORM_IDENTITY_ID).toBe('platform');
  });
});
