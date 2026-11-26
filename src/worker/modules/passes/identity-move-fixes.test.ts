import { beforeAll, describe, expect, it, vi } from 'vitest';
import { IDENTITY_MOVE_COPY } from '../../../shared/copy/identity-move.ts';
import { all, first, run } from '../../platform/db.ts';
import { hasVersionFrom } from '../broadcasts/repo-items.ts';
import type { BroadcastKit } from '../broadcasts/test-kit.ts';
import { jobCtxOf } from '../delivery/delivery-test-fixtures.ts';
import { armOnRegister, CLAIM_MS, sweepIdentityMoves, voidDue } from './identity-move.ts';
import { threeWay } from './identity-move-carry.ts';
import { SECOND_ID } from './identity-move-resolver-test-fixtures.ts';
import { runIdentityMove } from './identity-move-run.ts';
import { startIdentityMove } from './identity-move-start.ts';
import {
  ADMIN,
  DAY,
  HOUR,
  moveKit,
  moveOf,
  orgWithPasses,
  passOf,
  replacement,
  startAndRun,
} from './identity-move-test-fixtures.ts';
import { removePass } from './remove.ts';
import { candidates, countCandidates } from './repo-identity-move-candidates.ts';
import { updatePass, voidPass } from './service.ts';
import { releaseStamps, stampCard, stampVersion } from './stamps-test-fixtures.ts';

const claims = vi.hoisted(() => [] as number[]);

vi.mock('../identities/resolver.ts', async (importOriginal) => {
  const original = await importOriginal<typeof import('../identities/resolver.ts')>();
  const { wrapResolver } = await import('./identity-move-resolver-test-fixtures.ts');
  return {
    ...original,
    createIdentityResolver: (...a: Parameters<typeof original.createIdentityResolver>) =>
      wrapResolver(original.createIdentityResolver(...a)),
  };
});

// Passes every claim through and records how long it holds the void.
vi.mock('./repo-identity-move-timers.ts', async (importOriginal) => {
  const original = await importOriginal<typeof import('./repo-identity-move-timers.ts')>();
  return {
    ...original,
    claimVoid: (db: D1Database, id: string, now: number, until: number) => {
      claims.push(until - now);
      return original.claimVoid(db, id, now, until);
    },
  };
});

let kit: BroadcastKit;
beforeAll(async () => {
  kit = await moveKit();
});

const ctx = () => jobCtxOf(kit);
const sweep = () => sweepIdentityMoves(ctx());
const admin = { type: 'user', id: 'admin-1' } as const;
const token = (c: string) => c.repeat(64);

/** One moved pass whose old copy sits on `dev-1` and `dev-2`. */
async function moved(org?: { id: string }, email = true) {
  const made = org
    ? { org, passes: [await kit.makePass({ orgId: org.id })] }
    : await orgWithPasses(kit, 1, email);
  const old = made.passes[0] as (typeof made.passes)[0] & { id: string };
  await startAndRun(kit, made.org.id);
  const next = await replacement(kit, old);
  await kit.device(old, 'dev-1', token('o'));
  await kit.device(old, 'dev-2', token('p'));
  return { org: made.org, old, next };
}
const addNew = async (next: Awaited<ReturnType<typeof replacement>>, device = 'dev-1') => {
  await kit.device(next, device, token('a'));
  await armOnRegister(ctx(), next.id);
};
const stateOf = async (oldId: string) => {
  const row = await moveOf(kit, oldId);
  return [row.state, row.reason];
};

