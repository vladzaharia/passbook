// WA1a authority: who may write the wallet credential tables (design-wallet-accounts.md section 3).
import { describe, expect, it } from 'vitest';
import { fixtures, makeEnv, makeOrg } from '../../../test/helpers/index.ts';
import { grant, jobGrant } from './authority.ts';
import { codeOf, db, platformPrincipal, refusal, resultRows } from './authority-ext-fixtures.ts';
import { writePart } from './authority-include.ts';
import type { Principal } from './authority-principal.ts';
import { setupGrant } from './authority-test-fixtures.ts';
import { first, run } from './db.ts';

type Setup = Awaited<ReturnType<typeof setupGrant>>;

const HASH = (c: string) => c.repeat(64);
const CREDENTIAL_COLUMNS = [
  'id',
  'scope',
  'provider',
  'identity_hash',
  'identity_hint',
  'created_at',
  'updated_at',
];
const VERSION_COLUMNS = [
  'id',
  'identity_hash',
  'kek_version',
  'iv',
  'wrapped_dek',
  'ciphertext',
  'created_at',
];
const EVENT_COLUMNS = [
  'id',
  'revision',
  'kind',
  'version_id',
  'actor_type',
  'actor_id',
  'created_at',
];
const CREDENTIAL_TABLES = [
  'wallet_credentials',
  'wallet_credential_versions',
  'wallet_credential_events',
];
const ENROLMENT_TABLES = ['wallet_provider_accounts', 'wallet_enrolment_events'];

/** The platform admin of `setupGrant`, naming the org and mode it acts on. */
const naming = async (x: Setup, mode: 'live' | 'test' = 'live'): Promise<Principal> =>
  ({ ...(await platformPrincipal(x.s)), orgId: x.s.org.id, mode }) as Principal;

const bytes = (n: number) => new Uint8Array(n).fill(3);

