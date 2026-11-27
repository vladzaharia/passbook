import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
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

// Google's answer to "does the object have users": the real read has its own tests (google-copy-users.test.ts).
const google = vi.hoisted(() => ({ answer: false as boolean | null, asked: 0 }));
vi.mock('../wallet-providers/google-copy-users.ts', () => ({
  googleCopyHasUsers: async () => {
    google.asked++;
    return google.answer;
  },
}));

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
beforeEach(() => {
  google.answer = false;
  google.asked = 0;
});
/** PI-3's default switch: the old identity issues no new passes, but still updates the ones it has. */
async function whileSwitched<T>(fn: () => Promise<T>): Promise<T> {
  await run(db(), "UPDATE signing_identities SET issuing = 0 WHERE id = 'platform'");
  try {
    return await fn();
  } finally {
    await run(db(), "UPDATE signing_identities SET issuing = 1 WHERE id = 'platform'");
  }
}
/** The old identity is retired: switched, and its env material removed. The one thing that ends a wait. */
async function whileRetired<T>(fn: () => Promise<T>): Promise<T> {
  const env = kit.env as unknown as Record<string, string | undefined>;
  const kept = [env.SIGNER_PLATFORM_CERTIFICATE, env.SIGNER_PLATFORM_PRIVATE_KEY];
  delete env.SIGNER_PLATFORM_CERTIFICATE;
  delete env.SIGNER_PLATFORM_PRIVATE_KEY;
  try {
    return await whileSwitched(fn);
  } finally {
    env.SIGNER_PLATFORM_CERTIFICATE = kept[0];
    env.SIGNER_PLATFORM_PRIVATE_KEY = kept[1];
  }
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
      // Google says nobody has its copy; the holder removed the Samsung one (its report says so).
      if (providers.includes('samsung')) {
        await save(old, 'samsung');
        await report(old, 'samsung', 'wallet.removed');
      }
      const before = new Map<string, number>();
      for (const id of copies.values()) before.set(id, await dirtyOf(id));
      await completeMove(next);
      expect(await stateOf(old.id)).toEqual(['voided', null]);
      expect((await passOf(kit, old.id)).status).toBe('voided');
      expect((await passOf(kit, next.id)).status).toBe('active');
      // The provider's own void path: each copy's pass write told the drain, in the void's batch.
      for (const id of copies.values())
        expect(await dirtyOf(id)).toBeGreaterThan(before.get(id) ?? 0);
      expect(google.asked).toBe(providers.includes('google') ? 1 : 0);
    },
  );

  it('voids the old pass with a copy removed after it was saved, asking nobody', async () => {
    const { old, next } = await moved(['google', 'samsung']);
    for (const p of ['google', 'samsung'] as const) {
      await save(old, p);
      await report(old, p, 'wallet.removed');
    }
    await completeMove(next);
    expect(await stateOf(old.id)).toEqual(['voided', null]);
    expect(google.asked).toBe(0);
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
    'waits, with its reason, when %j was saved mid-move and the replacement has none; the reminder at the deadline does not end it, the old identity retiring does',
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
      // At the deadline (30 days after the replacement was issued) the holder is reminded; the row keeps waiting.
      kit.clock.advance(30 * DAY);
      await sweep();
      expect(await stateOf(old.id)).toEqual(['registered', reason]);
      expect((await passOf(kit, old.id)).status).toBe('active');
      expect((await passOf(kit, next.id)).status).toBe('active');
      // Only the old identity retiring ends it, both passes live.
      await whileRetired(async () => {
        kit.clock.advance(DAY);
        await sweep();
      });
      expect(await stateOf(old.id)).toEqual(['kept_both', reason]);
      expect((await passOf(kit, old.id)).status).toBe('active');
      expect((await passOf(kit, next.id)).status).toBe('active');
      for (const id of copies.values()) expect(await dirtyOf(id)).toBe(before.get(id));
      // Nothing later voids either pass.
      kit.clock.advance(40 * DAY);
      await sweep();
      expect((await passOf(kit, old.id)).status).toBe('active');
      expect((await passOf(kit, next.id)).status).toBe('active');
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

  it('revives a reminded row when the holder saves the replacement on day 40, and the old pass goes 24 hours later', async () => {
    const { old, next } = await moved(['google'], false);
    await save(old, 'google');
    kit.clock.advance(31 * DAY);
    await sweep();
    expect(await stateOf(old.id)).toEqual(['kept', 'reminded']);
    kit.clock.advance(9 * DAY);
    await save(next, 'google');
    await sweep();
    expect(await stateOf(old.id)).toEqual(['registered', null]);
    kit.clock.advance(DAY + HOUR);
    await sweep();
    expect(await stateOf(old.id)).toEqual(['voided', null]);
  });
});

