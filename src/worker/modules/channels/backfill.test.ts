import { describe, expect, it } from 'vitest';
import migration from '../../../../migrations/0109_channels.sql?raw';
import { all, run } from '../../platform/db.ts';
import { setupKit } from '../passes/pass-test-fixtures.ts';

/** The statements between the backfill markers: what an existing database runs once. */
const BACKFILL = (/-- backfill:begin\n([\s\S]*?)-- backfill:end/.exec(migration)?.[1] ?? '')
  .split(/;\s*\n/)
  .map((statement) => statement.replace(/^--.*\n/gm, '').trim())
  .filter(Boolean);

describe('pass_channel_copies backfill', () => {
  it('derives Apple and provider copies from evidence that existed before channels', async () => {
    const kit = await setupKit();
    const registered = await kit.pass();
    const downloaded = await kit.pass();
    const instanced = await kit.pass();
    const untouched = await kit.pass();
    const db = kit.env.DB;
    const identity = registered.identityId;
    await run(
      db,
      'INSERT INTO devices (device_id, identity_id, push_token, updated_at) VALUES (?, ?, ?, ?)',
      ['d1', identity, 'ab'.repeat(32), 1],
    );
    await run(
      db,
      'INSERT INTO registrations (device_id, identity_id, pass_id, created_at) VALUES (?, ?, ?, ?)',
      ['d1', identity, registered.id, 500],
    );
    for (const at of [900, 700])
      await run(
        db,
        "INSERT INTO pass_events (id, org_id, pass_id, mode, kind, data, at) VALUES (?, ?, ?, ?, 'pass.downloaded', '{}', ?)",
        [`ev-${at}`, downloaded.orgId, downloaded.id, downloaded.mode, at],
      );
    // A provider instance that was offered; the table's foreign keys name accounts this test omits.
    // Provider issuance is closed today, so no real instance can be inserted: a stand-in table with
    // the columns the backfill reads takes the real one's name for the run.
    await run(db, 'ALTER TABLE wallet_provider_instances RENAME TO wpi_real');
    await run(
      db,
      `CREATE TABLE wallet_provider_instances (id TEXT PRIMARY KEY, pass_id TEXT, provider TEXT,
         lifecycle TEXT, retirement_reason TEXT, created_at INTEGER)`,
    );
    for (const [id, pass, provider, lifecycle, at] of [
      ['i1', instanced.id, 'google', 'active', 300],
      ['i2', instanced.id, 'google', 'revoked', 200],
      ['i3', untouched.id, 'samsung', 'blocked', 100],
    ] as const)
      await run(
        db,
        'INSERT INTO wallet_provider_instances (id, pass_id, provider, lifecycle, created_at) VALUES (?, ?, ?, ?, ?)',
        [id, pass, provider, lifecycle, at],
      );

    for (const sql of BACKFILL) await run(db, sql);
    for (const sql of BACKFILL) await run(db, sql);

    await run(db, 'DROP TABLE wallet_provider_instances');
    await run(db, 'ALTER TABLE wpi_real RENAME TO wallet_provider_instances');

    const rows = await all<{ pass_id: string; channel: string; copy_at: number }>(
      db,
      'SELECT pass_id, channel, copy_at FROM pass_channel_copies ORDER BY pass_id, channel',
    );
    const by = (id: string) =>
      rows.filter((r) => r.pass_id === id).map((r) => [r.channel, r.copy_at]);
    expect(by(registered.id)).toEqual([['apple', 500]]);
    expect(by(downloaded.id)).toEqual([['apple', 700]]);
    expect(by(instanced.id)).toEqual([['google', 200]]);
    expect(by(untouched.id)).toEqual([]);
  });
});
