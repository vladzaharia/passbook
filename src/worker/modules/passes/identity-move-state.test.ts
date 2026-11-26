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
import { printCodeOf, printCodeRef } from '../prints/codes.ts';
import { codePassIdOf } from '../prints/repo.ts';
import { armOnRegister } from './identity-move.ts';
import { sweepIdentityMoves } from './identity-move-sweep.ts';
import {
  DAY,
  moveKit,
  moveOf,
  orgWithPasses,
  passOf,
  replacement,
  startAndRun,
} from './identity-move-test-fixtures.ts';
import { ICON_PNG } from './pass-test-fixtures.ts';
import { candidates, countCandidates } from './repo-identity-move-candidates.ts';

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

const SHA1 = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-1', ICON_PNG)), (b) =>
  b.toString(16).padStart(2, '0'),
).join('');
const photoKey = (passId: string, orgId: string) => `member-photos/${orgId}/${passId}/tok-sha.png`;
const assetKey = (passId: string) => `pass-assets/${passId}/icon.png/tok-sha.png`;

async function seedPhoto(old: Old) {
  await kit.env.BUCKET.put(photoKey(old.id, old.orgId), ICON_PNG);
  await run(
    db(),
    `INSERT INTO member_photos (pass_id, org_id, r2_key, sha1, size, crc32, include_in_pass, version, updated_at)
     VALUES (?, ?, ?, ?, ?, 9, 1, 'v1', 5)`,
    [old.id, old.orgId, photoKey(old.id, old.orgId), SHA1, ICON_PNG.length],
  );
}
async function seedAsset(old: Old) {
  await kit.env.BUCKET.put(assetKey(old.id), ICON_PNG);
  await run(
    db(),
    `INSERT INTO pass_assets (pass_id, name, r2_key, sha1, size, created_at)
     VALUES (?, 'icon.png', ?, ?, ?, 5)`,
    [old.id, assetKey(old.id), SHA1, ICON_PNG.length],
  );
}
async function seedPersonalization(old: Old) {
  const sealed = await encryptSecret(
    await loadKekRing(kit.env),
    JSON.stringify({ emailAddress: 'holder@example.com' }),
    credentialAad(old.id, old.orgId, 'personalization'),
  );
  await run(
    db(),
    `INSERT INTO pass_personalizations (pass_id, token_sha256, kek_version, iv, wrapped_dek, ciphertext, created_at, published_at)
     VALUES (?, ?, ?, ?, ?, ?, 5, 6)`,
    [old.id, 'a'.repeat(64), sealed.kekVersion, sealed.iv, sealed.wrappedDek, sealed.ciphertext],
  );
}
const seedCheckIn = (old: Old) =>
  run(db(), `INSERT INTO pass_check_in (pass_id, org_id, rules, updated_at) VALUES (?, ?, ?, 5)`, [
    old.id,
    old.orgId,
    '{"limit":2}',
  ]);
const seedNote = (old: Old) =>
  run(
    db(),
    `INSERT INTO pass_notes (id, org_id, mode, pass_id, credential_generation, body, author_name, idempotency_key, created_at)
     VALUES (?, ?, 'live', ?, ?, 'Do not admit', 'Desk', 'k1', 5)`,
    [kit.fx.ids.id(), old.orgId, old.id, old.credentialGeneration],
  );
async function seedBundle(old: Old) {
  const bundle = kit.fx.ids.id();
  await run(
    db(),
    `INSERT INTO bundles (id, org_id, name, token, created_at) VALUES (?, ?, 'Family', ?, 1)`,
    [bundle, old.orgId, `h1:${kit.fx.ids.token()}`],
  );
  await run(db(), 'INSERT INTO bundle_passes (bundle_id, pass_id, position) VALUES (?, ?, 3)', [
    bundle,
    old.id,
  ]);
  return bundle;
}
let PRINT_ID = '';
const printCode = (old: Old) =>
  printCodeOf(kit.env, { id: PRINT_ID, passId: old.id, orgId: old.orgId, mode: 'live' });
async function seedPrint(old: Old) {
  PRINT_ID = kit.fx.ids.id();
  const hash = await printCodeRef(kit.env, old.orgId, 'live', await printCode(old));
  await run(
    db(),
    `INSERT INTO pass_prints (id, pass_id, org_id, mode, print_code_hash, roster_hash, generation, status, created_by, created_at)
     VALUES (?, ?, ?, 'live', ?, ?, 1, 'active', 'test', 1)`,
    [PRINT_ID, old.id, old.orgId, hash, 'b'.repeat(32)],
  );
}
async function seedTag(old: Old) {
  const tag = kit.fx.ids.id();
  await run(
    db(),
    `INSERT INTO nfc_tags (id, org_id, mode, tag_ref, system, hint, created_at)
     VALUES (?, ?, 'live', ?, 'uid', 'ABCD', 1)`,
    [tag, old.orgId, `abcd${tag.replace(/-/g, '')}`.padEnd(64, 'a').slice(0, 64)],
  );
  await run(
    db(),
    `INSERT INTO tag_bindings (id, tag_id, scope, pass_id, source, bound_at, bound_by_type, bound_by, holder_generation)
     VALUES (?, ?, 'pass', ?, 'admin', 1, 'user', 'admin-1', ?)`,
    [kit.fx.ids.id(), tag, old.id, old.credentialGeneration],
  );
  return tag;
}