describe('enrolment writes by a platform admin under an org_mode purpose (the M2 spike)', () => {
  it('holds an enrolment as platform:<user> naming the org and mode, with an event and a tied part', async () => {
    const x = await setupGrant('wa1a-m2');
    const orgId = x.s.org.id;
    await run(
      db,
      "INSERT INTO wallet_provider_accounts (id, org_id, mode, provider, created_at, updated_at) VALUES ('acct-m2', ?, 'live', 'google', 1, 1)",
      [orgId],
    );
    const at = Date.now();
    const g = grant(x.route, {
      purpose: 'org_mode.wallet.enrolment_hold',
      principal: await naming(x),
      tables: ENROLMENT_TABLES,
    });
    g.insertSelect(
      'wallet_enrolment_events',
      [
        'id',
        'account_id',
        'provider',
        'enrolment_revision',
        'kind',
        'reason',
        'actor_type',
        'actor_id',
        'created_at',
      ],
      ['ev-m2', 'acct-m2', 'google', 1, 'hold', 'abuse', 'platform', x.s.admin.id, at],
    );
    g.include(
      writePart(
        'UPDATE wallet_provider_accounts SET enabled_at = NULL, platform_hold_at = ?, platform_hold_reason = ?, enrolment_revision = ? WHERE id = ? AND org_id = {org} AND mode = {mode} AND {grant}',
        [at, 'abuse', 1, 'acct-m2'],
      ),
    );
    await g.commit();
    const row = await first(
      db,
      "SELECT platform_hold_at AS at, platform_hold_reason AS why, enrolment_revision AS r FROM wallet_provider_accounts WHERE id = 'acct-m2'",
    );
    expect(row).toEqual({ at, why: 'abuse', r: 1 });
    const event = await first<{ org_id: string; mode: string }>(
      db,
      "SELECT org_id, mode FROM wallet_enrolment_events WHERE id = 'ev-m2'",
    );
    expect(event).toEqual({ org_id: orgId, mode: 'live' });
    // The audit row came from the step, naming the org the platform admin acted on.
    expect(
      await first(
        db,
        "SELECT org_id, actor_id FROM audit_log WHERE action = 'wallet_provider.enrolment_hold' AND target_id = 'acct-m2'",
      ),
    ).toEqual({ org_id: orgId, actor_id: x.s.admin.id });
  });

  it('refuses a part that names another org, and the grant of an org with a different mode', async () => {
    const x = await setupGrant('wa1a-m2-ties');
    const g = grant(x.route, {
      purpose: 'org_mode.wallet.enrolment_hold',
      principal: await naming(x),
      tables: ENROLMENT_TABLES,
    });
    expect(
      codeOf(() =>
        g.include(
          writePart(
            'UPDATE wallet_provider_accounts SET enabled_at = NULL WHERE id = ? AND org_id = ? AND mode = {mode} AND {grant}',
            ['a', 'other'],
          ),
        ),
      ),
    ).toBe('GRANT_SCOPE_OVERRIDE');
    expect(
      codeOf(() =>
        g.include(
          writePart(
            'UPDATE wallet_provider_accounts SET enabled_at = NULL WHERE id = ? AND {grant}',
            ['a'],
          ),
        ),
      ),
    ).toBe('GRANT_SCOPE_OVERRIDE');
  });

  it('only a platform admin holds hold, release and migration_resolve', async () => {
    const x = await setupGrant('wa1a-platform-only');
    for (const purpose of [
      'org_mode.wallet.enrolment_hold',
      'org_mode.wallet.enrolment_release',
      'org_mode.wallet.migration_resolve',
    ]) {
      expect(
        codeOf(() => grant(x.route, { purpose, principal: x.member(), tables: ENROLMENT_TABLES })),
        purpose,
      ).toBe('GRANT_BAD_PRINCIPAL');
      expect(
        codeOf(() =>
          grant(x.route, {
            purpose,
            principal: {
              kind: 'api_key',
              keyId: 'k',
              scope: 'wallet',
              orgId: x.s.org.id,
            } as Principal,
            tables: ENROLMENT_TABLES,
          }),
        ),
        purpose,
      ).toBe('GRANT_BAD_PRINCIPAL');
      const admin = await naming(x);
      expect(
        codeOf(() => grant(x.route, { purpose, principal: admin, tables: ENROLMENT_TABLES })),
        purpose,
      ).toBeNull();
    }
    // The org's own purposes stay open to its members.
    for (const purpose of [
      'org_mode.wallet.enrolment_enable',
      'org_mode.wallet.enrolment_disable',
      'org_mode.wallet.enrolment_source',
    ])
      expect(
        codeOf(() => grant(x.route, { purpose, principal: x.member(), tables: ENROLMENT_TABLES })),
        purpose,
      ).toBeNull();
  });
});

