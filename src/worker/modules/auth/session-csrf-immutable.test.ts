import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import { fixtures, makeOrg, makeScanner, makeUser } from '../../../../test/helpers/index.ts';
import { ManualClock } from '../../platform/clock.ts';
import { first, run } from '../../platform/db.ts';
import type { AppEnv } from '../../platform/env.ts';

describe('session CSRF secret immutability', () => {
  it('requires a new session for rotation while allowing ordinary updates', async () => {
    const e = env as AppEnv;
    const user = await makeUser(fixtures(e, new ManualClock(Date.now())));
    const id = `csrf-immutable-${user.id}`;
    await run(
      e.DB,
      `INSERT INTO sessions (id_hash, user_id, amr, csrf_secret, created_at, last_seen_at,
         idle_expires_at, expires_at) VALUES (?, ?, 'oidc', ?, 1, 1, 2, 3)`,
      [id, user.id, 'original'],
    );
    await expect(
      run(e.DB, 'UPDATE sessions SET csrf_secret = ? WHERE id_hash = ?', ['rotated', id]),
    ).rejects.toThrow('session csrf secret is immutable');
    await expect(
      run(e.DB, 'UPDATE sessions SET csrf_secret = csrf_secret WHERE id_hash = ?', [id]),
    ).rejects.toThrow('session csrf secret is immutable');
    await expect(
      run(e.DB, 'UPDATE sessions SET csrf_secret = ?, last_seen_at = ? WHERE id_hash = ?', [
        'rotated',
        99,
        id,
      ]),
    ).rejects.toThrow('session csrf secret is immutable');
    expect(
      await first(e.DB, 'SELECT csrf_secret, last_seen_at FROM sessions WHERE id_hash = ?', [id]),
    ).toEqual({ csrf_secret: 'original', last_seen_at: 1 });

    await run(e.DB, 'UPDATE sessions SET last_seen_at = ?, idle_expires_at = ? WHERE id_hash = ?', [
      2,
      3,
      id,
    ]);
    expect(
      await first(
        e.DB,
        'SELECT csrf_secret, last_seen_at, idle_expires_at, expires_at FROM sessions WHERE id_hash = ?',
        [id],
      ),
    ).toEqual({ csrf_secret: 'original', last_seen_at: 2, idle_expires_at: 3, expires_at: 3 });

    const rotatedId = `${id}-rotated`;
    await run(
      e.DB,
      `INSERT INTO sessions (id_hash, user_id, amr, csrf_secret, created_at, last_seen_at,
         idle_expires_at, expires_at) VALUES (?, ?, 'oidc', ?, 1, 1, 2, 3)`,
      [rotatedId, user.id, 'rotated'],
    );
    expect(
      await first(e.DB, 'SELECT csrf_secret FROM sessions WHERE id_hash = ?', [rotatedId]),
    ).toEqual({ csrf_secret: 'rotated' });
  });

  it('keeps session identity and absolute expiry fixed while allowing revocation', async () => {
    const e = env as AppEnv;
    const f = fixtures(e, new ManualClock(Date.now()));
    const user = await makeUser(f);
    const other = await makeUser(f);
    const id = `session-authority-${user.id}`;
    await run(
      e.DB,
      `INSERT INTO sessions
      (id_hash, user_id, amr, csrf_secret, created_at, last_seen_at, idle_expires_at, expires_at)
      VALUES (?, ?, 'oidc', 'secret', 1, 1, 2, 3)`,
      [id, user.id],
    );
    await expect(
      run(
        e.DB,
        `INSERT OR REPLACE INTO sessions
      (id_hash, user_id, amr, csrf_secret, created_at, last_seen_at, idle_expires_at, expires_at)
      VALUES (?, ?, 'oidc', 'secret', 1, 1, 2, 3)`,
        [id, user.id],
      ),
    ).rejects.toThrow('UNIQUE constraint failed: sessions.id_hash');
    for (const [column, value] of [
      ['id_hash', `${id}-other`],
      ['user_id', other.id],
      ['created_at', 2],
      ['expires_at', 4],
    ] as const) {
      await expect(
        run(e.DB, `UPDATE sessions SET ${column} = ? WHERE id_hash = ?`, [value, id]),
      ).rejects.toThrow('session authority is immutable');
      await run(e.DB, `UPDATE sessions SET ${column} = ${column} WHERE id_hash = ?`, [id]);
    }
    await run(e.DB, 'UPDATE sessions SET revoked_at = ? WHERE id_hash = ?', [4, id]);
    expect(await first(e.DB, 'SELECT revoked_at FROM sessions WHERE id_hash = ?', [id])).toEqual({
      revoked_at: 4,
    });
  });

  it('permanently retires IDs on deletion and user cascade', async () => {
    const e = env as AppEnv;
    const f = fixtures(e, new ManualClock(Date.now()));
    const user = await makeUser(f);
    const survivingUser = await makeUser(f);
    const directId = `direct-retired-${user.id}`;
    const cascadeId = `cascade-retired-${user.id}`;
    for (const id of [directId, cascadeId]) {
      await run(
        e.DB,
        `INSERT INTO sessions
        (id_hash, user_id, amr, csrf_secret, created_at, last_seen_at, idle_expires_at, expires_at)
        VALUES (?, ?, 'oidc', 'secret', 1, 1, 2, 3)`,
        [id, user.id],
      );
    }
    await run(e.DB, 'DELETE FROM sessions WHERE id_hash = ?', [directId]);
    await run(e.DB, 'DELETE FROM users WHERE id = ?', [user.id]);
    for (const id of [directId, cascadeId]) {
      expect(
        await first(e.DB, 'SELECT id_hash FROM retired_session_ids WHERE id_hash = ?', [id]),
      ).toEqual({ id_hash: id });
      await expect(
        run(
          e.DB,
          `INSERT OR REPLACE INTO sessions
        (id_hash, user_id, amr, csrf_secret, created_at, last_seen_at, idle_expires_at, expires_at)
        VALUES (?, ?, 'oidc', 'different', 1, 1, 2, 3)`,
          [id, survivingUser.id],
        ),
      ).rejects.toThrow('session ID is retired');
      await expect(
        run(e.DB, 'DELETE FROM retired_session_ids WHERE id_hash = ?', [id]),
      ).rejects.toThrow('retired session ID is immutable');
      await expect(
        run(e.DB, 'UPDATE retired_session_ids SET id_hash = ? WHERE id_hash = ?', [
          `${id}-new`,
          id,
        ]),
      ).rejects.toThrow('retired session ID is immutable');
      await expect(
        run(e.DB, 'INSERT OR REPLACE INTO retired_session_ids (id_hash) VALUES (?)', [id]),
      ).rejects.toThrow('retired session ID is immutable');
    }
  });

  it('requires scanner credential changes to advance a monotonic revision', async () => {
    const e = env as AppEnv;
    const f = fixtures(e, new ManualClock(Date.now()));
    const org = await makeOrg(f);
    const scanner = await makeScanner(f, { orgId: org.id });
    for (const [column, value] of [
      ['csrf_secret', 'different-secret'],
      ['token_hash', 'different-hash'],
      ['token_prefix', `different-${scanner.id}`],
    ] as const) {
      await expect(
        run(e.DB, `UPDATE scanners SET ${column} = ? WHERE id = ?`, [value, scanner.id]),
      ).rejects.toThrow('scanner credential revision must advance');
      await run(
        e.DB,
        `UPDATE scanners SET ${column} = ?, updated_at = updated_at + 1 WHERE id = ?`,
        [value, scanner.id],
      );
    }
    await expect(
      run(e.DB, 'UPDATE scanners SET updated_at = updated_at - 1 WHERE id = ?', [scanner.id]),
    ).rejects.toThrow('scanner credential revision must advance');
    await run(e.DB, 'UPDATE scanners SET last_seen_at = ? WHERE id = ?', [42, scanner.id]);
    await expect(
      run(
        e.DB,
        `INSERT OR REPLACE INTO scanners
      (id, org_id, mode, kind, device_role, name, settings, time_zone, created_at, updated_at)
      SELECT id, org_id, mode, kind, device_role, name, settings, time_zone, created_at, 0
      FROM scanners WHERE id = ?`,
        [scanner.id],
      ),
    ).rejects.toThrow('UNIQUE constraint failed: scanners.id');
    await run(e.DB, 'UPDATE scanners SET pair_code_hash = ? WHERE id = ?', [
      `pair-${scanner.id}`,
      scanner.id,
    ]);
    for (const [field, value, error] of [
      ['token_prefix', `different-${scanner.id}`, 'scanners.token_prefix'],
      ['pair_code_hash', `pair-${scanner.id}`, 'scanners.pair_code_hash'],
    ] as const) {
      await expect(
        run(
          e.DB,
          `INSERT OR REPLACE INTO scanners
        (id, org_id, mode, kind, device_role, name, settings, time_zone, created_at, updated_at,
         ${field}, token_hash)
        SELECT ?, org_id, mode, kind, device_role, ?, settings, time_zone, created_at, 0,
          ?, ${field === 'token_prefix' ? "'other-hash'" : 'NULL'}
        FROM scanners WHERE id = ?`,
          [`new-${field}-${scanner.id}`, `new-${field}`, value, scanner.id],
        ),
      ).rejects.toThrow(`UNIQUE constraint failed: ${error}`);
    }
    await expect(
      run(
        e.DB,
        `INSERT OR REPLACE INTO scanners
      (id, org_id, mode, kind, device_role, name, settings, time_zone, created_at, updated_at)
      SELECT ?, org_id, mode, kind, device_role, UPPER(name), settings, time_zone, created_at, 0
      FROM scanners WHERE id = ?`,
        [`new-name-${scanner.id}`, scanner.id],
      ),
    ).rejects.toThrow('UNIQUE constraint failed: scanners.org_id, scanners.mode, scanners.name');
    const other = await makeScanner(f, { orgId: org.id });
    await expect(
      run(e.DB, 'UPDATE OR REPLACE scanners SET pair_code_hash = ? WHERE id = ?', [
        `pair-${scanner.id}`,
        other.id,
      ]),
    ).rejects.toThrow('UNIQUE constraint failed: scanners.pair_code_hash');
    expect(await first(e.DB, 'SELECT id FROM scanners WHERE id = ?', [scanner.id])).toEqual({
      id: scanner.id,
    });
  });

  it('permanently retires scanner IDs after deletion or organization cascade', async () => {
    const e = env as AppEnv;
    const f = fixtures(e, new ManualClock(Date.now()));
    const org = await makeOrg(f);
    const survivingOrg = await makeOrg(f);
    const direct = await makeScanner(f, { orgId: org.id });
    const cascade = await makeScanner(f, { orgId: org.id });
    await expect(
      run(e.DB, 'UPDATE scanners SET id = ? WHERE id = ?', [`new-${direct.id}`, direct.id]),
    ).rejects.toThrow('scanner ID is immutable');
    await run(e.DB, 'DELETE FROM scanners WHERE id = ?', [direct.id]);
    await run(e.DB, 'DELETE FROM orgs WHERE id = ?', [org.id]);
    for (const id of [direct.id, cascade.id]) {
      expect(await first(e.DB, 'SELECT id FROM retired_scanner_ids WHERE id = ?', [id])).toEqual({
        id,
      });
      await expect(
        run(
          e.DB,
          `INSERT OR REPLACE INTO scanners
        (id, org_id, mode, kind, device_role, name, settings, time_zone, created_at, updated_at)
        VALUES (?, ?, 'live', 'device', 'scan', ?, '{}', 'UTC', 1, 1)`,
          [id, survivingOrg.id, id],
        ),
      ).rejects.toThrow('scanner ID is retired');
      await expect(run(e.DB, 'DELETE FROM retired_scanner_ids WHERE id = ?', [id])).rejects.toThrow(
        'retired scanner ID is immutable',
      );
      await expect(
        run(e.DB, 'UPDATE retired_scanner_ids SET id = ? WHERE id = ?', [`new-${id}`, id]),
      ).rejects.toThrow('retired scanner ID is immutable');
      await expect(
        run(e.DB, 'INSERT OR REPLACE INTO retired_scanner_ids (id) VALUES (?)', [id]),
      ).rejects.toThrow('retired scanner ID is immutable');
    }
  });
});