/** One emailed pass with `seed` applied, moved; the replacement exists and the old pass sits on `dev-1`. */
async function movedWith(seed: (old: Old) => Promise<unknown> = async () => undefined) {
  const { org, passes } = await orgWithPasses(kit, 1);
  const old = passes[0] as Old;
  await seed(old);
  await startAndRun(kit, org.id);
  const next = await replacement(kit, old);
  await kit.device(old, 'dev-1', 'o'.repeat(64));
  // The replacement was issued and the old pass told: nothing failed on the way.
  expect((await moveOf(kit, old.id)).state).toBe('notified');
  return { org, old, next };
}
/** The holder adds the replacement on the device that holds the old pass, and a day passes. */
async function completeMove(next: Old) {
  await kit.device(next, 'dev-1', 'a'.repeat(64));
  await armOnRegister(ctx(), next.id);
  kit.clock.advance(DAY);
  await sweep();
}

describe('H1: state copied to the replacement', () => {
  it('copies the member photo and per-pass assets to objects of the replacement', async () => {
    const { old, next } = await movedWith(async (p) => {
      await seedPhoto(p);
      await seedAsset(p);
    });
    const photo = await first<{ r2_key: string; version: string; include_in_pass: number }>(
      db(),
      'SELECT r2_key, version, include_in_pass FROM member_photos WHERE pass_id = ?',
      [next.id],
    );
    const asset = await first<{ r2_key: string; name: string }>(
      db(),
      'SELECT r2_key, name FROM pass_assets WHERE pass_id = ?',
      [next.id],
    );
    expect(photo).toMatchObject({ version: 'v1', include_in_pass: 1 });
    expect(photo?.r2_key).toContain(next.id);
    expect(asset?.r2_key).toContain(next.id);
    expect(photo?.r2_key).not.toContain(old.id);
    expect(
      Array.from(
        new Uint8Array(
          (await (await kit.env.BUCKET.get(photo?.r2_key ?? ''))?.arrayBuffer()) ??
            new ArrayBuffer(0),
        ),
      ),
    ).toEqual(Array.from(ICON_PNG));
    expect(await kit.env.BUCKET.get(asset?.r2_key ?? '')).not.toBeNull();
    // The old pass keeps its own objects.
    expect(await kit.env.BUCKET.get(assetKey(old.id))).not.toBeNull();
  });

  it('copies Apple personalization, sealed again under the replacement', async () => {
    const { next } = await movedWith(seedPersonalization);
    const row = await first<{
      kek_version: number;
      iv: ArrayBuffer;
      wrapped_dek: ArrayBuffer;
      ciphertext: ArrayBuffer;
      token_sha256: string;
      published_at: number;
    }>(db(), 'SELECT * FROM pass_personalizations WHERE pass_id = ?', [next.id]);
    expect(row?.token_sha256).toBe('a'.repeat(64));
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
    expect(JSON.parse(text)).toEqual({ emailAddress: 'holder@example.com' });
  });

  it('copies the check-in rules', async () => {
    const { next } = await movedWith(seedCheckIn);
    expect(
      await first(db(), 'SELECT rules FROM pass_check_in WHERE pass_id = ?', [next.id]),
    ).toEqual({ rules: '{"limit":2}' });
  });

  it('copies staff notes, under the replacement credential generation', async () => {
    const { next } = await movedWith(seedNote);
    expect(
      await all(
        db(),
        'SELECT body, author_name, credential_generation FROM pass_notes WHERE pass_id = ?',
        [next.id],
      ),
    ).toEqual([
      {
        body: 'Do not admit',
        author_name: 'Desk',
        credential_generation: next.credentialGeneration,
      },
    ]);
  });

  it('copies nothing twice when the issue step runs again', async () => {
    const { old, next } = await movedWith(async (p) => {
      await seedNote(p);
      await seedAsset(p);
    });
    const { issueReplacement } = await import('./identity-move.ts');
    const { moveById } = await import('./repo-identity-move.ts');
    const row = await moveOf(kit, old.id);
    await run(db(), "UPDATE pass_moves SET state = 'planned' WHERE id = ?", [row.id]);
    await issueReplacement(ctx(), (await moveById(db(), row.id)) as typeof row);
    expect(await all(db(), 'SELECT 1 FROM pass_notes WHERE pass_id = ?', [next.id])).toHaveLength(
      1,
    );
    expect(await all(db(), 'SELECT 1 FROM pass_assets WHERE pass_id = ?', [next.id])).toHaveLength(
      1,
    );
  });

  it('keeps the pass, with a named reason, when an image object is gone', async () => {
    const { org, passes } = await orgWithPasses(kit, 1);
    const old = passes[0] as Old;
    await run(
      db(),
      `INSERT INTO pass_assets (pass_id, name, r2_key, sha1, size, created_at) VALUES (?, 'icon.png', 'gone', 's', 1, 1)`,
      [old.id],
    );
    await startAndRun(kit, org.id);
    expect(await moveOf(kit, old.id)).toMatchObject({ state: 'kept', reason: 'files_missing' });
  });
});

