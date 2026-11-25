import { beforeAll, describe, expect, it } from 'vitest';
import { jobGrant } from '../../platform/authority.ts';
import { all, first, run } from '../../platform/db.ts';
import { createJobContext } from '../../platform/service-context.ts';
import { sunKeyset } from '../scan/sun-test-fixtures.ts';
import { tagFixture } from './tags-test-fixtures.ts';

// 0210: the program row's rules live in the database, so a bug in the service cannot lose keys or skip a state.
let f: Awaited<ReturnType<typeof tagFixture>>;
let org: string;
let keyset: string;
beforeAll(async () => {
  f = await tagFixture();
  org = (await f.org()).org.id;
  keyset = (await sunKeyset(f.kit, org, { perTag: true })).id;
  await run(f.kit.env.DB, 'UPDATE nfc_tag_keysets SET programmable = 1 WHERE id = ?', [keyset]);
});
const db = () => f.kit.env.DB;

type V = string | number | null | Uint8Array;
const blob = (n: number, byte = 7) => new Uint8Array(n).fill(byte);
const sealed = (cipher: number, prefix = ''): Record<string, V> => ({
  [`${prefix}kek_version`]: 1,
  [`${prefix}iv`]: blob(12),
  [`${prefix}wrapped_dek`]: blob(60),
  [`${prefix}ciphertext`]: blob(cipher),
});
const DAY = 86_400_000;
let n = 0;
const ref = () => (++n).toString(16).padStart(64, '0');

async function insert(over: Record<string, V> = {}) {
  const id = `p${++n}`;
  const row: Record<string, V> = {
    id,
    org_id: org,
    mode: 'live',
    keyset_id: keyset,
    key_version: 1,
    tag_ref: ref(),
    hint: 'ABCD',
    actor_type: 'scanner',
    actor_key: 'scanner:s1',
    purpose: 'blank',
    state: 'started',
    step: 'auth',
    attempts: 1,
    ...sealed(32 + 16 + 16 + 2, 'sess_'),
    created_at: 1000,
    updated_at: 1000,
    expires_at: 61000,
    ...over,
  };
  const cols = Object.keys(row);
  await run(
    db(),
    `INSERT INTO nfc_tag_programs (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`,
    Object.values(row),
  );
  return id;
}
const update = (id: string, set: Record<string, V>) =>
  run(
    db(),
    `UPDATE nfc_tag_programs SET ${Object.keys(set)
      .map((c) => `${c} = ?`)
      .join(', ')} WHERE id = ?`,
    [...Object.values(set), id],
  );
const NO_SESSION = {
  sess_kek_version: null,
  sess_iv: null,
  sess_wrapped_dek: null,
  sess_ciphertext: null,
};
const KEYS = sealed(96);

describe('inserting a program', () => {
  it('takes a started row on a programmable per-tag keyset, once per tag', async () => {
    const tagRef = ref();
    await insert({ tag_ref: tagRef });
    await expect(insert({ tag_ref: tagRef })).rejects.toThrow(/UNIQUE/);
    await expect(insert({ state: 'scripted', step: 'result', ...KEYS })).rejects.toThrow(
      /program_state/,
    );
    await expect(insert({ attempts: 2 })).rejects.toThrow(/program_state/);
    await expect(insert({ key_version: 9 })).rejects.toThrow(/program_keyset/);
  });

  it('refuses a keyset that is not programmable, and another tenant', async () => {
    const other = (await f.org()).org.id;
    const plain = (await sunKeyset(f.kit, org, { perTag: true })).id;
    await expect(insert({ keyset_id: plain })).rejects.toThrow(/program_keyset/);
    await expect(insert({ org_id: other })).rejects.toThrow(/program_keyset/);
    await expect(
      run(db(), 'UPDATE nfc_tag_keysets SET programmable = 1 WHERE id = ?', [
        (await sunKeyset(f.kit, org, { perTag: false })).id,
      ]),
    ).rejects.toThrow(/keyset_programmable/);
  });

  it('refuses a tag the org already has', async () => {
    const tagRef = ref();
    await run(
      db(),
      "INSERT INTO nfc_tags (id, org_id, mode, tag_ref, system, hint, created_at) VALUES (?, ?, 'live', ?, 'uid', 'AAAA', 1)",
      [`t${++n}`, org, tagRef],
    );
    await expect(insert({ tag_ref: tagRef })).rejects.toThrow(/program_known/);
  });
});