describe('the suspended-org job grants (the M3 spike)', () => {
  const input = (x: Setup, purpose: string, tables: string[], over: Record<string, unknown> = {}) =>
    ({
      purpose,
      job: 'wallet',
      orgId: x.s.org.id,
      mode: 'live',
      inactiveOk: true,
      tables,
      ...over,
    }) as Parameters<typeof jobGrant>[1];

  it('hold, disable and migrate commit on a suspended org with their tables, and no others', async () => {
    const x = await setupGrant('wa1a-m3');
    await run(db, "UPDATE orgs SET status = 'suspended' WHERE id = ?", [x.s.org.id]);
    const purposes: [string, string[]][] = [
      ['org_mode.job.wallet.enrolment_hold', ENROLMENT_TABLES],
      ['org_mode.job.wallet.enrolment_disable', ENROLMENT_TABLES],
      ['org_mode.job.wallet.credential_migrate', [...CREDENTIAL_TABLES, ...ENROLMENT_TABLES]],
    ];
    for (const [purpose, tables] of purposes) {
      await expect(
        jobGrant(x.ctx, input(x, purpose, tables)).commit(),
        purpose,
      ).resolves.toBeDefined();
      expect(
        codeOf(() => jobGrant(x.ctx, input(x, purpose, [...tables, 'passes']))),
        purpose,
      ).toBe('GRANT_BAD_PURPOSE');
    }
    expect(
      codeOf(() =>
        jobGrant(x.ctx, input(x, 'org_mode.job.wallet.enrolment_hold', ['wallet_credentials'])),
      ),
    ).toBe('GRANT_BAD_PURPOSE');
    expect(
      codeOf(() =>
        jobGrant(x.ctx, input(x, 'org_mode.job.wallet.enrolment_enable', ENROLMENT_TABLES)),
      ),
    ).toBe('GRANT_BAD_PURPOSE');
  });

  it('is refused for a deleted org, and a suspended org without the flag', async () => {
    const x = await setupGrant('wa1a-m3-state');
    await run(db, "UPDATE orgs SET status = 'suspended' WHERE id = ?", [x.s.org.id]);
    expect(
      await refusal(
        jobGrant(
          x.ctx,
          input(x, 'org_mode.job.wallet.enrolment_disable', ENROLMENT_TABLES, {
            inactiveOk: undefined,
          }),
        ).commit(),
      ),
    ).toMatchObject({ code: 'ORG_ACCESS_CHANGED' });
    await run(db, "UPDATE orgs SET status = 'deleted' WHERE id = ?", [x.s.org.id]);
    expect(
      await refusal(
        jobGrant(
          x.ctx,
          input(x, 'org_mode.job.wallet.enrolment_disable', ENROLMENT_TABLES),
        ).commit(),
      ),
    ).toMatchObject({ code: 'ORG_ACCESS_CHANGED' });
  });

  it('a platform principal on a suspended org is refused: only the job grant reaches it', async () => {
    const x = await setupGrant('wa1a-m3-platform');
    await run(db, "UPDATE orgs SET status = 'suspended' WHERE id = ?", [x.s.org.id]);
    const g = grant(x.route, {
      purpose: 'org_mode.wallet.enrolment_hold',
      principal: await naming(x),
      tables: ENROLMENT_TABLES,
    });
    expect(await refusal(g.commit())).toMatchObject({ code: 'ORG_ACCESS_CHANGED' });
  });
});

