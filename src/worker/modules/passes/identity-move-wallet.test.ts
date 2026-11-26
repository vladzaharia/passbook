import { beforeAll, describe, expect, it, vi } from 'vitest';
import { all, first, run } from '../../platform/db.ts';
import type { BroadcastKit } from '../broadcasts/test-kit.ts';
import { jobCtxOf } from '../delivery/delivery-test-fixtures.ts';
import { armOnRegister } from './identity-move.ts';
import { sweepIdentityMoves } from './identity-move-sweep.ts';
import {
  DAY,
  HOUR,
  moveKit,
  moveOf,
  orgWithPasses,
  passOf,
  replacement,
  startAndRun,
} from './identity-move-test-fixtures.ts';
import { listMoves } from './repo-identity-move-list.ts';
import { voidPass } from './service.ts';

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

const ctx = () => jobCtxOf(kit);
const db = () => kit.env.DB;
const sweep = () => sweepIdentityMoves(ctx());
type Old = Awaited<ReturnType<typeof passOf>>;
type Provider = 'google' | 'samsung';

/** A live provider copy of the pass; only its row matters to the move. */
async function seedCopy(p: Old, provider: Provider, lifecycle = 'active'): Promise<string> {
  const id = kit.fx.ids.id();
  await run(db(), 'PRAGMA ignore_check_constraints = ON');
  await run(db(), 'DROP TRIGGER IF EXISTS wallet_provider_generation_insert_guard');
  await run(db(), 'PRAGMA defer_foreign_keys = ON');
  await run(
    db(),
    `INSERT INTO wallet_provider_instances (id, pass_id, org_id, mode, provider, credential_generation, lifecycle,
       desired_version, created_at, updated_at) VALUES (?, ?, ?, 'live', ?, ?, ?, 1, 1, 1)`,
    [id, p.id, p.orgId, provider, p.credentialGeneration, lifecycle],
  );
  return id;
}

/** The provider's report that the holder saved (or removed) the pass; later reports win. */
async function report(p: Old, provider: Provider, kind: 'wallet.saved' | 'wallet.removed') {
  kit.clock.advance(1_000);
  await run(
    db(),
    `INSERT INTO pass_events (id, org_id, pass_id, mode, kind, actor_type, data, at)
     VALUES (?, ?, ?, 'live', ?, 'system', json_object('provider', ?), ?)`,
    [kit.fx.ids.id(), p.orgId, p.id, kind, provider, kit.clock.now()],
  );
}
const save = (p: Old, provider: Provider) => report(p, provider, 'wallet.saved');

/** How often the provider's drain was told the copy's pass changed: a void marks it dirty in its own batch. */
const dirtyOf = async (instanceId: string) =>
  (
    await first<{ generation: number }>(
      db(),
      'SELECT generation FROM wallet_provider_instance_dirty WHERE instance_id = ?',
      [instanceId],
    )
  )?.generation ?? 0;

/** One emailed pass with copies in `providers`, moved; the replacement exists and the old pass sits on `dev-1`. */
async function moved(providers: Provider[], apple = true) {
  const { org, passes } = await orgWithPasses(kit, 1);
  const old = passes[0] as Old;
  const copies = new Map<Provider, string>();
  for (const p of providers) copies.set(p, await seedCopy(old, p));
  await startAndRun(kit, org.id);
  const next = await replacement(kit, old);
  if (apple) await kit.device(old, 'dev-1', 'o'.repeat(64));
  return { org, old, next, copies };
}
/** The holder adds the replacement on the device that holds the old pass. */
async function addApple(next: Old) {
  await kit.device(next, 'dev-1', 'a'.repeat(64));
  await armOnRegister(ctx(), next.id);
}
/** The holder adds the replacement on the device that holds the old pass, and the 24 hours pass. */
async function completeMove(next: Old) {
  await kit.device(next, 'dev-1', 'a'.repeat(64));
  await armOnRegister(ctx(), next.id);
  kit.clock.advance(DAY);
  await sweep();
}
const stateOf = async (oldId: string) => {
  const row = await moveOf(kit, oldId);
  return [row.state, row.reason];
};

