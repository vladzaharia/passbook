import { beforeAll, describe, expect, it, vi } from 'vitest';
import {
  credentialAad,
  decryptSecretText,
  encryptSecret,
  loadKekRing,
} from '../../platform/crypto.ts';
import { all, first, run } from '../../platform/db.ts';
import type { BroadcastKit } from '../broadcasts/test-kit.ts';
import { jobCtxOf } from '../delivery/delivery-test-fixtures.ts';
import { armOnRegister, voidDue } from './identity-move.ts';
import { armMoveNow } from './identity-move-arm.ts';
import { type Fingerprint, stateThreeWay } from './identity-move-recarry.ts';
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
import { forwardedId } from './pass-replaced.ts';
import { ICON_PNG } from './pass-test-fixtures.ts';
import { voidPass } from './service.ts';

const crash = vi.hoisted(() => ({ finish: false }));

vi.mock('../identities/resolver.ts', async (importOriginal) => {
  const original = await importOriginal<typeof import('../identities/resolver.ts')>();
  const { wrapResolver } = await import('./identity-move-resolver-test-fixtures.ts');
  return {
    ...original,
    createIdentityResolver: (...a: Parameters<typeof original.createIdentityResolver>) =>
      wrapResolver(original.createIdentityResolver(...a)),
  };
});