describe('H1: state re-pointed in the batch that voids the old pass', () => {
  it('moves bundle membership, with its position, and leaves no bundle on the voided pass', async () => {
    let bundle = '';
    const { old, next } = await movedWith(async (p) => {
      bundle = await seedBundle(p);
    });
    expect(
      await all(db(), 'SELECT 1 FROM bundle_passes WHERE pass_id = ?', [next.id]),
    ).toHaveLength(0);
    await completeMove(next);
    expect((await passOf(kit, old.id)).status).toBe('voided');
    expect(
      await all(db(), 'SELECT pass_id, position FROM bundle_passes WHERE bundle_id = ?', [bundle]),
    ).toEqual([{ pass_id: next.id, position: 3 }]);
  });

  it('moves the printed card, and its code keeps working', async () => {
    const { old, next } = await movedWith(seedPrint);
    await completeMove(next);
    const code = await printCode(old);
    const print = await first<{ pass_id: string; status: string; code_pass_id: string }>(
      db(),
      'SELECT pass_id, status, code_pass_id FROM pass_prints WHERE id = ?',
      [PRINT_ID],
    );
    expect(print).toEqual({ pass_id: next.id, status: 'active', code_pass_id: old.id });
    // The door finds the print by the hash of the code on paper, and it now names the replacement.
    const ref = await printCodeRef(kit.env, old.orgId, 'live', code);
    expect(
      await first(db(), 'SELECT pass_id FROM pass_prints WHERE print_code_hash = ?', [ref]),
    ).toEqual({ pass_id: next.id });
    expect(
      await printCodeOf(kit.env, {
        id: PRINT_ID,
        passId: await codePassIdOf(db(), PRINT_ID, next.id),
        orgId: next.orgId,
        mode: 'live',
      }),
    ).toBe(code);
    expect(
      await all(db(), "SELECT 1 FROM pass_prints WHERE pass_id = ? AND status = 'voided'", [
        old.id,
      ]),
    ).toHaveLength(0);
  });

  it('moves a tag bound to the pass and ends the old binding as moved', async () => {
    let tag = '';
    const { old, next } = await movedWith(async (p) => {
      tag = await seedTag(p);
    });
    await completeMove(next);
    expect(
      await all(
        db(),
        'SELECT pass_id, ended_at IS NOT NULL AS ended, end_cause FROM tag_bindings WHERE tag_id = ? ORDER BY bound_at, ended_at',
        [tag],
      ),
    ).toEqual(
      expect.arrayContaining([
        { pass_id: old.id, ended: 1, end_cause: 'moved' },
        { pass_id: next.id, ended: 0, end_cause: null },
      ]),
    );
  });

  it('carries everything at once, and nothing points at the voided pass', async () => {
    let bundle = '';
    let tag = '';
    const { old, next } = await movedWith(async (p) => {
      await seedPhoto(p);
      await seedAsset(p);
      await seedPersonalization(p);
      await seedCheckIn(p);
      await seedNote(p);
      bundle = await seedBundle(p);
      await seedPrint(p);
      tag = await seedTag(p);
    });
    await completeMove(next);
    expect((await passOf(kit, old.id)).status).toBe('voided');
    expect((await passOf(kit, next.id)).status).toBe('active');
    const at = async (sql: string, id: string) => (await all(db(), sql, [id])).length;
    for (const table of [
      'member_photos',
      'pass_assets',
      'pass_personalizations',
      'pass_check_in',
      'pass_notes',
    ])
      expect(await at(`SELECT 1 FROM ${table} WHERE pass_id = ?`, next.id)).toBeGreaterThan(0);
    expect(await at('SELECT 1 FROM bundle_passes WHERE pass_id = ?', old.id)).toBe(0);
    expect(await at('SELECT 1 FROM bundle_passes WHERE pass_id = ?', next.id)).toBe(1);
    expect(
      await at("SELECT 1 FROM pass_prints WHERE pass_id = ? AND status = 'active'", old.id),
    ).toBe(0);
    expect(
      await at("SELECT 1 FROM pass_prints WHERE pass_id = ? AND status = 'active'", next.id),
    ).toBe(1);
    expect(
      await at('SELECT 1 FROM tag_bindings WHERE pass_id = ? AND ended_at IS NULL', old.id),
    ).toBe(0);
    expect(
      await at('SELECT 1 FROM tag_bindings WHERE pass_id = ? AND ended_at IS NULL', next.id),
    ).toBe(1);
    expect(bundle).not.toBe('');
    expect(tag).not.toBe('');
  });
});

