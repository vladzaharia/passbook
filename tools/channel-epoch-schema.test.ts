// 0114 fences on wallet_provider_instances: the epoch is identity, a channel_off retirement needs the retired
// marker and is write-once, a successor needs a settled channel_off predecessor and an enabled channel, the
// slot frees only at revoked plus cause, and retiring a marker dirties the pass's provider instances.
import type { DatabaseSync } from 'node:sqlite';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  epochWorld,
  rolledBack,
  settleGooglePredecessor,
  successorSql,
  withoutTriggers,
} from './wallet-instances-fixtures.ts';

let db: DatabaseSync;
beforeAll(() => {
  db = epochWorld();
});
const run = (sql: string) => db.exec(sql);
const raw = (sql: string) => withoutTriggers(db, () => db.exec(sql));
const setWpi = (set: string, id = 'ig-o1') =>
  `UPDATE wallet_provider_instances SET ${set} WHERE id = '${id}'`;
const retire = (id: string, extra = '') =>
  setWpi(`retirement_requested_at = 5, retirement_cause = 'channel_off'${extra}`, id);
const mark = (pass: string, org: string, channel: string, retiredAt: string) =>
  `INSERT INTO pass_channels (pass_id, org_id, mode, template_id, channel, retired_at, retired_cause, set_by, set_at) VALUES ('${pass}', '${org}', 'live', 't-${org}', '${channel}', ${retiredAt}, ${retiredAt === 'NULL' ? 'NULL' : "'template'"}, 'u', 5)`;
const dirty = () =>
  db
    .prepare(
      'SELECT instance_id, generation FROM wallet_provider_instance_dirty ORDER BY instance_id',
    )
    .all()
    .map((r) => ({ ...r }));
const NOT_ALLOWED = /provider channel retirement is not allowed/;
const NO_SUCCESSOR = /provider successor is not allowed/;

describe('channel_epoch and retirement_cause', () => {
  it('epoch is identity and bounded to 1..16', () => {
    rolledBack(db, () => {
      expect(() => run(setWpi('channel_epoch = 2'))).toThrow(/identity is immutable/);
      for (const epoch of [0, 17])
        expect(() => raw(successorSql({ channel_epoch: String(epoch) }))).toThrow(/CHECK/);
      raw(
        successorSql({
          id: "'ig16'",
          channel_epoch: '16',
          lifecycle: "'revoked'",
          retirement_requested_at: '5',
          retirement_cause: "'channel_off'",
        }),
      );
    });
  });

  it('cause is only channel_off, only with a retirement request, and never at insert', () => {
    rolledBack(db, () => {
      expect(() => raw(retire('ig-o1').replace("'channel_off'", "'other'"))).toThrow(/CHECK/);
      expect(() => raw(setWpi("retirement_cause = 'channel_off'"))).toThrow(/CHECK/);
      expect(() => raw(successorSql({ retirement_cause: "'channel_off'" }))).toThrow(/CHECK/);
    });
  });

  it('refuses the cause without a retired marker, or with a marker of another pass or channel', () => {
    rolledBack(db, () => {
      expect(() => run(retire('ig-o1'))).toThrow(NOT_ALLOWED);
      run(mark('p2', 'o2', 'google', '5'));
      expect(() => run(retire('ig-o1'))).toThrow(NOT_ALLOWED);
      run(mark('p1', 'o1', 'samsung', '5'));
      expect(() => run(retire('ig-o1'))).toThrow(NOT_ALLOWED);
      run(mark('p1', 'o1', 'google', 'NULL'));
      expect(() => run(retire('ig-o1'))).toThrow(NOT_ALLOWED);
    });
  });

  it('refuses an instance whose org or mode is not the pass', () => {
    for (const forged of ["org_id = 'o2'", "mode = 'test'"]) {
      rolledBack(db, () => {
        run(mark('p1', 'o1', 'google', '5'));
        raw(setWpi(forged));
        expect(() => run(retire('ig-o1'))).toThrow(NOT_ALLOWED);
      });
    }
  });

  it('refuses another credential generation and a lifecycle outside active, revoking, revoked', () => {
    rolledBack(db, () => {
      run(mark('p1', 'o1', 'google', '5'));
      raw("UPDATE passes SET credential_generation = 2 WHERE id = 'p1'");
      expect(() => run(retire('ig-o1'))).toThrow(NOT_ALLOWED);
    });
    rolledBack(db, () => {
      run(mark('p1', 'o1', 'google', '5'));
      raw(
        "INSERT INTO wallet_provider_instances (id, pass_id, org_id, mode, provider, credential_generation, channel_epoch, lifecycle, desired_version, retirement_reason, retired_at, created_at, updated_at) VALUES ('ret', 'p1', 'o1', 'live', 'google', 1, 3, 'retired', 0, 'not_issued', 5, 5, 5)",
      );
      expect(() => run(retire('ret'))).toThrow(NOT_ALLOWED);
    });
  });

  it('needs the request in the same UPDATE and sets once', () => {
    rolledBack(db, () => {
      run(mark('p1', 'o1', 'google', '5'));
      run(setWpi('retirement_requested_at = 5'));
      expect(() => run(setWpi("retirement_cause = 'channel_off'"))).toThrow(NOT_ALLOWED);
    });
    rolledBack(db, () => {
      run(mark('p1', 'o1', 'google', '5'));
      run(retire('ig-o1'));
      run(setWpi("retirement_cause = 'channel_off'"));
      expect(() => run(setWpi('retirement_cause = NULL'))).toThrow(NOT_ALLOWED);
    });
  });
});