describe('guarded credential rows', () => {
  it('a platform grant writes the null-org row; an org grant cannot touch it or write it', async () => {
    const x = await setupGrant('wa1a-platform-row');
    const platform = grant(x.route, {
      purpose: 'platform.wallet.credential_save',
      principal: await platformPrincipal(x.s),
      tables: CREDENTIAL_TABLES,
    });
    platform.insertSelect(
      'wallet_credentials',
      [
        'id',
        'scope',
        'mode',
        'provider',
        'identity_hash',
        'identity_hint',
        'created_at',
        'updated_at',
      ],
      ['pc1', 'platform', 'live', 'google', HASH('a'), 'abcd', 1, 1],
    );
    platform.insertJoined('wallet_credential_versions', {
      parents: { credential_id: 'pc1' },
      columns: VERSION_COLUMNS,
      values: ['pv1', HASH('a'), 1, bytes(12), bytes(60), bytes(40), 1],
    });
    platform.insertJoined('wallet_credential_events', {
      parents: { credential_id: 'pc1' },
      columns: EVENT_COLUMNS,
      values: ['pe1', 1, 'create', 'pv1', 'platform', x.s.admin.id, Date.now()],
    });
    platform.update('wallet_credentials', {
      set: { revision: 1, current_version_id: 'pv1' },
      where: { id: 'pc1' },
    });
    await platform.commit();
    expect(
      await first(
        db,
        "SELECT scope, org_id AS org, revision AS r FROM wallet_credentials WHERE id = 'pc1'",
      ),
    ).toEqual({ scope: 'platform', org: null, r: 1 });

    const org = grant(x.route, {
      purpose: 'org_mode.wallet.credential_save',
      principal: x.member(),
      tables: CREDENTIAL_TABLES,
    });
    const changed = org.update('wallet_credentials', {
      set: { updated_at: 99 },
      where: { id: 'pc1' },
      returning: ['id'],
    });
    const version = org.insertJoined('wallet_credential_versions', {
      parents: { credential_id: 'pc1' },
      columns: VERSION_COLUMNS,
      values: ['pv-x', HASH('a'), 1, bytes(12), bytes(60), bytes(40), 1],
      returning: ['id'],
    });
    const results = await org.commit();
    expect(resultRows(results, org.indexOf(changed))).toEqual([]);
    expect(resultRows(results, org.indexOf(version))).toEqual([]);
    expect(
      await first(db, "SELECT updated_at AS u FROM wallet_credentials WHERE id = 'pc1'"),
    ).toEqual({ u: 1 });
    expect(
      await first(db, "SELECT id FROM wallet_credential_versions WHERE id = 'pv-x'"),
    ).toBeNull();
    // An org grant takes org and mode from the grant row: it cannot name them, and scope 'platform' fails the row CHECK.
    const naming2 = grant(x.route, {
      purpose: 'org_mode.wallet.credential_save',
      principal: x.member(),
      tables: CREDENTIAL_TABLES,
    });
    expect(
      codeOf(() =>
        naming2.insertSelect(
          'wallet_credentials',
          ['id', 'org_id', 'scope', 'mode'],
          ['x', null, 'platform', 'live'],
        ),
      ),
    ).toBe('GRANT_SCOPE_OVERRIDE');
    const forged = grant(x.route, {
      purpose: 'org_mode.wallet.credential_save',
      principal: x.member(),
      tables: CREDENTIAL_TABLES,
    });
    forged.insertSelect(
      'wallet_credentials',
      ['id', 'scope', 'provider', 'identity_hash', 'identity_hint', 'created_at', 'updated_at'],
      ['forged', 'platform', 'google', HASH('f'), 'abcd', 1, 1],
    );
    await expect(forged.commit()).rejects.toThrow(/CHECK constraint failed/);
  });

  it("an org grant writes its own org's credential and not another org's", async () => {
    const x = await setupGrant('wa1a-org-row');
    const other = fixtures(await makeEnv());
    const stranger = await makeOrg(other);
    await run(
      db,
      "INSERT INTO wallet_credentials (id, scope, org_id, mode, provider, identity_hash, identity_hint, created_at, updated_at) VALUES ('theirs', 'org', ?, 'live', 'google', ?, 'abcd', 1, 1)",
      [stranger.id, HASH('9')],
    );
    const g = grant(x.route, {
      purpose: 'org_mode.wallet.credential_save',
      principal: x.member(),
      tables: CREDENTIAL_TABLES,
    });
    g.insertSelect('wallet_credentials', CREDENTIAL_COLUMNS, [
      'mine',
      'org',
      'google',
      HASH('8'),
      'abcd',
      1,
      1,
    ]);
    const theirs = g.update('wallet_credentials', {
      set: { updated_at: 99 },
      where: { id: 'theirs' },
      returning: ['id'],
    });
    const version = g.insertJoined('wallet_credential_versions', {
      parents: { credential_id: 'theirs' },
      columns: VERSION_COLUMNS,
      values: ['v-theirs', HASH('9'), 1, bytes(12), bytes(60), bytes(40), 1],
      returning: ['id'],
    });
    const results = await g.commit();
    expect(resultRows(results, g.indexOf(theirs))).toEqual([]);
    expect(resultRows(results, g.indexOf(version))).toEqual([]);
    expect(
      await first(db, "SELECT org_id AS org, mode FROM wallet_credentials WHERE id = 'mine'"),
    ).toEqual({ org: x.s.org.id, mode: 'live' });
    // A Test grant does not reach a Live credential of its own org either.
    const test = grant(x.route, {
      purpose: 'org_mode.wallet.credential_save',
      principal: x.member({ mode: 'test' }),
      tables: CREDENTIAL_TABLES,
    });
    const live = test.update('wallet_credentials', {
      set: { updated_at: 99 },
      where: { id: 'mine' },
      returning: ['id'],
    });
    expect(resultRows(await test.commit(), test.indexOf(live))).toEqual([]);
  });
});