describe('a pass with a Google or Samsung copy moves', () => {
  it.each([[['google']], [['samsung']], [['google', 'samsung']]] as [Provider[]][])(
    'plans the replacement and voids the old pass with its copies: %j',
    async (providers) => {
      const { old, next, copies } = await moved(providers);
      expect(await stateOf(old.id)).toEqual(['notified', null]);
      expect((await passOf(kit, next.id)).status).toBe('active');
      const before = new Map<string, number>();
      for (const id of copies.values()) before.set(id, await dirtyOf(id));
      await completeMove(next);
      expect(await stateOf(old.id)).toEqual(['voided', null]);
      expect((await passOf(kit, old.id)).status).toBe('voided');
      expect((await passOf(kit, next.id)).status).toBe('active');
      // The provider's own void path: each copy's pass write told the drain, in the void's batch.
      for (const id of copies.values())
        expect(await dirtyOf(id)).toBeGreaterThan(before.get(id) ?? 0);
    },
  );

  it('voids the old pass with a copy nobody saved, and with one removed after it was saved', async () => {
    const { old, next } = await moved(['google', 'samsung']);
    await save(old, 'google');
    await report(old, 'google', 'wallet.removed');
    await completeMove(next);
    expect(await stateOf(old.id)).toEqual(['voided', null]);
  });

  it('ignores a saved copy that is no longer live', async () => {
    const { org, passes } = await orgWithPasses(kit, 1);
    const old = passes[0] as Old;
    await seedCopy(old, 'google', 'revoked');
    await save(old, 'google');
    await startAndRun(kit, org.id);
    await kit.device(old, 'dev-1', 'o'.repeat(64));
    await completeMove(await replacement(kit, old));
    expect(await stateOf(old.id)).toEqual(['voided', null]);
  });
});

describe('a copy a device holds is never voided', () => {
  it.each([
    [['google'], 'wallet_copy:google'],
    [['samsung'], 'wallet_copy:samsung'],
    [['google', 'samsung'], 'wallet_copy:google+samsung'],
  ] as [Provider[], string][])(
    'waits, with its reason, when %j was saved mid-move and the replacement has none; ends kept_both at the reminder deadline',
    async (providers, reason) => {
      const { old, next, copies } = await moved(providers);
      expect(await stateOf(old.id)).toEqual(['notified', null]);
      // The holder saves the old pass's copy after the replacement was issued.
      for (const p of providers) await save(old, p);
      const before = new Map<string, number>();
      for (const id of copies.values()) before.set(id, await dirtyOf(id));
      await completeMove(next);
      expect(await stateOf(old.id)).toEqual(['registered', reason]);
      expect((await passOf(kit, old.id)).status).toBe('active');
      expect((await passOf(kit, next.id)).status).toBe('active');
      // Every sweep looks again; the wait changes nothing.
      kit.clock.advance(5 * DAY);
      await sweep();
      expect(await stateOf(old.id)).toEqual(['registered', reason]);
      // At the deadline (30 days after the replacement was issued) it stays as it is, both passes live.
      kit.clock.advance(30 * DAY);
      await sweep();
      expect(await stateOf(old.id)).toEqual(['kept_both', reason]);
      expect((await passOf(kit, old.id)).status).toBe('active');
      expect((await passOf(kit, next.id)).status).toBe('active');
      for (const id of copies.values()) expect(await dirtyOf(id)).toBe(before.get(id));
      // Nothing later voids either pass, nor sends a reminder.
      const sent = kit.mailer.sent.length;
      kit.clock.advance(40 * DAY);
      await sweep();
      expect((await passOf(kit, old.id)).status).toBe('active');
      expect((await passOf(kit, next.id)).status).toBe('active');
      expect(kit.mailer.sent.length).toBe(sent);
    },
  );

  it('clears the hold when the new copy is saved, and voids on the 24 hour rule from that save', async () => {
    const { old, next, copies } = await moved(['google']);
    await save(old, 'google');
    await completeMove(next);
    expect(await stateOf(old.id)).toEqual(['registered', 'wallet_copy:google']);
    kit.clock.advance(3 * DAY);
    await sweep();
    expect((await passOf(kit, old.id)).status).toBe('active');
    const before = await dirtyOf(copies.get('google') ?? '');
    await save(next, 'google');
    await sweep();
    expect((await passOf(kit, old.id)).status).toBe('active');
    kit.clock.advance(12 * HOUR);
    await sweep();
    expect((await passOf(kit, old.id)).status).toBe('active');
    kit.clock.advance(13 * HOUR);
    await sweep();
    expect(await stateOf(old.id)).toEqual(['voided', null]);
    expect((await passOf(kit, old.id)).status).toBe('voided');
    expect((await passOf(kit, next.id)).status).toBe('active');
    expect(await dirtyOf(copies.get('google') ?? '')).toBeGreaterThan(before);
  });

  it('decides per provider: the copy the replacement already has does not hold the pass, the other one does', async () => {
    const { old, next } = await moved(['google', 'samsung']);
    await save(old, 'google');
    await save(old, 'samsung');
    await save(next, 'google');
    await completeMove(next);
    expect(await stateOf(old.id)).toEqual(['registered', 'wallet_copy:samsung']);
    expect((await passOf(kit, old.id)).status).toBe('active');
  });

  it('voids the old pass when the replacement was saved in every provider the old pass was', async () => {
    const { old, next, copies } = await moved(['google', 'samsung']);
    await save(old, 'google');
    await save(old, 'samsung');
    await save(next, 'google');
    await save(next, 'samsung');
    await completeMove(next);
    expect(await stateOf(old.id)).toEqual(['voided', null]);
    for (const id of copies.values()) expect(await dirtyOf(id)).toBeGreaterThan(0);
  });

  it('lists the row under its reason, whole or by the code before the provider', async () => {
    const { old, next } = await moved(['samsung']);
    await save(old, 'samsung');
    await completeMove(next);
    const move = await moveOf(kit, old.id);
    expect(move.state).toBe('registered');
    for (const reason of ['wallet_copy', 'wallet_copy:samsung']) {
      const rows = await listMoves(db(), { orgId: move.org_id, reason, after: '', limit: 10 });
      expect(rows.map((r) => r.id)).toEqual([move.id]);
    }
    expect(
      await listMoves(db(), { orgId: move.org_id, reason: 'wallet', after: '', limit: 10 }),
    ).toEqual([]);
  });
});