describe('the provider slot', () => {
  it('frees only at revoked with a cause', () => {
    const second = () => raw(successorSql({ lifecycle: "'revoked'" }));
    rolledBack(db, () => {
      expect(second).toThrow(/UNIQUE/);
      run(mark('p1', 'o1', 'google', '5'));
      run(retire('ig-o1', ", lifecycle = 'revoking'"));
      expect(second).toThrow(/UNIQUE/);
      run(setWpi("lifecycle = 'revoked'"));
      second();
    });
    rolledBack(db, () => {
      // Revoked without a cause (a transfer or a kill switch) keeps the slot.
      run(setWpi("lifecycle = 'revoking'", 'is-o1'));
      run(setWpi("lifecycle = 'revoked'", 'is-o1'));
      expect(() =>
        raw(successorSql({ id: "'is2'", provider: "'samsung'", account_id: "'as-o1'" })),
      ).toThrow(/UNIQUE/);
    });
  });
});

describe('successor', () => {
  const ok = () => settleGooglePredecessor(db);
  // An enrolment fed by a platform credential: it must be On and not held.
  const sourced = (set: string) =>
    `PRAGMA defer_foreign_keys = ON; INSERT OR IGNORE INTO wallet_credentials (id, scope, mode, provider, identity_hash, identity_hint, created_at, updated_at) VALUES ('cs', 'platform', 'live', 'google', '${'a'.repeat(64)}', 'abcd', 1, 1); UPDATE wallet_provider_accounts SET credential_source_id = 'cs', ${set} WHERE id = 'ag-o1'`;
  const busyOp = `INSERT INTO wallet_provider_instance_operations (id, instance_id, version, kind, request_hash, pass_version, pass_revision, pass_credential_generation, lifecycle_generation, issuing_release_id, projection_release_id, account_revision, adapter_revision, policy_revision, state, created_at) VALUES ('op-busy', 'ig-o1', 3, 'revoke', '${'a'.repeat(64)}', 1, 0, 1, 0, 'r-o1', 'r-o1', 1, 1, 1, 'pending', 8)`;

  it('accepts an enrolment that is On and not held', () => {
    rolledBack(db, () => {
      ok();
      raw(sourced('enabled_at = 5, platform_hold_at = NULL'));
      run(successorSql());
    });
  });

  it('is born active next to a settled channel_off predecessor', () => {
    rolledBack(db, () => {
      ok();
      run(successorSql());
      expect(() => run(successorSql({ id: "'ig3'", channel_epoch: '3' }))).toThrow(
        /UNIQUE|successor/,
      );
      // Epoch 1 keeps the 0043 guard.
      expect(() => run(successorSql({ id: "'e1'", channel_epoch: '1' }))).toThrow(
        /issuance is unavailable/,
      );
    });
  });

  const refused: [string, () => void, Record<string, string>?][] = [
    ['an epoch gap', () => {}, { channel_epoch: '3' }],
    ['a lifecycle other than active', () => {}, { lifecycle: "'revoking'" }],
    ['a release of another org', () => {}, { identity_projection_release_id: "'ra-go2'" }],
    ['a release of another provider', () => {}, { identity_projection_release_id: "'ra-so1'" }],
    ['a system release (not reviewed)', () => {}, { identity_projection_release_id: "'r-o1'" }],
    [
      'an enrolment revision the release was not reviewed for',
      () => raw("UPDATE wallet_provider_accounts SET revision = 2 WHERE id = 'ag-o1'"),
    ],
    [
      'a revoked enrolment',
      () => raw("UPDATE wallet_provider_accounts SET revoked_at = 9 WHERE id = 'ag-o1'"),
    ],
    ['an enrolment that is not On', () => raw(sourced('enabled_at = NULL'))],
    ['an enrolment on platform hold', () => raw(sourced('enabled_at = 5, platform_hold_at = 6'))],
    [
      'a pending credential transfer',
      () =>
        raw(
          `INSERT INTO pass_credential_transfers (id, pass_id, org_id, mode, state, source_generation, source_version, source_revision, source_row_version, source_lifecycle_generation, source_link_generation, target_holder_email, target_owner_user_id, requested_by_type, requested_at) SELECT 'tr1', id, org_id, mode, 'pending', credential_generation, version, revision, row_version, lifecycle_generation, link_generation + 1, 'n@example.test', NULL, 'system', 9 FROM passes WHERE id = 'p1'`,
        ),
    ],
    ['a retirement request', () => {}, { retirement_requested_at: '7' }],
    [
      'a stale keyset commitment',
      () => {},
      { credential_keyset_commitment: `'${'9'.repeat(64)}'` },
    ],
    ['an account of another org', () => {}, { account_id: "'ag-o2'" }],
    ['another org', () => {}, { org_id: "'o2'", account_id: "'ag-o2'" }],
    ['another mode', () => {}, { mode: "'test'" }],
    [
      'another generation',
      () => raw("UPDATE passes SET credential_generation = 2 WHERE id = 'p1'"),
    ],
    ['a predecessor without the cause', () => raw(setWpi('retirement_cause = NULL'))],
    ['a predecessor still revoking', () => raw(setWpi("lifecycle = 'revoking'"))],
    [
      'a predecessor whose revoke did not succeed',
      () =>
        raw("UPDATE wallet_provider_instance_operations SET state = 'failed' WHERE id = 'op-rev'"),
    ],
    [
      'a predecessor whose desired op is not a revoke',
      () => raw(setWpi("desired_operation_id = 'op-ig-o1', desired_version = 1")),
    ],
    ['an operation in flight on the predecessor', () => raw(busyOp)],
    ['a predecessor of another org', () => raw(setWpi("org_id = 'o2'"))],
    ['a predecessor of another mode', () => raw(setWpi("mode = 'test'"))],
    [
      'a retired marker for the provider',
      () =>
        run(
          "UPDATE pass_channels SET retired_at = 9, retired_cause = 'pass' WHERE pass_id = 'p1' AND channel = 'google'",
        ),
    ],
  ];
  it.each(refused)('refuses %s', (_name, setup, over) => {
    rolledBack(db, () => {
      ok();
      setup();
      expect(() => run(successorSql(over))).toThrow(NO_SUCCESSOR);
    });
  });
});