describe('W2: a device that holds the old pass without the replacement keeps it', () => {
  it('a row armed by wallet saves does not void an Apple pass registered later on another iPhone', async () => {
    const { old, next } = await moved(['google'], false);
    await save(old, 'google');
    await save(next, 'google');
    await sweep();
    expect(await stateOf(old.id)).toEqual(['registered', null]);
    expect((await moveOf(kit, old.id)).armed_device).toBe('wallet');
    await kit.device(old, 'dev-9', 'p'.repeat(64));
    kit.clock.advance(2 * DAY);
    await sweep();
    expect((await passOf(kit, old.id)).status).toBe('active');
    expect((await passOf(kit, next.id)).status).toBe('active');
    // The wallet arming is gone; the Apple path arms when the replacement reaches that iPhone.
    expect(await stateOf(old.id)).toEqual(['notified', null]);
    await kit.device(next, 'dev-9', 'q'.repeat(64));
    await armOnRegister(ctx(), next.id);
    kit.clock.advance(DAY);
    await sweep();
    expect(await stateOf(old.id)).toEqual(['voided', null]);
  });

  it('a wallet-armed row voids once the replacement is on that iPhone too', async () => {
    const { old, next } = await moved(['google'], false);
    await save(old, 'google');
    await save(next, 'google');
    await sweep();
    await kit.device(old, 'dev-9', 'p'.repeat(64));
    await kit.device(next, 'dev-9', 'q'.repeat(64));
    kit.clock.advance(2 * DAY);
    await sweep();
    expect(await stateOf(old.id)).toEqual(['voided', null]);
  });
});

describe('W1: a lost save callback is not proof the copy is unsaved', () => {
  it('Google says the object has users: the old pass waits as wallet_copy:google, past the deadline, until the old identity retires', async () => {
    google.answer = true;
    const { old, next, copies } = await moved(['google']);
    const before = await dirtyOf(copies.get('google') ?? '');
    await completeMove(next);
    expect(google.asked).toBe(1);
    expect(await stateOf(old.id)).toEqual(['registered', 'wallet_copy:google']);
    expect((await passOf(kit, old.id)).status).toBe('active');
    // It asks again after an hour, not on every sweep.
    await sweep();
    expect(google.asked).toBe(1);
    kit.clock.advance(HOUR + 1_000);
    await sweep();
    expect(google.asked).toBe(2);
    kit.clock.advance(40 * DAY);
    await sweep();
    expect(await stateOf(old.id)).toEqual(['registered', 'wallet_copy:google']);
    await whileRetired(async () => {
      kit.clock.advance(DAY);
      await sweep();
    });
    expect(await stateOf(old.id)).toEqual(['kept_both', 'wallet_copy:google']);
    expect((await passOf(kit, old.id)).status).toBe('active');
    expect(await dirtyOf(copies.get('google') ?? '')).toBe(before);
  });

  it('Google says the object has no users: the old pass is voided, with its copy', async () => {
    google.answer = false;
    const { old, next, copies } = await moved(['google']);
    const before = await dirtyOf(copies.get('google') ?? '');
    await completeMove(next);
    expect(google.asked).toBe(1);
    expect(await stateOf(old.id)).toEqual(['voided', null]);
    expect(await dirtyOf(copies.get('google') ?? '')).toBeGreaterThan(before);
  });

  it('Google cannot be asked: the copy is held', async () => {
    google.answer = null;
    const { old, next } = await moved(['google']);
    await completeMove(next);
    expect(await stateOf(old.id)).toEqual(['registered', 'wallet_copy:google']);
    expect((await passOf(kit, old.id)).status).toBe('active');
  });

  it('Google users appear after the first answer: the next look holds, and a later empty answer voids', async () => {
    google.answer = true;
    const { old, next } = await moved(['google']);
    await completeMove(next);
    google.answer = false;
    kit.clock.advance(HOUR + 1_000);
    await sweep();
    expect(await stateOf(old.id)).toEqual(['voided', null]);
  });

  it('Samsung with no events is held until the replacement is saved, however long that takes', async () => {
    const { old, next, copies } = await moved(['samsung']);
    const before = await dirtyOf(copies.get('samsung') ?? '');
    await completeMove(next);
    expect(google.asked).toBe(0);
    expect(await stateOf(old.id)).toEqual(['registered', 'wallet_copy:samsung']);
    kit.clock.advance(40 * DAY);
    await sweep();
    expect(await stateOf(old.id)).toEqual(['registered', 'wallet_copy:samsung']);
    expect((await passOf(kit, old.id)).status).toBe('active');
    expect(await dirtyOf(copies.get('samsung') ?? '')).toBe(before);
  });

  it('Samsung with no events is released once the replacement is saved, and voided 24 hours later', async () => {
    const { old, next } = await moved(['samsung']);
    await completeMove(next);
    expect(await stateOf(old.id)).toEqual(['registered', 'wallet_copy:samsung']);
    await save(next, 'samsung');
    kit.clock.advance(DAY + HOUR);
    await sweep();
    expect(await stateOf(old.id)).toEqual(['voided', null]);
  });

  it('does not ask Google when a report already speaks for the copy', async () => {
    const { old, next } = await moved(['google']);
    await save(old, 'google');
    await completeMove(next);
    expect(google.asked).toBe(0);
    expect(await stateOf(old.id)).toEqual(['registered', 'wallet_copy:google']);
  });
});