describe('the state compare-and-set', () => {
  it('moves along the allowed edges only, and a scripted row needs its keys', async () => {
    const id = await insert();
    await expect(update(id, { state: 'programmed', step: 'done', ...NO_SESSION })).rejects.toThrow(
      /program_state/,
    );
    await expect(update(id, { state: 'scripted', step: 'result' })).rejects.toThrow(
      /program_keys_fixed|CHECK/,
    );
    await update(id, { state: 'scripted', step: 'result', ...KEYS });
    await update(id, { state: 'interrupted', step: 'auth', ...NO_SESSION });
    await update(id, { state: 'started', step: 'auth', ...sealed(40, 'sess_') });
    await update(id, { state: 'abandoned', step: 'auth', ...NO_SESSION });
    await expect(update(id, { state: 'programmed', step: 'done' })).rejects.toThrow(
      /program_state/,
    );
  });

  it('holds a session only while started or scripted', async () => {
    const id = await insert();
    await expect(update(id, { state: 'failed', step: 'auth' })).rejects.toThrow(/CHECK/);
    await update(id, { state: 'failed', step: 'auth', ...NO_SESSION });
  });

  it('counts attempts up, one at a time, and never lets the expiry go back', async () => {
    const id = await insert();
    await expect(update(id, { attempts: 3 })).rejects.toThrow(/program_attempts/);
    await expect(update(id, { attempts: 0 })).rejects.toThrow(/program_attempts/);
    await update(id, { attempts: 2, expires_at: 70000 });
    await expect(update(id, { expires_at: 60000 })).rejects.toThrow(/program_expiry/);
  });

  it('never changes who, what or where', async () => {
    const id = await insert();
    const sets: Record<string, V>[] = [
      { org_id: 'x' },
      { tag_ref: ref() },
      { keyset_id: 'x' },
      { key_version: 2 },
      { actor_key: 'x' },
      { created_at: 5 },
    ];
    for (const set of sets) await expect(update(id, set)).rejects.toThrow(/program_fixed/);
  });

  it('ends at programmed or reset: no change after', async () => {
    const id = await insert();
    await update(id, { state: 'scripted', step: 'result', ...KEYS });
    const tagRef = (
      await first<{ tag_ref: string }>(db(), 'SELECT tag_ref FROM nfc_tag_programs WHERE id = ?', [
        id,
      ])
    )?.tag_ref;
    await expect(
      update(id, {
        state: 'programmed',
        step: 'done',
        tag_id: 'nope',
        kek_version: null,
        iv: null,
        wrapped_dek: null,
        ciphertext: null,
        ...NO_SESSION,
      }),
    ).rejects.toThrow(/program_state/);
    await run(
      db(),
      "INSERT INTO nfc_tags (id, org_id, mode, tag_ref, system, hint, created_at) VALUES ('tag-end', ?, 'live', ?, 'sun', 'ABCD', 1)",
      [org, tagRef],
    );
    await update(id, {
      state: 'programmed',
      step: 'done',
      tag_id: 'tag-end',
      kek_version: null,
      iv: null,
      wrapped_dek: null,
      ciphertext: null,
      ...NO_SESSION,
    });
    await expect(update(id, { error_code: 'x' })).rejects.toThrow(/program_ended/);
  });
});

