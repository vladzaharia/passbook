import { describe, expect, it } from 'vitest';
import { makeEnv } from '../../../../test/helpers/index.ts';
import { all, run } from '../../platform/db.ts';

// Provider SQL no longer re-checks the singleton per statement; these guards are what keep it fixed.
describe('credential reference keyset singleton guards', () => {
  it('exist and keep the singleton immutable', async () => {
    const { DB: db } = await makeEnv();
    const triggers = await all<{ name: string }>(
      db,
      `SELECT name FROM sqlite_master WHERE type = 'trigger' AND tbl_name = 'credential_ref_keyset'`,
    );
    expect(triggers.map((t) => t.name)).toEqual(
      expect.arrayContaining([
        'credential_ref_keyset_insert_guard',
        'credential_ref_keyset_no_update',
        'credential_ref_keyset_no_delete',
      ]),
    );
    await run(db, 'INSERT OR IGNORE INTO credential_ref_keyset (id, commitment) VALUES (1, ?)', [
      'a'.repeat(64),
    ]);
    await expect(
      run(db, 'UPDATE credential_ref_keyset SET commitment = ? WHERE id = 1', ['b'.repeat(64)]),
    ).rejects.toThrow('immutable');
    await expect(run(db, 'DELETE FROM credential_ref_keyset WHERE id = 1')).rejects.toThrow(
      'immutable',
    );
    await expect(
      run(db, 'INSERT INTO credential_ref_keyset (id, commitment) VALUES (2, ?)', ['c'.repeat(64)]),
    ).rejects.toThrow();
  });
});