describe('H2: revoking the old pass revokes the replacement', () => {
  it('voids the replacement and sends no reminder when the old pass is voided before the add', async () => {
    const { org, old, next } = await moved();
    await voidPass(ctx(), admin, old.id, org.id);
    const before = kit.mailer.sent.length;
    advance(31 * DAY);
    await sweep();
    expect((await passOf(kit, next.id)).status).toBe('voided');
    expect(await stateOf(old.id)).toEqual(['kept', 'old_revoked']);
    await sweep();
    expect(kit.mailer.sent.length).toBe(before);
  });

  it('voids the replacement when the old pass is voided inside the 24 hours', async () => {
    const { org, old, next } = await moved();
    await addNew(next);
    advance(2 * HOUR);
    await voidPass(ctx(), admin, old.id, org.id);
    advance(DAY);
    await sweep();
    expect((await passOf(kit, next.id)).status).toBe('voided');
    expect(await stateOf(old.id)).toEqual(['kept', 'old_revoked']);
  });

  it('voids the replacement when the old pass is removed', async () => {
    const { org, old, next } = await moved();
    await removePass(ctx(), admin, old.id, {}, org.id);
    await sweep();
    expect((await passOf(kit, next.id)).status).toBe('voided');
    expect(await stateOf(old.id)).toEqual(['kept', 'old_revoked']);
  });

  it('does it in the same step when the timer finds the old pass revoked', async () => {
    const { org, old, next } = await moved();
    await addNew(next);
    advance(DAY);
    await voidPass(ctx(), admin, old.id, org.id);
    expect(await voidDue(ctx(), await moveOf(kit, old.id))).toBe('kept');
    expect((await passOf(kit, next.id)).status).toBe('voided');
    expect(await stateOf(old.id)).toEqual(['kept', 'old_revoked']);
  });

  it('does not treat its own void as a revocation, even after a crash before the row closed', async () => {
    const { old, next } = await moved();
    await addNew(next);
    advance(DAY);
    await sweep();
    expect((await passOf(kit, old.id)).status).toBe('voided');
    await run(kit.env.DB, "UPDATE pass_moves SET state = 'registered' WHERE old_pass_id = ?", [
      old.id,
    ]);
    await sweep();
    expect((await passOf(kit, next.id)).status).toBe('active');
    expect((await moveOf(kit, old.id)).state).toBe('voided');
  });
});

const advance = (ms: number) => kit.clock.advance(ms);

describe('M1: edits carry as a three-way diff', () => {
  const base = { a: 'a', b: 'b', c: 'c' };
  const merge = (v: Partial<Parameters<typeof threeWay>[0]>) =>
    threeWay({
      base,
      madeBase: base,
      old: base,
      oldMapped: base,
      made: base,
      oldNewer: false,
      ...v,
    });

  it('applies only what the old pass changed, and keeps what the replacement changed', () => {
    const old = { a: 'A', b: 'b', c: 'c' };
    const made = { a: 'a', b: 'B', c: 'c' };
    expect(merge({ old, oldMapped: old, made })).toEqual({
      next: { a: 'A', b: 'B', c: 'c' },
      conflicts: [],
    });
  });

  it('takes a deletion, and writes the mapped value of a changed field', () => {
    const old = { a: 'a', c: 'c' };
    expect(merge({ old, oldMapped: old }).next).toEqual({ a: 'a', c: 'c' });
    expect(merge({ old: { ...base, a: 5 }, oldMapped: { ...base, a: 7 } }).next.a).toBe(7);
  });

  it('on a field both changed, the newer write wins and the field is reported', () => {
    const old = { ...base, a: 'old' };
    const made = { ...base, a: 'new' };
    expect(merge({ old, oldMapped: old, made, oldNewer: false })).toEqual({
      next: made,
      conflicts: [{ field: 'a', winner: 'replacement' }],
    });
    expect(merge({ old, oldMapped: old, made, oldNewer: true })).toEqual({
      next: old,
      conflicts: [{ field: 'a', winner: 'old' }],
    });
    // The same value on both sides is no conflict.
    expect(merge({ old, oldMapped: old, made: old }).conflicts).toEqual([]);
  });

  it('keeps an edit made on the replacement and records the conflict on the move row', async () => {
    const { org, old, next } = await moved();
    await updatePass(
      ctx(),
      admin,
      old.id,
      { input: { memberName: 'Old side', gate: 'G1' } },
      { scope: org.id },
    );
    advance(HOUR);
    await updatePass(
      ctx(),
      admin,
      next.id,
      { input: { memberName: 'Corrected on new' } },
      { scope: org.id },
    );
    await addNew(next);
    advance(DAY);
    await sweep();
    expect((await passOf(kit, old.id)).status).toBe('voided');
    const made = await passOf(kit, next.id);
    expect(made.personalization.memberName).toBe('Corrected on new');
    // The field only the old pass changed came across.
    expect(made.personalization.gate).toBe('G1');
    const row = await moveOf(kit, old.id);
    expect(JSON.parse(row.conflicts ?? '[]')).toEqual([
      { field: 'memberName', winner: 'replacement' },
    ]);
  });

  it('lets a newer edit on the old pass win a field both changed', async () => {
    const { org, old, next } = await moved();
    await updatePass(ctx(), admin, next.id, { input: { memberName: 'On new' } }, { scope: org.id });
    advance(HOUR);
    await updatePass(
      ctx(),
      admin,
      old.id,
      { input: { memberName: 'Old, later' } },
      { scope: org.id },
    );
    await addNew(next);
    advance(DAY);
    await sweep();
    expect((await passOf(kit, next.id)).personalization.memberName).toBe('Old, later');
    expect(JSON.parse((await moveOf(kit, old.id)).conflicts ?? '[]')).toEqual([
      { field: 'memberName', winner: 'old' },
    ]);
  });

  it('runs a carried stamp count through the stamp plan of the new version', async () => {
    const k = await moveKit();
    await stampVersion(k, 'tpl-move-stamps', 'v1', 10);
    const v1 = await releaseStamps(k, 'tpl-move-stamps', 'v1');
    const card = await stampCard(k, v1, 8);
    await stampVersion(k, 'tpl-move-stamps', 'v2', 12, { keepReady: true });
    await releaseStamps(k, 'tpl-move-stamps', 'v2');
    await startAndRun(k, k.org.id);
    const next = await replacement(k, card);
    expect(next.templateVersion).toBe('v2');
    // The card fills up on the old pass: the v2 card keeps its reward ready and tops up to 12.
    await updatePass(jobCtxOf(k), admin, card.id, { input: { stamps: 10 } }, { scope: k.org.id });
    await k.device(await passOf(k, card.id), 'dev-1', token('o'));
    await k.device(next, 'dev-1', token('a'));
    await armOnRegister(jobCtxOf(k), next.id);
    k.clock.advance(DAY);
    await sweepIdentityMoves(jobCtxOf(k));
    expect((await passOf(k, card.id)).status).toBe('voided');
    expect((await passOf(k, next.id)).personalization.stamps).toBe(12);
  });
});