describe('the intended envelope', () => {
  it('is set once with scripted, cleared only as the tag is made, and moves only by a rewrap', async () => {
    const id = await insert();
    await expect(update(id, KEYS)).rejects.toThrow(/program_keys_fixed/);
    await update(id, { state: 'scripted', step: 'result', ...KEYS });
    await expect(update(id, { ciphertext: blob(96, 9) })).rejects.toThrow(/program_keys_fixed/);
    await expect(update(id, { iv: blob(12, 9) })).rejects.toThrow(/program_keys_fixed/);
    await expect(
      update(id, { kek_version: null, iv: null, wrapped_dek: null, ciphertext: null }),
    ).rejects.toThrow(/program_keys_fixed|CHECK/);
    await expect(update(id, { kek_version: 2 })).rejects.toThrow(/program_keys_fixed/);
    await update(id, { kek_version: 2, wrapped_dek: blob(60, 9) });
    await expect(update(id, { kek_version: 1, wrapped_dek: blob(60, 7) })).rejects.toThrow(
      /program_keys_fixed/,
    );
  });
});

describe('deleting a program', () => {
  const del = async (id: string) => {
    const job = createJobContext(f.kit.env, 'nfc.programs', { clock: f.kit.clock });
    const g = jobGrant(job, {
      purpose: 'org_mode.job.nfc.programs',
      job: 'nfc.programs',
      orgId: org,
      mode: 'live',
      tables: ['nfc_tag_programs'],
    });
    g.delete('nfc_tag_programs', { where: { id } });
    await g.commit();
  };

  it('keeps a row that holds keys, until it is reset or abandoned and 30 days old, under the job grant', async () => {
    const id = await insert({ updated_at: f.kit.clock.now() });
    await update(id, { state: 'scripted', step: 'result', ...KEYS });
    await expect(run(db(), 'DELETE FROM nfc_tag_programs WHERE id = ?', [id])).rejects.toThrow(
      /program_keys_kept/,
    );
    f.kit.clock.advance(40 * DAY);
    await expect(del(id)).rejects.toThrow(/program_keys_kept/);
    await update(id, { state: 'interrupted', step: 'auth', ...NO_SESSION });
    await update(id, { state: 'abandoned', step: 'auth' });
    await expect(run(db(), 'DELETE FROM nfc_tag_programs WHERE id = ?', [id])).rejects.toThrow(
      /program_keys_kept/,
    );
    await del(id);
    expect(await all(db(), 'SELECT id FROM nfc_tag_programs WHERE id = ?', [id])).toEqual([]);
  });

  it('refuses an abandoned row younger than 30 days even under the grant', async () => {
    const id = await insert({ updated_at: f.kit.clock.now() });
    await update(id, { state: 'scripted', step: 'result', ...KEYS });
    await update(id, { state: 'abandoned', step: 'auth', ...NO_SESSION });
    f.kit.clock.advance(10 * DAY);
    await expect(del(id)).rejects.toThrow(/program_keys_kept/);
  });

  it('lets a row without keys go', async () => {
    const id = await insert();
    await update(id, { state: 'failed', step: 'auth', ...NO_SESSION });
    await run(db(), 'DELETE FROM nfc_tag_programs WHERE id = ?', [id]);
    expect(await all(db(), 'SELECT id FROM nfc_tag_programs WHERE id = ?', [id])).toEqual([]);
  });

  it('goes with its org', async () => {
    const gone = (await f.org()).org.id;
    const ks = (await sunKeyset(f.kit, gone, { perTag: true })).id;
    await run(db(), 'UPDATE nfc_tag_keysets SET programmable = 1 WHERE id = ?', [ks]);
    const id = await insert({ org_id: gone, keyset_id: ks });
    await update(id, { state: 'scripted', step: 'result', ...KEYS });
    await run(db(), 'DELETE FROM orgs WHERE id = ?', [gone]);
    expect(await all(db(), 'SELECT id FROM nfc_tag_programs WHERE id = ?', [id])).toEqual([]);
  });
});