describe('a holder with no Apple registration is armed by wallet saves', () => {
  it.each([['google'], ['samsung']] as [Provider][])(
    '%s only: the replacement saved arms the void, and 24 hours later the old pass goes',
    async (provider) => {
      const { old, next, copies } = await moved([provider], false);
      await save(old, provider);
      await sweep();
      // The old copy is saved and the new one is not: nothing is armed.
      expect(await stateOf(old.id)).toEqual(['notified', null]);
      await save(next, provider);
      await sweep();
      expect(await stateOf(old.id)).toEqual(['registered', null]);
      expect((await moveOf(kit, old.id)).armed_device).toBe('wallet');
      kit.clock.advance(23 * HOUR);
      await sweep();
      expect((await passOf(kit, old.id)).status).toBe('active');
      kit.clock.advance(2 * HOUR);
      const before = await dirtyOf(copies.get(provider) ?? '');
      await sweep();
      expect(await stateOf(old.id)).toEqual(['voided', null]);
      expect((await passOf(kit, old.id)).status).toBe('voided');
      expect((await passOf(kit, next.id)).status).toBe('active');
      expect(await dirtyOf(copies.get(provider) ?? '')).toBeGreaterThan(before);
    },
  );

  it('needs the replacement saved in every provider the old pass was saved in', async () => {
    const { old, next } = await moved(['google', 'samsung'], false);
    await save(old, 'google');
    await save(old, 'samsung');
    await save(next, 'google');
    await sweep();
    expect(await stateOf(old.id)).toEqual(['notified', null]);
    await save(next, 'samsung');
    await sweep();
    expect(await stateOf(old.id)).toEqual(['registered', null]);
  });

  it('does not arm on a copy the holder never saved, or one removed again', async () => {
    const { old, next } = await moved(['google', 'samsung'], false);
    await save(old, 'google');
    await report(old, 'google', 'wallet.removed');
    await save(next, 'google');
    await save(next, 'samsung');
    await sweep();
    expect(await stateOf(old.id)).toEqual(['notified', null]);
  });

  it('Apple plus Google needs both: the new copy alone does not arm, the Apple add alone waits for the copy', async () => {
    const a = await moved(['google']);
    await save(a.old, 'google');
    await save(a.next, 'google');
    await sweep();
    expect(await stateOf(a.old.id)).toEqual(['notified', null]);
    await addApple(a.next);
    kit.clock.advance(DAY);
    await sweep();
    expect(await stateOf(a.old.id)).toEqual(['voided', null]);

    const b = await moved(['google']);
    await save(b.old, 'google');
    await addApple(b.next);
    kit.clock.advance(DAY);
    await sweep();
    expect(await stateOf(b.old.id)).toEqual(['registered', 'wallet_copy:google']);
    await save(b.next, 'google');
    kit.clock.advance(DAY + HOUR);
    await sweep();
    expect(await stateOf(b.old.id)).toEqual(['voided', null]);
  });

  it('revives a reminded row when the holder saves the replacement later', async () => {
    const { old, next } = await moved(['google'], false);
    await save(old, 'google');
    kit.clock.advance(31 * DAY);
    await sweep();
    expect(await stateOf(old.id)).toEqual(['kept', 'reminded']);
    await save(next, 'google');
    await sweep();
    expect(await stateOf(old.id)).toEqual(['registered', null]);
  });
});