describe('H1: what cannot be carried keeps the pass, by name', () => {
  /** A Google or Samsung copy is named by a hash of the pass id; only its row matters to the plan. */
  async function seedWalletCopy(p: Old) {
    await run(db(), 'PRAGMA ignore_check_constraints = ON');
    await run(db(), 'DROP TRIGGER IF EXISTS wallet_provider_generation_insert_guard');
    await run(db(), 'PRAGMA defer_foreign_keys = ON');
    await run(
      db(),
      `INSERT INTO wallet_provider_instances (id, pass_id, org_id, mode, provider, credential_generation, lifecycle,
         desired_version, created_at, updated_at) VALUES (?, ?, ?, 'live', 'google', ?, 'active', 1, 1, 1)`,
      [kit.fx.ids.id(), p.id, p.orgId, p.credentialGeneration],
    );
  }

  it('plans a pass with a live Google or Samsung copy as moving: the replacement is offered a new copy', async () => {
    const { org, passes } = await orgWithPasses(kit, 2);
    await seedWalletCopy(passes[0] as Old);
    expect(await countCandidates(db(), org.id, 'platform')).toMatchObject({
      passes: 2,
      kept: {},
    });
    const planned = await candidates(db(), {
      orgId: org.id,
      identityId: 'platform',
      after: '',
      limit: 10,
    });
    expect(planned.map((c) => c.reason)).toEqual([null, null]);
  });

  it('re-checks at the void: a pass that gained something uncarriable stays, and so does the replacement a device holds', async () => {
    const { org, old, next } = await movedWith();
    await run(
      db(),
      "INSERT INTO connections (id, org_id, connector_type, name, created_at, updated_at) VALUES ('c1', ?, 'x', 'c', 1, 1)",
      [org.id],
    );
    await run(db(), "UPDATE passes SET connection_id = 'c1', external_ref = 'r1' WHERE id = ?", [
      old.id,
    ]);
    await completeMove(next);
    expect((await passOf(kit, old.id)).status).toBe('active');
    expect((await passOf(kit, next.id)).status).toBe('active');
    expect(await moveOf(kit, old.id)).toMatchObject({ state: 'kept_both', reason: 'connection' });
  });
});

describe('M2: a replaced pass', () => {
  it('records replaced_by and emits pass.replaced to the webhook feed', async () => {
    const { old, next } = await movedWith();
    expect(await moveOf(kit, old.id)).toMatchObject({ replaced_by: null });
    await completeMove(next);
    const row = await moveOf(kit, old.id);
    expect(row).toMatchObject({ state: 'voided', replaced_by: next.id });
    expect(row.replaced_at).not.toBeNull();
    expect(
      await all(db(), "SELECT data FROM pass_events WHERE pass_id = ? AND kind = 'pass.replaced'", [
        old.id,
      ]),
    ).toEqual([{ data: JSON.stringify({ replacedBy: next.id }) }]);
    expect(
      await all(db(), "SELECT type FROM event_feed WHERE pass_id = ? AND type = 'pass.replaced'", [
        old.id,
      ]),
    ).toHaveLength(1);
  });

  it('moves a non-unique externalId with the pass: never on two active passes', async () => {
    const { org, passes } = await orgWithPasses(kit, 1);
    const old = passes[0] as Old;
    await run(db(), "UPDATE passes SET external_id = 'EXT-9' WHERE id = ?", [old.id]);
    await startAndRun(kit, org.id);
    const next = await replacement(kit, old);
    await kit.device(old, 'dev-1', 'o'.repeat(64));
    const active = () =>
      all<{ id: string }>(
        db(),
        "SELECT id FROM passes WHERE external_id = 'EXT-9' AND status = 'active'",
      );
    expect((await moveOf(kit, old.id)).reason).toBeNull();
    expect(await active()).toEqual([{ id: old.id }]);
    await completeMove(next);
    expect(await active()).toEqual([{ id: next.id }]);
    expect((await passOf(kit, old.id)).externalId).toBeNull();
  });
});
