import { describe, expect, it } from 'vitest';
import {
  envA,
  expectKeysetInitializationBlocked,
  installKeysetTestEnv,
} from '../../../../test/helpers/credential-keyset.ts';
import { fixtures, makeOrg } from '../../../../test/helpers/index.ts';
import { first, run } from '../../platform/db.ts';
import { credentialRefKeysetCommitment, ensureCredentialRefKeyset } from './credential-keyset.ts';

const makeEnv = installKeysetTestEnv();

describe.sequential('credential keyset retained references', () => {
  it('fails closed on detached scanner retention proof even without the source event', async () => {
    const f = fixtures(await makeEnv());
    const org = await makeOrg(f);
    const db = f.env.DB;
    const scanId = f.ids.id();
    await run(
      db,
      `INSERT INTO scans
      (id, org_id, mode, actor_type, actor_id, actor_key, idempotency_key, request_hash,
       method, state, outcome, reason, at)
      VALUES (?, ?, 'live', 'scanner', 'legacy', 's:legacy', ?, 'hash',
        'camera', 'done', 'refused', 'not_found', ?)`,
      [scanId, org.id, f.ids.token(), f.clock.now()],
    );
    const trigger = await first<{ sql: string }>(
      db,
      `SELECT sql FROM sqlite_master
      WHERE type = 'trigger' AND name = 'scan_retention_insert_guard'`,
    );
    if (!trigger) throw new Error('Missing retention insert trigger');
    await run(db, 'DROP TRIGGER scan_retention_insert_guard');
    try {
      await run(
        db,
        `INSERT INTO scan_retention_proofs
        (scan_id, org_id, mode, ledger_event_id, pass_ref, event_digest, scan_digest, mac)
        VALUES (?, ?, 'live', 'legacy-event', ?, ?, ?, ?)`,
        [scanId, org.id, 'a'.repeat(64), 'b'.repeat(64), 'c'.repeat(64), 'd'.repeat(64)],
      );
    } finally {
      await run(db, trigger.sql);
    }
    await expectKeysetInitializationBlocked(db);
  });

  it.each([
    [
      'unbound transition',
      `INSERT INTO scan_retention_event_transitions (scan_id, org_id, mode, event_id, pass_ref)
      VALUES (?, ?, 'live', 'legacy-event', ?)`,
      'scan_retention_transition_insert_guard',
      null,
      false,
    ],
    [
      'bound transition',
      `INSERT INTO scan_retention_event_transitions (scan_id, org_id, mode, event_id, pass_ref)
      VALUES (?, ?, 'live', 'legacy-event', ?)`,
      'scan_retention_transition_insert_guard',
      'a'.repeat(64),
      true,
    ],
    [
      'deletion intent',
      `INSERT INTO scan_retention_delete_intents (scan_id, org_id, mode, pass_ref)
      VALUES (?, ?, 'live', ?)`,
      null,
      'a'.repeat(64),
      true,
    ],
    [
      'retained gate',
      `INSERT INTO scan_retained_gates (scan_id, org_id, mode, event_id, pass_ref, state, presence_state)
      VALUES (?, ?, 'live', 'legacy-event', ?, 'in', 'in')`,
      'scan_retained_gates_insert_guard',
      'a'.repeat(64),
      true,
    ],
  ] as const)(
    'handles a legacy %s without any other retained reference',
    async (_description, insertSql, guardName, passRef, blocked) => {
      const f = fixtures(await makeEnv());
      const org = await makeOrg(f);
      const db = f.env.DB;
      const scanId = f.ids.id();
      await run(
        db,
        `INSERT INTO scans
        (id, org_id, mode, actor_type, actor_id, actor_key, idempotency_key, request_hash,
         method, state, outcome, reason, at)
        VALUES (?, ?, 'live', 'scanner', 'legacy', 's:legacy', ?, 'hash',
          'camera', 'done', 'refused', 'not_found', ?)`,
        [scanId, org.id, f.ids.token(), f.clock.now()],
      );
      const trigger = guardName
        ? await first<{ sql: string }>(
            db,
            "SELECT sql FROM sqlite_master WHERE type = 'trigger' AND name = ?",
            [guardName],
          )
        : null;
      if (guardName && !trigger) throw new Error(`Missing ${guardName}`);
      if (guardName) await run(db, `DROP TRIGGER "${guardName}"`);
      try {
        await run(db, insertSql, [scanId, org.id, passRef]);
      } finally {
        if (trigger) await run(db, trigger.sql);
      }
      if (blocked) {
        await expectKeysetInitializationBlocked(db);
      } else {
        expect(await ensureCredentialRefKeyset(db, envA)).toBe(
          await credentialRefKeysetCommitment(envA),
        );
      }
    },
  );

  it('fails closed on a retained provider replay even when no instance survives', async () => {
    const { DB: db } = await makeEnv();
    await run(
      db,
      `INSERT INTO wallet_samsung_auth_replays (token_hash, claim_id, expires_at)
      VALUES (?, 'legacy-claim', 1)`,
      ['a'.repeat(43)],
    );
    await expectKeysetInitializationBlocked(db);
  });

  it('fails closed on a retained Google replay without a provider instance', async () => {
    const f = fixtures(await makeEnv());
    const org = await makeOrg(f);
    const db = f.env.DB;
    await run(
      db,
      `INSERT INTO wallet_provider_accounts
      (id, org_id, mode, provider, created_at, updated_at) VALUES ('account', ?, 'live', 'google', 1, 1)`,
      [org.id],
    );
    await run(
      db,
      `INSERT INTO wallet_google_callback_replays (account_id, nonce_hash, claim_id, expires_at)
      VALUES ('account', ?, 'legacy-claim', 1)`,
      ['a'.repeat(64)],
    );
    await expectKeysetInitializationBlocked(db);
  });
});