describe('M3: only a device that holds the old pass arms the void', () => {
  it('leaves the timer alone for another device, and the reminder flow continues', async () => {
    const { old, next } = await moved();
    await addNew(next, 'dev-other');
    await sweep();
    expect(await stateOf(old.id)).toEqual(['notified', null]);
    advance(DAY);
    await sweep();
    expect((await passOf(kit, old.id)).status).toBe('active');
    advance(30 * DAY);
    await sweep();
    expect(await stateOf(old.id)).toEqual(['kept', 'reminded']);
  });

  it('arms on a device that holds the old pass, and keeps counting after the old pass leaves it', async () => {
    const { old, next } = await moved();
    await addNew(next, 'dev-other');
    await addNew(next, 'dev-2');
    expect((await moveOf(kit, old.id)).armed_device).toBe('dev-2');
    advance(HOUR);
    await run(kit.env.DB, 'DELETE FROM registrations WHERE pass_id = ?', [old.id]);
    advance(DAY);
    await sweep();
    expect((await passOf(kit, old.id)).status).toBe('voided');
  });

  it('does not let the sweep arm a registration on a device without the old pass', async () => {
    const { old, next } = await moved();
    await kit.device(next, 'dev-other', token('a'));
    await sweep();
    expect((await moveOf(kit, old.id)).state).toBe('notified');
    await kit.device(next, 'dev-1', token('b'));
    await sweep();
    expect((await moveOf(kit, old.id)).state).toBe('registered');
  });
});