describe('retiring a marker dirties the provider instances', () => {
  it('queues only this pass, org and mode, and only for google and samsung', () => {
    rolledBack(db, () => {
      run('DELETE FROM wallet_provider_instance_dirty');
      run(mark('p1', 'o1', 'apple', '9'));
      run(mark('p1', 'o1', 'mobile', '9'));
      run(mark('p1', 'o1', 'paper', 'NULL'));
      expect(dirty()).toEqual([]);
      run(mark('p1', 'o1', 'google', '9'));
      expect(dirty()).toEqual([{ instance_id: 'ig-o1', generation: 1 }]);
      const set = (v: string) =>
        run(`UPDATE pass_channels SET ${v} WHERE pass_id = 'p1' AND channel = 'google'`);
      set('retired_at = NULL, retired_cause = NULL');
      set("retired_at = 11, retired_cause = 'pass'");
      expect(dirty()).toEqual([{ instance_id: 'ig-o1', generation: 2 }]);
    });
  });

  it('skips instances already requested, never touches another org or mode', () => {
    rolledBack(db, () => {
      run('DELETE FROM wallet_provider_instance_dirty');
      raw(setWpi('retirement_requested_at = 3', 'is-o1'));
      raw(setWpi("mode = 'test'"));
      run(mark('p1', 'o1', 'samsung', '9'));
      run(mark('p1', 'o1', 'google', '9'));
      expect(dirty()).toEqual([]);
      run(mark('p2', 'o2', 'google', '9'));
      expect(dirty()).toEqual([{ instance_id: 'ig-o2', generation: 1 }]);
    });
  });
});