describe('credential checks are written by the check job only', () => {
  const COLUMNS = ['id', 'version_id', 'ok', 'code'];
  /** A credential and its version, org-scope or platform-scope (a platform row takes the Test google slot). */
  const seed = async (x: Setup, scope: 'org' | 'platform') => {
    const [c, v, check] = [crypto.randomUUID(), crypto.randomUUID(), crypto.randomUUID()];
    await run(
      db,
      `INSERT INTO wallet_credentials (id, scope, org_id, mode, provider, identity_hash, identity_hint, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'google', ?, 'abcd', 1, 1)`,
      [c, scope, scope === 'org' ? x.s.org.id : null, scope === 'org' ? 'live' : 'test', HASH('c')],
    );
    await run(
      db,
      `INSERT INTO wallet_credential_versions (id, credential_id, identity_hash, kek_version, iv, wrapped_dek, ciphertext, created_at)
       VALUES (?, ?, ?, 1, ?, ?, ?, 1)`,
      [v, c, HASH('c'), bytes(12), bytes(60), bytes(40)],
    );
    return { c, v, check };
  };
  const insert = (g: ReturnType<typeof grant>, s: { c: string; v: string; check: string }) =>
    g.insertJoined('wallet_credential_checks', {
      parents: { credential_id: s.c },
      columns: COLUMNS,
      values: [s.check, s.v, 1, null],
    });

  it('an org_mode grant, a platform.wallet.* grant and a part are each refused', async () => {
    const x = await setupGrant('wa1a-checks');
    const ids = await seed(x, 'org');
    for (const [purpose, principal] of [
      ['org_mode.wallet.credential_save', x.member()],
      ['org_mode.wallet.check_request', x.member()],
      ['platform.wallet.credential_save', await platformPrincipal(x.s)],
      ['platform.wallet.credential_revoke', await platformPrincipal(x.s)],
    ] as [string, Principal][]) {
      const g = grant(x.route, {
        purpose,
        principal,
        tables: [...CREDENTIAL_TABLES, 'wallet_credential_checks'],
      });
      expect(
        codeOf(() => insert(g, ids)),
        purpose,
      ).toBe('GRANT_TABLE_NOT_ALLOWED');
      expect(
        codeOf(() => g.update('wallet_credential_checks', { set: { ok: 1 }, where: { id: 'x' } })),
        purpose,
      ).toBe('GRANT_TABLE_NOT_ALLOWED');
      expect(
        codeOf(() => g.delete('wallet_credential_checks', { where: { id: 'x' } })),
        purpose,
      ).toBe('GRANT_TABLE_NOT_ALLOWED');
      // A grant with no table list is bounded all the same.
      expect(
        codeOf(() => insert(grant(x.route, { purpose, principal }), ids)),
        purpose,
      ).toBe('GRANT_TABLE_NOT_ALLOWED');
    }
    const sql =
      'INSERT INTO wallet_credential_checks (id, credential_id, version_id, ok) SELECT ?, ?, ?, 1 WHERE {grant}';
    const params = [ids.check, ids.c, ids.v];
    const part = grant(x.route, {
      purpose: 'org_mode.wallet.credential_save',
      principal: x.member(),
      tables: ['wallet_credential_checks'],
    });
    expect(codeOf(() => part.include(writePart(sql, params)))).toBe('GRANT_UNGUARDED_TABLE');
    const job = jobGrant(x.ctx, {
      purpose: 'platform.job.wallet.credential_check',
      job: 'wallet-credential-check',
      tables: ['wallet_credential_checks'],
    });
    expect(codeOf(() => job.include(writePart(sql, params)))).toBe('GRANT_UNGUARDED_TABLE');
    expect(
      await first(db, 'SELECT id FROM wallet_credential_checks WHERE id = ?', [ids.check]),
    ).toBeNull();
  });

  it('platform.job.wallet.credential_check writes one, on an org credential and a platform one', async () => {
    const x = await setupGrant('wa1a-checks-job');
    for (const scope of ['org', 'platform'] as const) {
      const ids = await seed(x, scope);
      const g = jobGrant(x.ctx, {
        purpose: 'platform.job.wallet.credential_check',
        job: 'wallet-credential-check',
        tables: ['wallet_credential_checks'],
      });
      insert(g, ids);
      await g.commit();
      expect(
        await first(
          db,
          'SELECT credential_id AS c, ok FROM wallet_credential_checks WHERE id = ?',
          [ids.check],
        ),
      ).toEqual({ c: ids.c, ok: 1 });
    }
  });
});