describe('revocation with copies', () => {
  it('an admin voiding a kept_both old pass revokes the replacement and its copy through the void path', async () => {
    const { org, old, next } = await moved(['samsung']);
    const newCopy = await seedCopy(next, 'google');
    await save(old, 'samsung');
    await completeMove(next);
    kit.clock.advance(40 * DAY);
    await sweep();
    expect(await stateOf(old.id)).toEqual(['kept_both', 'wallet_copy:samsung']);
    const before = await dirtyOf(newCopy);
    await voidPass(ctx(), { type: 'user', id: 'admin-1' }, old.id, org.id);
    await sweep();
    expect((await passOf(kit, old.id)).status).toBe('voided');
    expect((await passOf(kit, next.id)).status).toBe('voided');
    expect(await stateOf(old.id)).toEqual(['kept', 'old_revoked']);
    expect(await dirtyOf(newCopy)).toBeGreaterThan(before);
  });

  it('an admin voiding the old pass while the move waits on a copy revokes the replacement', async () => {
    const { org, old, next } = await moved(['google']);
    await save(old, 'google');
    await completeMove(next);
    expect(await stateOf(old.id)).toEqual(['registered', 'wallet_copy:google']);
    await voidPass(ctx(), { type: 'user', id: 'admin-1' }, old.id, org.id);
    await sweep();
    expect((await passOf(kit, next.id)).status).toBe('voided');
    expect(await stateOf(old.id)).toEqual(['kept', 'old_revoked']);
  });

  it('an admin voiding the old pass before the replacement registers revokes the replacement', async () => {
    const { org, old, next } = await moved(['google']);
    await save(old, 'google');
    await voidPass(ctx(), { type: 'user', id: 'admin-1' }, old.id, org.id);
    await sweep();
    expect((await passOf(kit, next.id)).status).toBe('voided');
    expect(await stateOf(old.id)).toEqual(['kept', 'old_revoked']);
  });
});

describe('the replacement is offered the providers the holder had', () => {
  const channels = (passId: string) =>
    all<{ channel: string; override: string }>(
      db(),
      'SELECT channel, override FROM pass_channels WHERE pass_id = ? ORDER BY channel',
      [passId],
    );

  it("carries the old pass's own Google and Samsung switches, and nothing else", async () => {
    const { org, passes } = await orgWithPasses(kit, 1);
    const old = passes[0] as Old;
    for (const [channel, override] of [
      ['google', 'on'],
      ['samsung', 'off'],
      ['paper', 'on'],
    ])
      await run(
        db(),
        `INSERT INTO pass_channels (pass_id, org_id, mode, template_id, channel, override, set_by, set_at)
         VALUES (?, ?, 'live', ?, ?, ?, 'u1', 1)`,
        [old.id, old.orgId, old.templateId, channel, override],
      );
    await seedCopy(old, 'google');
    await startAndRun(kit, org.id);
    const next = await replacement(kit, old);
    expect(await channels(next.id)).toEqual([
      { channel: 'google', override: 'on' },
      { channel: 'samsung', override: 'off' },
    ]);
  });

  it('does not carry a switch that a plain turn off retired', async () => {
    const { org, passes } = await orgWithPasses(kit, 1);
    const old = passes[0] as Old;
    await run(
      db(),
      `INSERT INTO pass_channels (pass_id, org_id, mode, template_id, channel, override, retired_at, retired_cause, set_by, set_at)
       VALUES (?, ?, 'live', ?, 'google', 'off', 5, 'pass', 'u1', 1)`,
      [old.id, old.orgId, old.templateId],
    );
    await startAndRun(kit, org.id);
    expect(await channels((await replacement(kit, old)).id)).toEqual([]);
  });
});