describe('the 30-day reminder of a move waiting on a wallet copy', () => {
  const sentTo = (email: string | null) =>
    kit.mailer.sent.filter((m) => m.to === email && /Save it in/.test(m.text ?? ''));

  it.each([
    [['google'], 'Google Wallet'],
    [['samsung'], 'Samsung Wallet'],
    [['google', 'samsung'], 'Google Wallet and Samsung Wallet'],
  ] as [Provider[], string][])(
    'names the wallet of %j, goes once, and a save on day 40 still voids the old pass',
    async (providers, names) => {
      const { old, next } = await moved(providers);
      for (const p of providers) await save(old, p);
      await completeMove(next);
      expect(sentTo(next.holderEmail)).toHaveLength(0);
      kit.clock.advance(35 * DAY);
      await sweep();
      const mails = sentTo(next.holderEmail);
      expect(mails).toHaveLength(1);
      expect(mails[0]?.text).toContain(`Save it in ${names}`);
      expect(mails[0]?.text).toContain('/p/');
      // The row keeps waiting; the reminder is not the end.
      expect((await moveOf(kit, old.id)).state).toBe('registered');
      expect((await moveOf(kit, old.id)).reminded_at).not.toBeNull();
      kit.clock.advance(5 * DAY);
      await sweep();
      expect(sentTo(next.holderEmail)).toHaveLength(1);
      expect((await passOf(kit, old.id)).status).toBe('active');
      // Day 40: the holder saves the new copy; the 24 hours run from that save.
      for (const p of providers) await save(next, p);
      await sweep();
      expect((await passOf(kit, old.id)).status).toBe('active');
      kit.clock.advance(DAY + HOUR);
      await sweep();
      expect(await stateOf(old.id)).toEqual(['voided', null]);
      expect((await passOf(kit, next.id)).status).toBe('active');
      expect(sentTo(next.holderEmail)).toHaveLength(1);
    },
  );

  it('keeps waiting when the default is switched and the old identity is not retired, then voids after a save', async () => {
    const { old, next } = await moved(['samsung']);
    await completeMove(next);
    await whileSwitched(async () => {
      kit.clock.advance(35 * DAY);
      await sweep();
      expect(await stateOf(old.id)).toEqual(['registered', 'wallet_copy:samsung']);
      kit.clock.advance(5 * DAY);
      await sweep();
      expect(await stateOf(old.id)).toEqual(['registered', 'wallet_copy:samsung']);
      await save(next, 'samsung');
      kit.clock.advance(DAY + HOUR);
      await sweep();
      expect(await stateOf(old.id)).toEqual(['voided', null]);
    });
    expect((await passOf(kit, next.id)).status).toBe('active');
  });

  it('ends kept_both only when the old identity retires while the row waits', async () => {
    const { old, next } = await moved(['samsung']);
    await completeMove(next);
    kit.clock.advance(35 * DAY);
    await sweep();
    expect((await moveOf(kit, old.id)).state).toBe('registered');
    await whileRetired(async () => {
      kit.clock.advance(DAY);
      await sweep();
    });
    expect(await stateOf(old.id)).toEqual(['kept_both', 'wallet_copy:samsung']);
    expect((await passOf(kit, old.id)).status).toBe('active');
    expect(sentTo(next.holderEmail)).toHaveLength(1);
  });

  it('is not sent when the holder saved the new copy in time', async () => {
    const { old, next } = await moved(['google']);
    await save(old, 'google');
    await completeMove(next);
    await save(next, 'google');
    kit.clock.advance(35 * DAY);
    await sweep();
    expect(sentTo(next.holderEmail)).toHaveLength(0);
    expect((await moveOf(kit, old.id)).state).toBe('voided');
  });

  it('is tried again tomorrow when the mail fails, and goes once', async () => {
    const { old, next } = await moved(['samsung']);
    await completeMove(next);
    kit.clock.advance(35 * DAY);
    const send = vi.spyOn(kit.mailer, 'send').mockRejectedValueOnce(new Error('down'));
    await sweep();
    expect(await stateOf(old.id)).toEqual(['registered', 'wallet_copy:samsung']);
    expect(sentTo(next.holderEmail)).toHaveLength(0);
    kit.clock.advance(DAY + HOUR);
    await sweep();
    send.mockRestore();
    expect(sentTo(next.holderEmail)).toHaveLength(1);
    expect((await moveOf(kit, old.id)).state).toBe('registered');
  });
});

describe('revocation with copies', () => {
  it('an admin voiding a kept_both old pass revokes the replacement and its copy through the void path', async () => {
    const { org, old, next } = await moved(['samsung']);
    const newCopy = await seedCopy(next, 'google');
    await save(old, 'samsung');
    await completeMove(next);
    await whileRetired(async () => {
      kit.clock.advance(DAY);
      await sweep();
    });
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