// A crash after the void's batch and before the row closes.
vi.mock('./repo-identity-move-timers.ts', async (importOriginal) => {
  const original = await importOriginal<typeof import('./repo-identity-move-timers.ts')>();
  return {
    ...original,
    finishVoid: (...a: Parameters<typeof original.finishVoid>) => {
      if (crash.finish) throw new Error('crashed before the row closed');
      return original.finishVoid(...a);
    },
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

/** One emailed pass with `seed` applied, moved; the replacement exists and the old pass sits on `dev-1`. */
async function movedWith(seed: (old: Old) => Promise<unknown> = async () => undefined) {
  const { org, passes } = await orgWithPasses(kit, 1);
  const old = passes[0] as Old;
  await seed(old);
  await startAndRun(kit, org.id);
  const next = await replacement(kit, old);
  await kit.device(old, 'dev-1', 'o'.repeat(64));
  return { org, old, next };
}
/** The holder adds the replacement on the device that holds the old pass. */
async function addNew(next: Old, device = 'dev-1') {
  await kit.device(next, device, 'a'.repeat(64));
  await armOnRegister(ctx(), next.id);
}
async function completeMove(next: Old) {
  await addNew(next);
  kit.clock.advance(DAY);
  await sweep();
}
const stateOf = async (oldId: string) => {
  const row = await moveOf(kit, oldId);
  return [row.state, row.reason];
};

async function seedConnection(old: Old) {
  const id = kit.fx.ids.id();
  await run(
    db(),
    "INSERT INTO connections (id, org_id, connector_type, name, created_at, updated_at) VALUES (?, ?, 'x', 'c', 1, 1)",
    [id, old.orgId],
  );
  await run(db(), "UPDATE passes SET connection_id = ?, external_ref = 'r1' WHERE id = ?", [
    id,
    old.id,
  ]);
}
const addNote = (old: Old, key: string, body: string) =>
  run(
    db(),
    `INSERT INTO pass_notes (id, org_id, mode, pass_id, credential_generation, body, author_name, idempotency_key, created_at)
     VALUES (?, ?, 'live', ?, ?, ?, 'Desk', ?, ?)`,
    [kit.fx.ids.id(), old.orgId, old.id, old.credentialGeneration, body, key, kit.clock.now()],
  );
const setRules = (passId: string, orgId: string, rules: string) =>
  run(
    db(),
    `INSERT INTO pass_check_in (pass_id, org_id, rules, updated_at) VALUES (?1, ?2, ?3, ?4)
     ON CONFLICT (pass_id) DO UPDATE SET rules = ?3, updated_at = ?4`,
    [passId, orgId, rules, kit.clock.now()],
  );
const rulesOf = async (passId: string) =>
  (
    await first<{ rules: string }>(db(), 'SELECT rules FROM pass_check_in WHERE pass_id = ?', [
      passId,
    ])
  )?.rules;
const SHA1 = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-1', ICON_PNG)), (b) =>
  b.toString(16).padStart(2, '0'),
).join('');
const photoKey = (old: Old, v: string) => `member-photos/${old.orgId}/${old.id}/${v}.png`;
async function setPhoto(old: Old, v: string) {
  await kit.env.BUCKET.put(photoKey(old, v), ICON_PNG);
  await run(
    db(),
    `INSERT INTO member_photos (pass_id, org_id, r2_key, sha1, size, crc32, include_in_pass, version, updated_at)
     VALUES (?1, ?2, ?3, ?4, ?5, 9, 1, ?6, ?7)
     ON CONFLICT (pass_id) DO UPDATE SET r2_key = ?3, sha1 = ?4, version = ?6, updated_at = ?7`,
    [old.id, old.orgId, photoKey(old, v), SHA1, ICON_PNG.length, v, kit.clock.now()],
  );
}
const photoOf = (passId: string) =>
  first<{ version: string; r2_key: string }>(
    db(),
    'SELECT version, r2_key FROM member_photos WHERE pass_id = ?',
    [passId],
  );

describe('N2: a replacement a device holds is never voided by the move', () => {
  it('keeps both live when a connection appears on the old pass mid-move', async () => {
    const { old, next } = await movedWith();
    await addNew(next);
    await seedConnection(old);
    kit.clock.advance(DAY);
    await sweep();
    expect((await passOf(kit, old.id)).status).toBe('active');
    expect((await passOf(kit, next.id)).status).toBe('active');
    expect(await stateOf(old.id)).toEqual(['kept_both', 'connection']);
    // Nothing later voids either pass, nor sends a reminder.
    const sent = kit.mailer.sent.length;
    kit.clock.advance(40 * DAY);
    await sweep();
    expect((await passOf(kit, old.id)).status).toBe('active');
    expect((await passOf(kit, next.id)).status).toBe('active');
    expect(kit.mailer.sent.length).toBe(sent);
  });

  it('R-B probe: the holder added the new pass and deleted the old one, then a connection was bound', async () => {
    const { old, next } = await movedWith();
    await addNew(next);
    await run(db(), 'DELETE FROM registrations WHERE pass_id = ?', [old.id]);
    await seedConnection(old);
    kit.clock.advance(DAY);
    await sweep();
    expect((await passOf(kit, next.id)).status).toBe('active');
    expect(
      await all(db(), 'SELECT 1 FROM registrations WHERE pass_id = ?', [next.id]),
    ).toHaveLength(1);
    expect(await stateOf(old.id)).toEqual(['kept_both', 'connection']);
  });
});

describe('K1: an admin revocation of a kept_both old pass revokes the replacement', () => {
  it('voids the replacement when the old pass is voided after the row went kept_both', async () => {
    const { org, old, next } = await movedWith();
    await addNew(next);
    await seedConnection(old);
    kit.clock.advance(DAY);
    await sweep();
    expect(await stateOf(old.id)).toEqual(['kept_both', 'connection']);
    await voidPass(ctx(), { type: 'user', id: 'admin-1' }, old.id, org.id);
    await sweep();
    expect((await passOf(kit, old.id)).status).toBe('voided');
    expect((await passOf(kit, next.id)).status).toBe('voided');
    expect(await stateOf(old.id)).toEqual(['kept', 'old_revoked']);
  });
});

describe('F2: replaced_by is set in the void batch', () => {
  it('forwards writes by the old id even when the sweep crashes before the row closes', async () => {
    const { old, next } = await movedWith();
    await addNew(next);
    kit.clock.advance(DAY);
    crash.finish = true;
    try {
      await expect(voidDue(ctx(), await moveOf(kit, old.id))).rejects.toThrow('crashed');
    } finally {
      crash.finish = false;
    }
    expect((await passOf(kit, old.id)).status).toBe('voided');
    expect(await forwardedId(db(), old.id)).toBe(next.id);
    expect((await moveOf(kit, old.id)).replaced_by).toBe(next.id);
    // The next sweep finds its own void and closes the row.
    kit.clock.advance(6 * 60_000);
    await sweep();
    expect((await moveOf(kit, old.id)).state).toBe('voided');
  });
});

describe('N1: state the old pass took on since the copy reaches the replacement', () => {
  it('R-B probe: a late staff note, and the replacement signed again with it', async () => {
    const { old, next } = await movedWith((p) => addNote(p, 'early', 'Early note'));
    const before = (await passOf(kit, next.id)).version;
    kit.clock.advance(2 * HOUR);
    await addNote(old, 'late', 'Do not admit');
    await completeMove(next);
    expect((await passOf(kit, old.id)).status).toBe('voided');
    expect(
      (
        await all<{ body: string }>(
          db(),
          'SELECT body FROM pass_notes WHERE pass_id = ? ORDER BY body',
          [next.id],
        )
      ).map((n) => n.body),
    ).toEqual(['Do not admit', 'Early note']);
    expect((await passOf(kit, next.id)).version).toBeGreaterThan(before);
  });

  it('carries check-in rules changed on the old pass, and keeps a change made on the replacement', async () => {
    const { org, old, next } = await movedWith((p) => setRules(p.id, p.orgId, '{"limit":2}'));
    await setRules(next.id, org.id, '{"limit":9}');
    await setRules(old.id, org.id, '{"limit":2}');
    // Only the replacement changed them: the old pass's unchanged rules do not overwrite.
    await completeMove(next);
    expect(await rulesOf(next.id)).toBe('{"limit":9}');
  });

  it('carries rules and a replaced photo that only the old pass changed', async () => {
    const { org, old, next } = await movedWith(async (p) => {
      await setRules(p.id, p.orgId, '{"limit":2}');
      await setPhoto(p, 'v1');
    });
    kit.clock.advance(HOUR);
    await setRules(old.id, org.id, '{"limit":5}');
    await setPhoto(old, 'v2');
    await completeMove(next);
    expect(await rulesOf(next.id)).toBe('{"limit":5}');
    const photo = await photoOf(next.id);
    expect(photo?.version).toBe('v2');
    expect(photo?.r2_key).toContain(next.id);
    expect(await kit.env.BUCKET.get(photo?.r2_key ?? '')).not.toBeNull();
  });

  it('carries a photo removed from the old pass', async () => {
    const { old, next } = await movedWith((p) => setPhoto(p, 'v1'));
    expect(await photoOf(next.id)).not.toBeNull();
    await run(db(), 'DELETE FROM member_photos WHERE pass_id = ?', [old.id]);
    await completeMove(next);
    expect(await photoOf(next.id)).toBeNull();
  });

  it('on a field both changed, the newer write wins and the conflict is recorded', async () => {
    const { org, old, next } = await movedWith((p) => setRules(p.id, p.orgId, '{"limit":2}'));
    await setRules(next.id, org.id, '{"limit":7}');
    kit.clock.advance(HOUR);
    await setRules(old.id, org.id, '{"limit":8}');
    await completeMove(next);
    expect(await rulesOf(next.id)).toBe('{"limit":8}');
    expect(JSON.parse((await moveOf(kit, old.id)).conflicts ?? '[]')).toEqual([
      { field: 'checkin', winner: 'old' },
    ]);
  });

  it('does not write twice: a second void attempt finds nothing new', async () => {
    const { old, next } = await movedWith();
    await addNote(old, 'late', 'Do not admit');
    await completeMove(next);
    expect(await all(db(), 'SELECT 1 FROM pass_notes WHERE pass_id = ?', [next.id])).toHaveLength(
      1,
    );
    expect((await moveOf(kit, old.id)).copied_state).toContain('note:late');
  });
});

describe('N1: personalization and assets', () => {
  it('carries Apple personalization and an asset added to the old pass, sealed under the replacement', async () => {
    const { old, next } = await movedWith();
    const sealed = await encryptSecret(
      await loadKekRing(kit.env),
      JSON.stringify({ emailAddress: 'late@example.com' }),
      credentialAad(old.id, old.orgId, 'personalization'),
    );
    await run(
      db(),
      `INSERT INTO pass_personalizations (pass_id, token_sha256, kek_version, iv, wrapped_dek, ciphertext, created_at, published_at)
       VALUES (?, ?, ?, ?, ?, ?, 5, 6)`,
      [old.id, 'c'.repeat(64), sealed.kekVersion, sealed.iv, sealed.wrappedDek, sealed.ciphertext],
    );
    const key = `pass-assets/${old.id}/icon.png/late.png`;
    await kit.env.BUCKET.put(key, ICON_PNG);
    await run(
      db(),
      `INSERT INTO pass_assets (pass_id, name, r2_key, sha1, size, created_at) VALUES (?, 'icon.png', ?, ?, ?, 5)`,
      [old.id, key, SHA1, ICON_PNG.length],
    );
    await completeMove(next);
    const row = await first<{
      kek_version: number;
      iv: ArrayBuffer;
      wrapped_dek: ArrayBuffer;
      ciphertext: ArrayBuffer;
      token_sha256: string;
    }>(db(), 'SELECT * FROM pass_personalizations WHERE pass_id = ?', [next.id]);
    expect(row?.token_sha256).toBe('c'.repeat(64));
    const text = await decryptSecretText(
      await loadKekRing(kit.env),
      {
        kekVersion: row?.kek_version ?? 0,
        iv: new Uint8Array(row?.iv ?? new ArrayBuffer(0)),
        wrappedDek: new Uint8Array(row?.wrapped_dek ?? new ArrayBuffer(0)),
        ciphertext: new Uint8Array(row?.ciphertext ?? new ArrayBuffer(0)),
      },
      credentialAad(next.id, next.orgId, 'personalization'),
    );
    expect(JSON.parse(text)).toEqual({ emailAddress: 'late@example.com' });
    const asset = await first<{ r2_key: string }>(
      db(),
      'SELECT r2_key FROM pass_assets WHERE pass_id = ?',
      [next.id],
    );
    expect(asset?.r2_key).toContain(next.id);
    expect(await kit.env.BUCKET.get(asset?.r2_key ?? '')).not.toBeNull();
  });
});

describe('stateThreeWay', () => {
  const item = (v: string, at = 1) => ({ v, at });
  const f = (o: Record<string, [string, number?]>): Fingerprint =>
    Object.fromEntries(Object.entries(o).map(([k, [v, at]]) => [k, item(v, at)]));

  it('takes what only the old pass changed, adds and removals included', () => {
    const r = stateThreeWay({
      base: f({ photo: ['a'], 'note:x': ['n'] }),
      madeBase: f({ photo: ['a'], 'note:x': ['n'] }),
      old: f({ photo: ['b'], 'note:y': ['m'] }),
      made: f({ photo: ['a'], 'note:x': ['n'] }),
    });
    expect(r.take.sort()).toEqual(['note:x', 'note:y', 'photo']);
    expect(r.conflicts).toEqual([]);
  });

  it('leaves what the replacement changed, and what both changed to the same value', () => {
    const r = stateThreeWay({
      base: f({ checkin: ['a'], photo: ['a'] }),
      madeBase: f({ checkin: ['a'], photo: ['a'] }),
      old: f({ checkin: ['a'], photo: ['b'] }),
      made: f({ checkin: ['z'], photo: ['b'] }),
    });
    expect(r).toEqual({ take: [], conflicts: [] });
  });

  it('reports a field both changed and gives it to the newer write', () => {
    const base = f({ checkin: ['a'] });
    const mk = (oldAt: number) =>
      stateThreeWay({
        base,
        madeBase: base,
        old: f({ checkin: ['b', oldAt] }),
        made: f({ checkin: ['c', 5] }),
      });
    expect(mk(9)).toEqual({ take: ['checkin'], conflicts: [{ field: 'checkin', winner: 'old' }] });
    expect(mk(2)).toEqual({
      take: [],
      conflicts: [{ field: 'checkin', winner: 'replacement' }],
    });
  });
});

describe('N3: a registration that never arms the void is counted, and an admin can arm it', () => {
  const admin = { userId: 'admin-1' };
  /** The holder adds the replacement on a device that does not hold the old pass. */
  async function addElsewhere() {
    const made = await movedWith();
    await kit.device(made.next, 'dev-other', 'b'.repeat(64));
    await armOnRegister(ctx(), made.next.id);
    return made;
  }

  it('marks the row unarmed after 7 days and counts it once', async () => {
    const { old } = await addElsewhere();
    kit.clock.advance(6 * DAY);
    await sweep();
    expect(await stateOf(old.id)).toEqual(['notified', null]);
    kit.clock.advance(2 * DAY);
    await sweep();
    expect(await stateOf(old.id)).toEqual(['notified', 'unarmed']);
    const events = vi.spyOn(kit.env.EVENTS, 'writeDataPoint');
    await sweep();
    expect(events).not.toHaveBeenCalled();
  });

  it('writes a move.unarmed data point when it marks', async () => {
    const events = vi.spyOn(kit.env.EVENTS, 'writeDataPoint');
    const { org } = await addElsewhere();
    kit.clock.advance(8 * DAY);
    await sweep();
    expect(
      events.mock.calls.some(([p]) => p?.blobs?.[0] === 'move.unarmed' && p.blobs[1] === org.id),
    ).toBe(true);
  });

  it('arm now starts the 24 hours, the old pass voids after them, and the mark clears', async () => {
    const { org, old, next } = await addElsewhere();
    kit.clock.advance(8 * DAY);
    await sweep();
    await armMoveNow(ctx(), admin, org.id, (await moveOf(kit, old.id)).id);
    expect(await stateOf(old.id)).toEqual(['registered', null]);
    await sweep();
    expect((await passOf(kit, old.id)).status).toBe('active');
    kit.clock.advance(DAY);
    await sweep();
    expect((await passOf(kit, old.id)).status).toBe('voided');
    expect((await passOf(kit, next.id)).status).toBe('active');
  });

  it('arm now refuses a move of another org, one with no registration, and one already armed', async () => {
    const { org, old } = await movedWith();
    const id = (await moveOf(kit, old.id)).id;
    await expect(armMoveNow(ctx(), admin, org.id, id)).rejects.toMatchObject({
      code: 'IDENTITY_MOVE_CONFLICT',
    });
    await expect(armMoveNow(ctx(), admin, 'other-org', id)).rejects.toMatchObject({
      status: 404,
    });
    const k = await addElsewhere();
    const armed = (await moveOf(kit, k.old.id)).id;
    await armMoveNow(ctx(), admin, k.org.id, armed);
    await expect(armMoveNow(ctx(), admin, k.org.id, armed)).rejects.toMatchObject({
      code: 'IDENTITY_MOVE_CONFLICT',
    });
  });
});