describe('the rest of R-B', () => {
  it('L1: the reminder asks to add the pass, without a promise the move does not keep', async () => {
    const { old } = await moved();
    advance(30 * DAY);
    await sweep();
    const mail = kit.mailer.sent.filter((m) => m.to === old.holderEmail);
    expect(mail).toHaveLength(1);
    expect(mail[0]?.subject).toBe('Add your new pass');
    expect(mail[0]?.subject).not.toMatch(/your new your/);
    expect(mail[0]?.text).not.toContain('stop updating');
    expect(IDENTITY_MOVE_COPY.reminderBody(null, 'https://x/p/1')).toBe(
      'Your new pass is ready. Add it: https://x/p/1',
    );
  });

  it('L2: the move writes its own source, which a broadcast never counts', async () => {
    const { old, next } = await moved();
    await updatePass(ctx(), admin, old.id, { input: { gate: 'G9' } }, { scope: old.orgId });
    await addNew(next);
    advance(DAY);
    await sweep();
    const sources = (
      await all<{ source: string | null }>(
        kit.env.DB,
        'SELECT source FROM pass_versions WHERE pass_id IN (?, ?)',
        [old.id, next.id],
      )
    ).map((r) => r.source ?? '');
    expect(sources.some((s) => s.startsWith('move:tell:'))).toBe(true);
    expect(sources.some((s) => s.startsWith('move:carry:'))).toBe(true);
    expect(sources.some((s) => s.startsWith('move:void:'))).toBe(true);
    expect(await hasVersionFrom(kit.env.DB, old.id, 'broadcast', 0)).toBe(false);
    expect(await hasVersionFrom(kit.env.DB, next.id, 'broadcast', 0)).toBe(false);
  });

  it('L3: the planned rows of a cancelled move are deleted, so a later move takes those passes', async () => {
    const { org, passes } = await orgWithPasses(kit, 3);
    const op = await startIdentityMove(ctx(), ADMIN, {
      orgId: org.id,
      fromIdentityId: 'platform',
      toIdentityId: SECOND_ID,
    });
    await runIdentityMove(ctx(), op, 'l', { budgetMs: -1 });
    expect(
      await all(kit.env.DB, "SELECT 1 FROM pass_moves WHERE op_id = ? AND state = 'planned'", [
        op.id,
      ]),
    ).toHaveLength(3);
    await run(kit.env.DB, 'UPDATE operations SET cancel_requested = 1 WHERE id = ?', [op.id]);
    await runIdentityMove(ctx(), op, 'l').catch(() => undefined);
    expect(await all(kit.env.DB, 'SELECT 1 FROM pass_moves WHERE op_id = ?', [op.id])).toHaveLength(
      0,
    );
    const free = await candidates(kit.env.DB, {
      orgId: org.id,
      identityId: 'platform',
      after: '',
      limit: 10,
    });
    expect(free.map((c) => c.id).sort()).toEqual(passes.map((p) => p.id).sort());
  });

  it('L4: the dry run counts what stays on the old identity, by reason', async () => {
    const { org, passes } = await orgWithPasses(kit, 3);
    await run(
      kit.env.DB,
      "INSERT INTO connections (id, org_id, connector_type, name, created_at, updated_at) VALUES ('c-l4', ?, 'x', 'c', 1, 1)",
      [org.id],
    );
    await run(
      kit.env.DB,
      "UPDATE passes SET connection_id = 'c-l4', external_ref = 'r' WHERE id = ?",
      [(passes[0] as { id: string }).id],
    );
    expect(await countCandidates(kit.env.DB, org.id, 'platform')).toMatchObject({
      passes: 2,
      holders: 2,
      kept: { connection: 1 },
    });
    // The plan keeps the same pass for the same reason.
    const planned = await candidates(kit.env.DB, {
      orgId: org.id,
      identityId: 'platform',
      after: '',
      limit: 10,
    });
    expect(planned.filter((c) => c.reason !== null)).toEqual([
      { id: (passes[0] as { id: string }).id, reason: 'connection' },
    ]);
  });

  it('L5: a void holds its claim for minutes, not a minute', async () => {
    const { old, next } = await moved();
    await addNew(next);
    advance(DAY);
    claims.length = 0;
    await sweep();
    expect((await passOf(kit, old.id)).status).toBe('voided');
    expect(CLAIM_MS).toBeGreaterThanOrEqual(5 * 60_000);
    expect(claims).toEqual([CLAIM_MS]);
  });
});

describe('probes of R-B that stay closed', () => {
  it('the replacement stays active when nobody revoked the old pass', async () => {
    const { old, next } = await moved();
    await addNew(next);
    advance(DAY);
    await sweep();
    expect((await passOf(kit, next.id)).status).toBe('active');
    expect(
      await first(
        kit.env.DB,
        "SELECT 1 FROM pass_moves WHERE old_pass_id = ? AND state = 'voided'",
        [old.id],
      ),
    ).not.toBeNull();
  });
});
