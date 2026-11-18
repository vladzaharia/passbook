import { describe, expect, it } from 'vitest';
import {
  type Fixtures,
  fixtures,
  makeEnv,
  makeOrg,
  makePass,
  makeTemplate,
  makeUser,
  withoutTrigger,
} from '../../../../test/helpers/index.ts';
import { countQueries } from '../../jobs/query-counter.ts';
import {
  credentialAad,
  decryptSecretText,
  encryptSecret,
  loadKekRing,
} from '../../platform/crypto.ts';
import { all, batch, first, run, stmt } from '../../platform/db.ts';
import type { AppEnv } from '../../platform/env.ts';
import { createLogger } from '../../platform/log.ts';
import { extractMacRoot } from '../../platform/mac-roots.ts';
import { createJobContext } from '../../platform/service-context.ts';
import { openBody, sealBody } from '../sandbox/captured-body.ts';
import { readSystemValue } from '../settings/repo.ts';
import {
  CURSOR,
  DONE,
  READ_BUDGET,
  rewrapEnvelopes,
  UNREADABLE_RETRY_MS,
  WRITE_BATCH,
  WRITE_BUDGET,
} from './rewrap.ts';

const kek = (byte: number) => btoa(String.fromCharCode(...new Uint8Array(32).fill(byte)));
const hex = (b: ArrayBuffer | undefined) => Buffer.from(new Uint8Array(b ?? [])).toString('hex');
type Line = { event: string; code?: string; [k: string]: unknown };

/** A job context over `env`, with the log lines it writes collected. */
function jobOf(env: AppEnv, f: Fixtures) {
  const lines: Line[] = [];
  const log = createLogger({}, { sink: (line) => lines.push(JSON.parse(line) as Line) });
  return { ctx: createJobContext(env, 'test', { clock: f.clock, log }), lines };
}
const codes = (lines: Line[]) => lines.map((l) => l.code);

async function untilDone(env: AppEnv, f: Fixtures, max = 40) {
  const all: Line[] = [];
  for (let i = 0; i < max; i++) {
    const { ctx, lines } = jobOf(env, f);
    await rewrapEnvelopes(ctx);
    all.push(...lines);
    if (codes(lines).includes('KEK_REWRAP_DONE')) return all;
  }
  throw new Error(`the rewrap did not finish: ${JSON.stringify(all.slice(-6))}`);
}

async function setup() {
  const base = await makeEnv({ KEK_V1: kek(1) });
  const f = fixtures(base);
  // D1 storage lasts for the whole file: each case starts without the previous one's sweep state.
  await run(base.DB, "DELETE FROM settings WHERE scope = 'system' AND key IN (?, ?)", [
    CURSOR,
    DONE,
  ]);
  const org = await makeOrg(f);
  const { resolved: template, registry } = makeTemplate();
  const pass = await makePass(f, { orgId: org.id, template, registry });
  const ring1 = await loadKekRing(base);
  const seal = (id: string, orgId: string | null, kind: string, text = 'secret') =>
    encryptSecret(ring1, text, credentialAad(id, orgId, kind));
  const v2 = { ...base, KEK_V2: kek(2) } as AppEnv;
  return { f, org, pass, base, v2, ring1, seal };
}
type Kit = Awaited<ReturnType<typeof setup>>;

async function insertCredential(kit: Kit, id: string, aadId = id, text = 'cred') {
  const e = await kit.seal(aadId, kit.org.id, 'connector', text);
  await run(
    kit.f.env.DB,
    `INSERT INTO credentials (id, org_id, kind, kek_version, iv, wrapped_dek, ciphertext, created_at)
     VALUES (?, ?, 'connector', ?, ?, ?, ?, 1)`,
    [id, kit.org.id, e.kekVersion, e.iv, e.wrappedDek, e.ciphertext],
  );
}

const versions = (db: D1Database, table: string, col = 'kek_version') =>
  all<{ v: number }>(db, `SELECT ${col} AS v FROM ${table}`);

