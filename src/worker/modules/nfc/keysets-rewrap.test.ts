import { beforeAll, describe, expect, it } from 'vitest';
import { loadKekRing } from '../../platform/crypto.ts';
import { first, run } from '../../platform/db.ts';
import type { AppEnv } from '../../platform/env.ts';
import { createLogger } from '../../platform/log.ts';
import { createJobContext, type ServiceContext } from '../../platform/service-context.ts';
import { rewrapEnvelopes } from '../keys/rewrap.ts';
import { openTagKey, sealTagKey } from './keyset-seal.ts';
import { createKeyset, rotateKeyset, verifyingKeys } from './keysets.ts';
import { keysetFixture } from './keysets-test-fixtures.ts';
import { keysetById } from './repo-keysets.ts';
import { tagRef } from './tag-ref.ts';

let f: Awaited<ReturnType<typeof keysetFixture>>;
beforeAll(async () => {
  f = await keysetFixture();
});

const kek2 = btoa(String.fromCharCode(...new Uint8Array(32).fill(2)));
type Line = { code?: string; unreadable?: number };
const hex = (b: ArrayBuffer | undefined) => Buffer.from(new Uint8Array(b ?? [])).toString('hex');
const COLUMNS = 'kek_version, iv, wrapped_dek, ciphertext';
type Stored = {
  kek_version: number;
  iv: ArrayBuffer;
  wrapped_dek: ArrayBuffer;
  ciphertext: ArrayBuffer;
};

async function sweep(env: AppEnv): Promise<Line[]> {
  const out: Line[] = [];
  for (let i = 0; i < 40; i++) {
    const lines: Line[] = [];
    const log = createLogger({}, { sink: (line) => lines.push(JSON.parse(line) as Line) });
    await rewrapEnvelopes(createJobContext(env, 'test', { clock: f.kit.clock, log }));
    out.push(...lines);
    if (lines.some((l) => l.code === 'KEK_REWRAP_DONE')) return out;
  }
  throw new Error('The rewrap did not finish.');
}

describe('cron keys.rewrap over Secure tag keys', () => {
  it('moves keyset versions and per-tag keys to the new KEK, keeps iv and ciphertext, and they open under it alone', async () => {
    const db = f.kit.env.DB;
    const t = await f.org();
    const authority = await t.admin.authority();
    // Own keys per tag belong to a per-tag keyset.
    const made = await createKeyset(f.kit.ctx, authority, {
      name: 'Badges',
      perTag: true,
      metaKey: 'a1'.repeat(16),
    });
    await rotateKeyset(f.kit.ctx, authority, made.id, { metaKey: 'b2'.repeat(16) });
    const keyset = await keysetById(db, made.id);
    if (!keyset) throw new Error('No keyset.');
    const before = await verifyingKeys(f.kit.ctx, keyset);
    expect(before).toHaveLength(2);

    const { ref, hint } = await tagRef(f.kit.env, t.org.id, 'live', f.nextUid());
    await run(
      db,
      "INSERT INTO nfc_tags (id, org_id, mode, tag_ref, system, hint, created_at) VALUES ('sun-rw', ?, 'live', ?, 'sun', ?, 1)",
      [t.org.id, ref, hint],
    );
    const scope = { orgId: t.org.id, mode: 'live', keysetId: made.id } as const;
    const tagKey = new Uint8Array(16).map((_, i) => i + 50);
    const e = await sealTagKey(await loadKekRing(f.kit.env), scope, 'sun-rw', tagKey);
    await run(
      db,
      `INSERT INTO nfc_tag_sun (tag_id, keyset_id, key_version, kek_version, iv, wrapped_dek, ciphertext, ctr, ctr_at)
       VALUES ('sun-rw', ?, 2, ?, ?, ?, ?, 0, 1)`,
      [made.id, e.kekVersion, e.iv, e.wrappedDek, e.ciphertext],
    );
    const read = async () => ({
      keys: (await all(db)).sort((a, b) => a.wrapped_dek.byteLength - b.wrapped_dek.byteLength),
      tag: await first<Stored>(db, `SELECT ${COLUMNS} FROM nfc_tag_sun WHERE tag_id = 'sun-rw'`),
    });
    const all = async (d: D1Database) =>
      (
        await d
          .prepare(`SELECT ${COLUMNS} FROM nfc_tag_keys WHERE keyset_id = ?`)
          .bind(made.id)
          .all<Stored>()
      ).results;
    const was = await read();
    expect(was.keys.every((k) => k.kek_version === 1)).toBe(true);

    const v2 = { ...f.kit.env, KEK_V2: kek2 } as AppEnv;
    const lines = await sweep(v2);
    expect(lines.find((l) => l.code === 'KEK_REWRAP_DONE')?.unreadable).toBe(0);

    const now = await read();
    expect(now.keys).toHaveLength(2);
    for (const k of now.keys) expect(k.kek_version).toBe(2);
    expect(now.tag?.kek_version).toBe(2);
    // Only the DEK wrapping moved.
    const byIv = (rows: Stored[]) => new Map(rows.map((r) => [hex(r.iv), r]));
    for (const [iv, k] of byIv(now.keys)) {
      const old = byIv(was.keys).get(iv);
      expect(hex(k.ciphertext)).toBe(hex(old?.ciphertext));
      expect(hex(k.wrapped_dek)).not.toBe(hex(old?.wrapped_dek));
    }
    expect(hex(now.tag?.ciphertext)).toBe(hex(was.tag?.ciphertext));
    expect(hex(now.tag?.wrapped_dek)).not.toBe(hex(was.tag?.wrapped_dek));

    // With KEK_V1 gone everything still opens, to the same keys.
    const only2 = { ...f.kit.env, KEK_V1: undefined, KEK_V2: kek2 } as AppEnv;
    const ctx2: ServiceContext = { ...f.kit.ctx, env: only2 };
    const after = await verifyingKeys(ctx2, keyset);
    expect(after.map((k) => [k.version, [...k.metaKey], [...k.fileKey]])).toEqual(
      before.map((k) => [k.version, [...k.metaKey], [...k.fileKey]]),
    );
    const stored = now.tag;
    if (!stored) throw new Error('No per-tag key.');
    const opened = await openTagKey(await loadKekRing(only2), scope, 'sun-rw', {
      kekVersion: stored.kek_version,
      iv: new Uint8Array(stored.iv),
      wrappedDek: new Uint8Array(stored.wrapped_dek),
      ciphertext: new Uint8Array(stored.ciphertext),
    });
    expect(opened).toEqual(tagKey);
  });
});