describe('keys.rewrap', () => {
  it('does nothing with one KEK', async () => {
    const kit = await setup();
    const { ctx, lines } = jobOf(kit.base, kit.f);
    await rewrapEnvelopes(ctx);
    expect(lines).toEqual([]);
    expect(await readSystemValue(kit.f.env.DB, CURSOR)).toBeNull();
  });

  it('moves seals, credentials and captured emails to the new KEK and keeps the DEK, iv and ciphertext', async () => {
    const kit = await setup();
    const db = kit.f.env.DB;
    await insertCredential(kit, 'cred-a');
    const cap = kit.f.ids.id();
    await run(
      db,
      `INSERT INTO captured_emails (id, org_id, pass_id, recipient, subject, html, text, created_at)
       VALUES (?, ?, ?, 'a@example.com', 's', ?, ?, 1)`,
      [
        cap,
        kit.org.id,
        kit.pass.id,
        await sealBody(kit.base, cap, kit.org.id, '<p>html</p>'),
        await sealBody(kit.base, cap, kit.org.id, 'plain'),
      ],
    );
    const before = await first<{
      iv: ArrayBuffer;
      ciphertext: ArrayBuffer;
      wrapped_dek: ArrayBuffer;
    }>(db, "SELECT iv, ciphertext, wrapped_dek FROM credentials WHERE id = 'cred-a'");
    const seals = await first<{ n: number }>(db, 'SELECT count(*) AS n FROM pass_token_seals');
    expect(seals?.n).toBeGreaterThan(0);

    const lines = await untilDone(kit.v2, kit.f);
    expect(codes(lines)).toContain('KEK_REWRAP_RESWEEP');

    const after = await first<{
      iv: ArrayBuffer;
      ciphertext: ArrayBuffer;
      wrapped_dek: ArrayBuffer;
      kek_version: number;
    }>(db, "SELECT kek_version, iv, wrapped_dek, ciphertext FROM credentials WHERE id = 'cred-a'");
    expect(after?.kek_version).toBe(2);
    expect(hex(after?.iv)).toEqual(hex(before?.iv));
    expect(hex(after?.ciphertext)).toEqual(hex(before?.ciphertext));
    expect(hex(after?.wrapped_dek)).not.toEqual(hex(before?.wrapped_dek));
    for (const table of ['pass_token_seals', 'pass_auth_seals', 'credentials'])
      expect(
        (await versions(db, table)).every((r) => r.v === 2),
        table,
      ).toBe(true);

    // With KEK_V1 gone, everything still opens: it is wrapped under V2.
    const only2 = { ...kit.base, KEK_V1: undefined, KEK_V2: kek(2) } as AppEnv;
    const ring2 = await loadKekRing(only2);
    const row = await first<{ iv: ArrayBuffer; wrapped_dek: ArrayBuffer; ciphertext: ArrayBuffer }>(
      db,
      "SELECT iv, wrapped_dek, ciphertext FROM credentials WHERE id = 'cred-a'",
    );
    expect(
      await decryptSecretText(
        ring2,
        {
          kekVersion: 2,
          iv: new Uint8Array(row?.iv ?? []),
          wrappedDek: new Uint8Array(row?.wrapped_dek ?? []),
          ciphertext: new Uint8Array(row?.ciphertext ?? []),
        },
        credentialAad('cred-a', kit.org.id, 'connector'),
      ),
    ).toBe('cred');
    const stored = await first<{ html: string; text: string }>(
      db,
      'SELECT html, text FROM captured_emails WHERE id = ?',
      [cap],
    );
    expect(stored?.html.startsWith('enc1:2.')).toBe(true);
    expect(stored?.text.startsWith('enc1:2.')).toBe(true);
    expect(await openBody(only2, cap, kit.org.id, stored?.html ?? '')).toBe('<p>html</p>');
    expect(await openBody(only2, cap, kit.org.id, stored?.text ?? '')).toBe('plain');
  });

  it('is done after a clean sweep, and a later run then costs one read', async () => {
    const kit = await setup();
    await untilDone(kit.v2, kit.f);
    const done = (await readSystemValue(kit.f.env.DB, DONE)) as {
      stamp: string;
      unreadable: number;
    };
    expect(done).toMatchObject({ stamp: '1>2', unreadable: 0 });
    const counted = countQueries(kit.v2);
    const { ctx, lines } = jobOf(counted.env, kit.f);
    await rewrapEnvelopes(ctx);
    expect(counted.count()).toBe(1);
    expect(lines).toEqual([]);
  });

  it('stays within its budget: a run reads and writes at most the capped number of times', async () => {
    const kit = await setup();
    const db = kit.f.env.DB;
    const rows = 260;
    for (let i = 0; i < rows; i += 50) {
      const part = await Promise.all(
        Array.from({ length: Math.min(50, rows - i) }, async (_, j) => {
          const id = `bulk-${String(i + j).padStart(4, '0')}`;
          const e = await kit.seal(id, kit.org.id, 'connector');
          return stmt(
            db,
            `INSERT INTO credentials (id, org_id, kind, kek_version, iv, wrapped_dek, ciphertext, created_at)
             VALUES (?, ?, 'connector', 1, ?, ?, ?, 1)`,
            [id, kit.org.id, e.iv, e.wrappedDek, e.ciphertext],
          );
        }),
      );
      await batch(db, part);
    }
    const counted = countQueries(kit.v2);
    const { ctx } = jobOf(counted.env, kit.f);
    await rewrapEnvelopes(ctx);
    // cursor + done reads, then at most READ_BUDGET reads, WRITE_BUDGET batches and the cursor write.
    expect(counted.count()).toBeLessThanOrEqual(2 + READ_BUDGET + WRITE_BUDGET + 1);
    const moved = await first<{ n: number }>(
      db,
      "SELECT count(*) AS n FROM credentials WHERE kek_version = 2 AND id LIKE 'bulk-%'",
    );
    expect(moved?.n).toBeLessThanOrEqual(WRITE_BUDGET * WRITE_BATCH);
    expect(moved?.n).toBeGreaterThan(0);
    await untilDone(kit.v2, kit.f, 80);
    expect((await versions(db, 'credentials')).every((r) => r.v === 2)).toBe(true);
  });

  it('loses a race to a writer: the new envelope stays and the sweep runs again', async () => {
    const kit = await setup();
    const db = kit.f.env.DB;
    await insertCredential(kit, 'cred-race');
    const ring2 = await loadKekRing(kit.v2);
    let replaced = false;
    const racing = new Proxy(db, {
      get(target, prop) {
        if (prop === 'batch')
          return async (statements: D1PreparedStatement[]) => {
            if (!replaced) {
              replaced = true;
              const fresh = await encryptSecret(
                ring2,
                'rotated',
                credentialAad('cred-race', kit.org.id, 'connector'),
              );
              await run(
                db,
                "UPDATE credentials SET kek_version = 2, iv = ?, wrapped_dek = ?, ciphertext = ? WHERE id = 'cred-race'",
                [fresh.iv, fresh.wrappedDek, fresh.ciphertext],
              );
            }
            return target.batch(statements);
          };
        const value = Reflect.get(target, prop, target);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    const env = Object.assign(Object.create(kit.v2), { ...kit.v2, DB: racing }) as AppEnv;
    const lines = await untilDone(env, kit.f);
    expect(replaced).toBe(true);
    const run1 = lines.find((l) => l.code === 'KEK_REWRAP_RUN' && Number(l.raced) > 0);
    expect(run1).toBeDefined();
    expect(codes(lines)).toContain('KEK_REWRAP_RESWEEP');
    const row = await first<{ iv: ArrayBuffer; wrapped_dek: ArrayBuffer; ciphertext: ArrayBuffer }>(
      db,
      "SELECT iv, wrapped_dek, ciphertext FROM credentials WHERE id = 'cred-race'",
    );
    expect(
      await decryptSecretText(
        ring2,
        {
          kekVersion: 2,
          iv: new Uint8Array(row?.iv ?? []),
          wrappedDek: new Uint8Array(row?.wrapped_dek ?? []),
          ciphertext: new Uint8Array(row?.ciphertext ?? []),
        },
        credentialAad('cred-race', kit.org.id, 'connector'),
      ),
    ).toBe('rotated');
  });

  it('sweeps again for a row an old isolate wrote under the old KEK behind the cursor', async () => {
    const kit = await setup();
    const db = kit.f.env.DB;
    // Seals exist (makePass), so the first sweep moves something and a second one must follow.
    const { ctx } = jobOf(kit.v2, kit.f);
    await rewrapEnvelopes(ctx);
    const cursor = (await readSystemValue(db, CURSOR)) as { table: number };
    expect(cursor.table).toBeGreaterThan(0);
    await insertCredential(kit, 'late-v1');
    const lines = await untilDone(kit.v2, kit.f);
    expect(codes(lines)).toContain('KEK_REWRAP_RESWEEP');
    expect(
      (
        await first<{ kek_version: number }>(
          db,
          "SELECT kek_version FROM credentials WHERE id = 'late-v1'",
        )
      )?.kek_version,
    ).toBe(2);
    expect(((await readSystemValue(db, DONE)) as { stamp: string }).stamp).toBe('1>2');
  });

  it('counts a row that does not open as unreadable, never writes it, and sweeps again hourly', async () => {
    const kit = await setup();
    const db = kit.f.env.DB;
    // Sealed for another id: the AAD does not match this row.
    await insertCredential(kit, 'cred-bad', 'some-other-id');
    const lines = await untilDone(kit.v2, kit.f);
    const warn = lines.find((l) => l.code === 'KEK_REWRAP_UNREADABLE');
    expect(warn).toMatchObject({ table: 'credentials', ids: ['cred-bad'] });
    expect(
      (
        await first<{ kek_version: number }>(
          db,
          "SELECT kek_version FROM credentials WHERE id = 'cred-bad'",
        )
      )?.kek_version,
    ).toBe(1);
    expect(((await readSystemValue(db, DONE)) as { unreadable: number }).unreadable).toBe(1);

    // Before the retry time nothing runs; after it a new sweep reads the row again.
    const still = jobOf(kit.v2, kit.f);
    await rewrapEnvelopes(still.ctx);
    expect(still.lines).toEqual([]);
    kit.f.clock.advance(UNREADABLE_RETRY_MS + 1);
    await run(db, "DELETE FROM credentials WHERE id = 'cred-bad'");
    const retry = await untilDone(kit.v2, kit.f);
    expect(codes(retry)).toContain('KEK_REWRAP_DONE');
    expect(((await readSystemValue(db, DONE)) as { unreadable: number }).unreadable).toBe(0);
  });

  it('skips a capture locked by a forward in flight without aborting the batch', async () => {
    const kit = await setup();
    const db = kit.f.env.DB;
    const user = await makeUser(kit.f);
    const caps = [kit.f.ids.id(), kit.f.ids.id()];
    for (const id of caps)
      await run(
        db,
        `INSERT INTO captured_emails (id, org_id, pass_id, recipient, subject, html, text, created_at)
         VALUES (?, ?, ?, 'a@example.com', 's', ?, ?, 1)`,
        [
          id,
          kit.org.id,
          kit.pass.id,
          await sealBody(kit.base, id, kit.org.id, 'h'),
          await sealBody(kit.base, id, kit.org.id, 't'),
        ],
      );
    await run(
      db,
      `INSERT INTO sandbox_forwards (id, capture_id, org_id, actor_id, email, intent, pass_ids, state, created_at, lease_until)
       VALUES (?, ?, ?, ?, ?, 'i', ?, 'sending', 1, ?)`,
      [
        kit.f.ids.id(),
        caps[0],
        kit.org.id,
        user.id,
        user.primaryEmail,
        JSON.stringify([kit.pass.id]),
        kit.f.clock.now() + 60_000,
      ],
    );
    const { ctx, lines } = jobOf(kit.v2, kit.f);
    for (let i = 0; i < 5; i++) await rewrapEnvelopes(ctx);
    expect(lines.some((l) => l.code === 'KEK_REWRAP_FAILED')).toBe(false);
    const rows = await all<{ id: string; html: string }>(
      db,
      'SELECT id, html FROM captured_emails',
    );
    expect(rows.find((r) => r.id === caps[0])?.html.startsWith('enc1:1.')).toBe(true);
    expect(rows.find((r) => r.id === caps[1])?.html.startsWith('enc1:2.')).toBe(true);
    // The lock lifts and the next sweep moves it.
    await withoutTrigger(db, 'sandbox_forwards_update_guard', () =>
      run(
        db,
        "UPDATE sandbox_forwards SET state = 'expired', lease_until = NULL WHERE capture_id = ?",
        [caps[0]],
      ),
    );
    await untilDone(kit.v2, kit.f);
    const after = await first<{ html: string }>(
      db,
      'SELECT html FROM captured_emails WHERE id = ?',
      [caps[0]],
    );
    expect(after?.html.startsWith('enc1:2.')).toBe(true);
  });

  it('starts over when the ring changes: a third KEK moves everything again', async () => {
    const kit = await setup();
    const db = kit.f.env.DB;
    await untilDone(kit.v2, kit.f);
    const v3 = { ...kit.v2, KEK_V3: kek(3) } as AppEnv;
    const lines = await untilDone(v3, kit.f);
    expect(codes(lines)).toContain('KEK_REWRAP_DONE');
    expect(((await readSystemValue(db, DONE)) as { stamp: string }).stamp).toBe('1,2>3');
    for (const table of ['pass_token_seals', 'pass_auth_seals'])
      expect(
        (await versions(db, table)).every((r) => r.v === 3),
        table,
      ).toBe(true);
    // A swap back to the old pair starts over and finds nothing to move.
    const back = await untilDone(kit.v2, kit.f);
    expect(codes(back)).toContain('KEK_REWRAP_DONE');
  });

  it('records whether MAC_ROOT matches its KEK on every run, and nothing when none is set', async () => {
    const kit = await setup();
    const db = kit.f.env.DB;
    await rewrapEnvelopes(jobOf(kit.v2, kit.f).ctx);
    expect(await readSystemValue(db, 'keys.macRoots')).toBeNull();
    const good = { ...kit.v2, MAC_ROOT_V1: await extractMacRoot(kek(1)) } as AppEnv;
    await rewrapEnvelopes(jobOf(good, kit.f).ctx);
    expect(await readSystemValue(db, 'keys.macRoots')).toEqual({
      '1': 'match',
      at: kit.f.clock.now(),
    });
    const bad = { ...kit.v2, MAC_ROOT_V1: await extractMacRoot(kek(9)) } as AppEnv;
    const { ctx, lines } = jobOf(bad, kit.f);
    await rewrapEnvelopes(ctx);
    expect(await readSystemValue(db, 'keys.macRoots')).toMatchObject({ '1': 'mismatch' });
    expect(codes(lines)).toContain('MAC_ROOT_MISMATCH');
  });
});
