// Permanent negative tests for the security review (bext-review.md): every probe that once wrote or read
// another tenant's rows must now be refused, and a legitimate sibling still works.
import { describe, expect, it } from 'vitest';
import { makePass } from '../../../test/helpers/index.ts';
import { grant } from './authority.ts';
import { rawCheck } from './authority-checks.ts';
import { tenantSql } from './authority-cond.ts';
import { codeOf, count, db, platformPrincipal } from './authority-ext-fixtures.ts';
import { readPart, writePart } from './authority-include.ts';
import { assertSqlText } from './authority-sqltext.ts';
import { setupGrant } from './authority-test-fixtures.ts';
import { first } from './db.ts';

const OVERRIDE = 'GRANT_SCOPE_OVERRIDE';
const TABLES = ['counters', 'widgets', 'registrations', 'idempotency_keys', 'scanner_setups'];

async function two(label: string) {
  const a = await setupGrant(`${label}-a`);
  const b = await setupGrant(`${label}-b`);
  return { a, b };
}
const mk = (x: Awaited<ReturnType<typeof setupGrant>>, tables: readonly string[] = TABLES) =>
  grant(x.route, { purpose: 'org_mode.test.bypass', principal: x.member(), tables });
const title = async (id: string) =>
  (
    await first<{ t: string | null }>(db, 'SELECT display_title AS t FROM passes WHERE id = ?', [
      id,
    ])
  )?.t;

describe('H1: a condition cannot close the predicate it sits in', () => {
  it('P1 and P1b: unbalanced tenantSql is refused and no foreign pass is written', async () => {
    const { a, b } = await two('h1');
    const g = mk(a, [...TABLES, 'passes']);
    for (const sql of ['1) OR (1', '1)) OR ((1', '(1', '1)'])
      expect(
        codeOf(() =>
          g.update('passes', {
            set: { display_title: 'PWNED' },
            where: { id: b.s.pass.id },
            when: [tenantSql(sql)],
          }),
        ),
        sql,
      ).toBe(OVERRIDE);
    expect(await title(b.s.pass.id)).not.toBe('PWNED');
  });

  it('P6 and the shared helper: rawCheck, quotes, brackets, backticks, comments and semicolons', async () => {
    const { a } = await two('h1-raw');
    expect(
      codeOf(() =>
        grant(a.route, {
          purpose: 'org_mode.test.bypass',
          principal: a.member(),
          checks: [rawCheck('stale', '0) OR (1')],
        }),
      ),
    ).toBe(OVERRIDE);
    for (const sql of [
      'x = "a"',
      'x = `a`',
      'x = [a]',
      '1 = 1 -- c',
      '1 /* c */ = 1',
      '1 = 1; 1 = 1',
      "x = 'a(' AND (1",
    ])
      expect(
        codeOf(() => assertSqlText(sql, 'x')),
        sql,
      ).toBe(OVERRIDE);
    expect(codeOf(() => assertSqlText("x = 'a)(' AND (1 = 1)", 'x'))).toBeNull();
    expect(
      codeOf(
        () =>
          writePart('INSERT INTO counters (key) SELECT 1 WHERE {grant} AND (1', []) &&
          mk(a).include(writePart('INSERT INTO counters (key) SELECT 1 WHERE {grant} AND (1', [])),
      ),
    ).toBe(OVERRIDE);
  });
});

describe('H2: write targets cannot hide behind a schema, quotes or REPLACE INTO', () => {
  it('P2 and P8: main.passes, OR REPLACE, REPLACE INTO and a quoted decoy are refused', async () => {
    const { a, b } = await two('h2');
    const g = mk(a, [...TABLES, 'main', 'passes']);
    const bad = (sql: string, params: (string | number)[] = []) =>
      codeOf(() => g.include(writePart(sql, params)));
    expect(
      bad("UPDATE main.passes SET display_title = 'PWNED' WHERE id = ? AND {grant}", [b.s.pass.id]),
    ).toBe(OVERRIDE);
    expect(
      bad("UPDATE OR REPLACE main.passes SET display_title = 'x' WHERE id = ? AND {grant}", [
        b.s.pass.id,
      ]),
    ).toBe(OVERRIDE);
    expect(bad('UPDATE main . passes SET display_title = 1 WHERE {grant}')).toBe(OVERRIDE);
    expect(bad('REPLACE INTO passes (id) SELECT 1 WHERE {grant}')).toBe('GRANT_UNGUARDED_TABLE');
    expect(
      bad('REPLACE INTO counters (key) SELECT 1 WHERE {grant} AND "UPDATE counters" IS NOT NULL'),
    ).toBe(OVERRIDE);
    expect(bad('INSERT INTO temp.counters (key) SELECT 1 WHERE {grant}')).toBe(OVERRIDE);
    expect(
      codeOf(() =>
        g.unguarded("UPDATE main.passes SET org_id = 'x' FROM authority_grants g WHERE g.id = ?", [
          g.id,
        ]),
      ),
    ).toBe(OVERRIDE);
    expect(
      codeOf(() =>
        g.unguarded('REPLACE INTO passes (id) SELECT 1 FROM authority_grants g WHERE g.id = ?', [
          g.id,
        ]),
      ),
    ).toBe('GRANT_UNGUARDED_TABLE');
    expect(await title(b.s.pass.id)).not.toBe('PWNED');
  });
});

describe('H3: a part is tied to its tenant and pass', () => {
  it('P3: member_photos is guarded, so a part cannot reach another pass through its triggers', async () => {
    const { a, b } = await two('h3');
    const g = mk(a, [...TABLES, 'member_photos']);
    expect(
      codeOf(() =>
        g.include(
          writePart(
            "INSERT INTO member_photos (pass_id, org_id, r2_key, sha1, size, crc32, version, updated_at) SELECT ?, {org}, 'k', 's', 1, 1, 'v', 1 WHERE {grant}",
            [b.s.pass.id],
          ),
        ),
      ),
    ).toBe('GRANT_UNGUARDED_TABLE');
  });

  it('org-bearing tables need {org} at org_id (insert) or org_id = {org} (update, delete)', async () => {
    const { a } = await two('h3-org');
    const g = mk(a);
    const bad = (sql: string, params: (string | number)[] = []) =>
      codeOf(() => g.include(writePart(sql, params)));
    expect(
      bad('INSERT INTO idempotency_keys (key, org_id) SELECT ?, ? WHERE {grant}', ['k', 'other']),
    ).toBe(OVERRIDE);
    expect(
      bad(
        'INSERT INTO idempotency_keys (key, org_id) SELECT ?, ? WHERE {grant} AND {org} IS NOT NULL',
        ['k', 'other'],
      ),
    ).toBe(OVERRIDE);
    expect(bad('INSERT INTO idempotency_keys (key) SELECT ? WHERE {grant}', ['k'])).toBe(OVERRIDE);
    expect(bad('INSERT INTO idempotency_keys SELECT ? WHERE {grant}', ['k'])).toBe(OVERRIDE);
    expect(bad('DELETE FROM idempotency_keys WHERE key = ? AND {grant}', ['k'])).toBe(OVERRIDE);
    expect(
      bad('UPDATE idempotency_keys SET key = ? WHERE org_id = ? AND {grant}', ['k', 'other']),
    ).toBe(OVERRIDE);
    expect(
      bad('DELETE FROM idempotency_keys WHERE key = ? AND org_id = {org} AND {grant}', ['k']),
    ).toBeNull();
    expect(
      bad(
        'DELETE FROM idempotency_keys WHERE key = ? AND idempotency_keys.org_id = {org} AND {grant}',
        ['k'],
      ),
    ).toBeNull();
    expect(
      bad('INSERT INTO idempotency_keys (key, org_id) SELECT ?, {org} WHERE {grant}', ['k']),
    ).toBeNull();
    // mode-bearing as well
    expect(
      bad('DELETE FROM scanner_setups WHERE scanner_id = ? AND org_id = {org} AND {grant}', ['s']),
    ).toBe(OVERRIDE);
    expect(
      bad(
        'DELETE FROM scanner_setups WHERE scanner_id = ? AND org_id = {org} AND mode = {mode} AND {grant}',
        ['s'],
      ),
    ).toBeNull();
  });

  it('P9: a holder grant writes a pass-bearing table only for {pass}', async () => {
    const x = await setupGrant('h3-holder');
    const other = await makePass(x.s.f, { orgId: x.s.org.id, template: x.s.template.resolved });
    const row = await first<{
      identity_id: string;
      serial: string;
      auth_token: string;
      credential_generation: number;
    }>(
      db,
      'SELECT identity_id, serial, auth_token, credential_generation FROM passes WHERE id = ?',
      [x.s.pass.id],
    );
    const proof = {
      via: 'device' as const,
      identityId: row?.identity_id ?? '',
      serial: row?.serial ?? '',
      authToken: row?.auth_token ?? '',
      credentialGeneration: row?.credential_generation ?? 0,
    };
    const g = grant(x.route, {
      purpose: 'org_mode.pass.personalize',
      principal: { kind: 'holder', passId: x.s.pass.id, proof },
      tables: ['registrations', 'counters'],
    });
    const bad = (sql: string, params: (string | number)[] = []) =>
      codeOf(() => g.include(writePart(sql, params)));
    expect(bad('DELETE FROM registrations WHERE pass_id = ? AND {grant}', [other.id])).toBe(
      OVERRIDE,
    );
    expect(bad('DELETE FROM registrations WHERE device_id = ? AND {grant}', ['d'])).toBe(OVERRIDE);
    expect(bad('INSERT INTO counters (key) SELECT ? WHERE {grant}', ['k'])).toBe(OVERRIDE);
    expect(bad('DELETE FROM registrations WHERE pass_id = {pass} AND {grant}')).toBeNull();
    expect(
      codeOf(() =>
        mk(x).include(writePart('DELETE FROM registrations WHERE pass_id = {pass} AND {grant}')),
      ),
    ).toBe(OVERRIDE);
  });

  it('tables is mandatory for include writes and unguarded', async () => {
    const x = await setupGrant('h3-tables');
    const g = grant(x.route, { purpose: 'org_mode.test.bypass', principal: x.member() });
    expect(
      codeOf(() => g.include(writePart('INSERT INTO counters (key) SELECT 1 WHERE {grant}'))),
    ).toBe('GRANT_TABLE_NOT_ALLOWED');
    expect(
      codeOf(() =>
        g.unguarded('INSERT INTO counters (key) SELECT 1 FROM authority_grants g WHERE g.id = ?', [
          g.id,
        ]),
      ),
    ).toBe('GRANT_TABLE_NOT_ALLOWED');
    expect(codeOf(() => g.include(readPart('SELECT {org} AS o')))).toBeNull();
    expect(await count('SELECT count(*) AS n FROM authority_grants')).toBe(0);
  });
});

describe('M1: markers are bound to the grant row and tenant terms are the only org_id', () => {
  it('P4, P3c, P3d, P3b, P7', async () => {
    const { a, b } = await two('m1');
    const g = mk(a);
    const read = (sql: string, params: (string | number)[] = []) =>
      codeOf(() => g.include(readPart(sql, params)));
    expect(
      read('SELECT p.id, p.org_id, {org} AS mine FROM passes p WHERE p.id = ?', [b.s.pass.id]),
    ).toBe(OVERRIDE);
    expect(
      read('SELECT p.id FROM passes p WHERE p.id = ? AND {org} IS NOT NULL', [b.s.pass.id]),
    ).toBe(OVERRIDE);
    expect(read('SELECT p.id FROM passes p WHERE p.org_id == ?', ['x'])).toBe(OVERRIDE);
    expect(read('SELECT p.id FROM passes p WHERE p.org_id IS ? AND {org} IS NOT NULL', ['x'])).toBe(
      OVERRIDE,
    );
    expect(
      read('SELECT p.id FROM passes p WHERE p.org_id LIKE ? AND {org} IS NOT NULL', ['x']),
    ).toBe(OVERRIDE);
    expect(
      read(
        'WITH authority_grants(id, org_id) AS (SELECT x.id, ? FROM main.authority_grants x) SELECT p.id FROM passes p WHERE p.org_id = {org}',
        ['x'],
      ),
    ).toBe(OVERRIDE);
    expect(read('SELECT p.id FROM passes p WHERE p.org_id = {org} AND ag.id = ?', ['x'])).toBe(
      OVERRIDE,
    );
    expect(
      read('SELECT p.id FROM passes p WHERE p.org_id = {org} AND p.mode = {mode} AND p.id = ?', [
        'x',
      ]),
    ).toBeNull();
    expect(
      codeOf(() =>
        g.include(
          writePart(
            'INSERT INTO idempotency_keys (key, org_id) SELECT ?, ? WHERE {grant} AND {org} IS NOT NULL',
            ['k', b.s.org.id],
          ),
        ),
      ),
    ).toBe(OVERRIDE);
  });

  it('markers render against main.authority_grants', async () => {
    const x = await setupGrant('m1-main');
    const g = mk(x);
    const [r] = g.include(readPart('SELECT {org} AS o'));
    const { builtOf } = await import('./authority-granted.ts');
    expect(builtOf(r as never).sql).toContain('main.authority_grants');
  });
});

describe('M2: tenantSql cannot decide on another tenant through other columns', () => {
  it('P5', async () => {
    const bad = (sql: string, params: (string | number)[] = []) =>
      codeOf(() => tenantSql(sql, params));
    expect(bad('EXISTS (SELECT 1 FROM orgs o WHERE o.id = ?)', ['x'])).toBe(OVERRIDE);
    expect(bad("json_extract(x.data, '$.orgId') = ?", ['x'])).toBe(OVERRIDE);
    expect(bad("? = json_extract(x.data, '$.orgId')", ['x'])).toBe(OVERRIDE);
    expect(bad("json_extract(x.data, '$.orgId') IN (?)", ['x'])).toBe(OVERRIDE);
    expect(bad("x.data ->> '$.orgId' = ?", ['x'])).toBe(OVERRIDE);
    expect(bad('{org} = ?', ['x'])).toBe(OVERRIDE);
    expect(bad('? = {mode}', ['x'])).toBe(OVERRIDE);
    expect(bad('EXISTS (SELECT 1 FROM passes x NATURAL JOIN passes y)')).toBe(OVERRIDE);
    expect(bad('EXISTS (SELECT 1 FROM passes x JOIN passes y USING (id))')).toBe(OVERRIDE);
    expect(bad("json_extract(x.data, '$.kind') = 'a'")).toBeNull();
  });

  it('{row} cannot reach the tenant column of settings or orgs', async () => {
    const { a } = await two('m2-row');
    const g = mk(a, [...TABLES, 'settings']);
    expect(
      codeOf(() =>
        g.update('settings', {
          set: { value: 'x' },
          where: { key: 'k' },
          when: [tenantSql('{row}.scope = ?', ['org:x'])],
        }),
      ),
    ).toBe(OVERRIDE);
    expect(
      codeOf(() =>
        g.update('settings', {
          set: { value: 'x' },
          where: { key: 'k' },
          when: [tenantSql('{row}.key = ?', ['k'])],
        }),
      ),
    ).toBeNull();
  });
});

describe('L1-L4', () => {
  it('L1: a deferred principal in a request context needs the flag, with no purpose list', async () => {
    const x = await setupGrant('l1');
    const p = {
      kind: 'membership',
      membershipId: x.s.membershipId,
      mode: 'live',
      via: 'deferred',
      orgAccessRevision: 1,
      userAccessRevision: 1,
    } as const;
    for (const purpose of [
      'org_mode.scan.pairing.redeem',
      'org_mode.sandbox.forward_finish',
      'org_mode.delivery.email_queue',
      'org.template.create',
    ])
      expect(
        codeOf(() => grant(x.route, { purpose, principal: p })),
        purpose,
      ).toBe('GRANT_BAD_PRINCIPAL');
  });

  it('L2: an api key without the required scope is refused (actor)', async () => {
    const x = await setupGrant('l2');
    const g = grant(x.route, {
      purpose: 'org_mode.pass.publish',
      principal: { kind: 'api_key', keyId: x.s.key.id, scope: 'connections:write' },
    });
    await expect(g.commit()).rejects.toMatchObject({ code: 'ACTOR_CHANGED' });
  });

  it('L3: verified_email refuses a block row, and non-holder principals cannot hold holder purposes (CHECK)', async () => {
    const x = await setupGrant('l3');
    const p = await makePass(x.s.f, {
      orgId: x.s.org.id,
      template: x.s.template.resolved,
      holderEmail: 'l3@example.com',
    });
    await db
      .prepare(
        "INSERT INTO user_emails (email, user_id, verified_via, verified_at) VALUES ('l3@example.com', ?, 'magic_link', 1)",
      )
      .bind(x.s.user.id)
      .run();
    const commit = () =>
      grant(x.route, {
        purpose: 'org_mode.pass.holder_attach',
        principal: {
          kind: 'holder',
          passId: p.id,
          proof: { via: 'verified_email', userId: x.s.user.id },
        },
      }).commit();
    await expect(commit()).resolves.toBeDefined();
    await db
      .prepare('INSERT INTO pass_attach_blocks (pass_id, user_id, created_at) VALUES (?, ?, 1)')
      .bind(p.id, x.s.user.id)
      .run();
    await expect(commit()).rejects.toMatchObject({ code: 'ACTOR_CHANGED' });
    await expect(
      db
        .prepare(
          "INSERT INTO authority_grants (id, scope, org_id, mode, principal, purpose, created_at, leak_guard) VALUES ('l3-1', 'org_mode', ?, 'live', 'membership:m', 'org_mode.pass.holder_attach', 1, 'l3-1')",
        )
        .bind(x.s.org.id)
        .run(),
    ).rejects.toThrow(/CHECK/);
    await db.prepare('DELETE FROM authority_grants').run();
  });

  it('L4: the legacy audit when form is gone; a GrantCond when still works', async () => {
    const x = await setupGrant('l4');
    const g = mk(x);
    const row = {
      at: 1,
      orgId: x.s.org.id,
      actorType: 'user',
      actorId: null,
      action: 'l4',
      targetType: null,
      targetId: null,
      requestId: null,
      ipPrefix: null,
      detail: null,
    };
    expect(codeOf(() => g.audit(row, [tenantSql('0) OR (1')]))).toBe(OVERRIDE);
    void platformPrincipal;
  });
});

describe('markers stay legal on the right of a JSON comparison, and edge tables have a supported form', () => {
  it('json_extract(...) = {org} and = {mode} pass the part lints; = ? does not', async () => {
    const x = await setupGrant('json-marker');
    const g = mk(x);
    const read = (sql: string, params: (string | number)[] = ['{}']) =>
      codeOf(() => g.include(readPart(sql, params)));
    const base =
      "SELECT s.id FROM (SELECT ? AS j) input JOIN scans s ON s.id = json_extract(input.j, '$.id') WHERE s.org_id = {org} AND s.mode = {mode}";
    expect(
      read(
        `${base} AND json_extract(input.j, '$.org') = {org} AND json_extract(input.j, '$.mode') = {mode}`,
      ),
    ).toBeNull();
    expect(read(`${base} AND {org} = json_extract(input.j, '$.org')`)).toBeNull();
    expect(read(`${base} AND json_extract(input.j, '$.org') = ?`, ['{}', 'x'])).toBeNull();
    expect(codeOf(() => tenantSql("json_extract(input.j, '$.org') = {org}"))).toBeNull();
    expect(codeOf(() => tenantSql("json_extract(input.j, '$.org') = ?", ['x']))).toBe(OVERRIDE);
    expect(codeOf(() => tenantSql("json_extract(input.j, '$.mode') = {mode}"))).toBeNull();
  });

  it('exists over an org-less edge table joins its parent and compares the parent tenant', async () => {
    const { exists, notExists } = await import('./authority-cond.ts');
    const { builtOf } = await import('./authority-granted.ts');
    const x = await setupGrant('edge-exists');
    const g = mk(x);
    const st = g.assert('stale', [exists('template_approvals', { id: 'ap' })]);
    expect(builtOf(st).sql).toContain('JOIN template_candidates p ON p.id = x.candidate_id');
    expect(builtOf(st).sql).toContain('p.org_id = g.org_id');
    expect(
      codeOf(() => g.assert('stale', [notExists('template_approvals', { id: 'ap' })])),
    ).toBeNull();
    expect(codeOf(() => exists('users', { id: 'u' }))).toBe('GRANT_NO_EDGE');
    expect(codeOf(() => exists('pass_assets', { id: 'u' }, 'nope'))).toBe('GRANT_NO_EDGE');
  });
});

describe('holder grants and the transfer tables', () => {
  const setup = async (label: string) => {
    const x = await setupGrant(label);
    const other = await makePass(x.s.f, { orgId: x.s.org.id, template: x.s.template.resolved });
    const row = await first<{
      identity_id: string;
      serial: string;
      auth_token: string;
      credential_generation: number;
    }>(
      db,
      'SELECT identity_id, serial, auth_token, credential_generation FROM passes WHERE id = ?',
      [x.s.pass.id],
    );
    const proof = {
      via: 'device' as const,
      identityId: row?.identity_id ?? '',
      serial: row?.serial ?? '',
      authToken: row?.auth_token ?? '',
      credentialGeneration: row?.credential_generation ?? 0,
    };
    const g = () =>
      grant(x.route, {
        purpose: 'org_mode.pass.personalize',
        principal: { kind: 'holder', passId: x.s.pass.id, proof },
        tables: ['pass_transfer_asset_gc', 'pass_credential_transfer_payloads'],
      });
    return { x, other, g };
  };
  const PAYLOAD_DELETE =
    'DELETE FROM pass_credential_transfer_payloads WHERE EXISTS (SELECT 1 FROM pass_credential_transfers pt WHERE pt.id = pass_credential_transfer_payloads.transfer_id AND pt.pass_id = {pass}) AND {grant}';

  it('pass_transfer_asset_gc: a holder deletes its own pass rows and cannot name another pass', async () => {
    const { x, other, g } = await setup('hp-gc');
    for (const [key, pass] of [
      ['pass-assets/own', x.s.pass.id],
      ['pass-assets/other', other.id],
    ] as const)
      await db
        .prepare(
          "INSERT INTO pass_transfer_asset_gc (r2_key, transfer_id, source_pass_id, retired_at, next_attempt_at) VALUES (?, 't', ?, 1, 1)",
        )
        .bind(key, pass)
        .run();
    const bad = (sql: string, params: (string | number)[] = []) =>
      codeOf(() => g().include(writePart(sql, params)));
    expect(
      bad('DELETE FROM pass_transfer_asset_gc WHERE source_pass_id = ? AND {grant}', [other.id]),
    ).toBe(OVERRIDE);
    expect(
      bad('DELETE FROM pass_transfer_asset_gc WHERE r2_key = ? AND {grant}', ['pass-assets/other']),
    ).toBe(OVERRIDE);
    const own = g();
    own.include(
      writePart('DELETE FROM pass_transfer_asset_gc WHERE source_pass_id = {pass} AND {grant}'),
    );
    // The retired-key tombstone is immutable by trigger: the delete reaching the own row proves the pin matched.
    await expect(own.commit()).rejects.toThrow(/immutable/);
  });

  it('pass_credential_transfer_payloads: pinned through the transfer row of the grant pass', async () => {
    const { other, g } = await setup('hp-payload');
    const bad = (sql: string, params: (string | number)[] = []) =>
      codeOf(() => g().include(writePart(sql, params)));
    expect(bad(PAYLOAD_DELETE)).toBeNull();
    expect(bad(PAYLOAD_DELETE.replace('{pass}', '?'), [other.id])).toBe(OVERRIDE);
    expect(
      bad('DELETE FROM pass_credential_transfer_payloads WHERE transfer_id = ? AND {grant}', ['t']),
    ).toBe(OVERRIDE);
    const insert = (select: string) =>
      `INSERT INTO pass_credential_transfer_payloads (transfer_id, kek_version, iv, wrapped_dek, ciphertext) ${select} AND {grant}`;
    expect(
      bad(
        insert(
          'SELECT pt.id, 1, ?, ?, ? FROM pass_credential_transfers pt WHERE pt.id = ? AND pt.pass_id = {pass}',
        ),
        ['a', 'b', 'c', 't'],
      ),
    ).toBeNull();
    expect(
      bad(
        insert(
          'SELECT ?, 1, ?, ?, ? FROM pass_credential_transfers pt WHERE pt.id = ? AND pt.pass_id = {pass}',
        ),
        ['t', 'a', 'b', 'c', 't'],
      ),
    ).toBe(OVERRIDE);
    expect(
      bad(
        insert(
          'SELECT pt.id, 1, ?, ?, ? FROM pass_credential_transfers pt WHERE pt.id = ? AND pt.pass_id = ?',
        ),
        ['a', 'b', 'c', 't', other.id],
      ),
    ).toBe(OVERRIDE);
    const own = g();
    own.include(writePart(PAYLOAD_DELETE));
    await own.commit();
  });
});

// Platform review L2 (2026-11-11): every probe below was accepted; each refusal has a legitimate sibling.
describe('L2: a tenant term is a conjunct of its own statement, and pass rows are tied', () => {
  const tenantTie = 'p.org_id = {org} AND p.mode = {mode}';

  it('reads: comma joins, OR / NOT around the tenant term, and a missing {mode} are refused', async () => {
    const { a } = await two('l2-read');
    const g = mk(a);
    const read = (sql: string, params: (string | number)[] = []) =>
      codeOf(() => g.include(readPart(sql, params)));
    for (const sql of [
      'SELECT s.id FROM passes p, scans s WHERE p.org_id = {org} AND p.mode = {mode}',
      'SELECT s.id FROM passes p, scans s WHERE p.org_id = {org} AND p.mode = {mode} AND s.org_id = {org} AND s.mode = {mode}',
      `SELECT p.id FROM passes p WHERE ${tenantTie} OR 1`,
      `SELECT p.id FROM passes p WHERE (p.org_id = {org} OR 1) AND p.mode = {mode}`,
      'SELECT p.id FROM passes p WHERE NOT (p.org_id = {org}) AND p.mode = {mode}',
      'SELECT p.id FROM passes p WHERE NOT p.org_id = {org} AND p.mode = {mode}',
      'SELECT p.id FROM passes p WHERE (p.org_id = {org}) = 0 AND p.mode = {mode}',
      'SELECT p.id FROM passes p WHERE coalesce(p.org_id = {org}, 1) AND p.mode = {mode}',
      'SELECT p.id FROM passes p WHERE CASE WHEN 1 THEN 1 ELSE p.org_id = {org} END AND p.mode = {mode}',
      'SELECT p.id FROM passes p WHERE p.org_id = {org}',
      'SELECT g.state FROM scan_gates g WHERE g.org_id = {org}',
      `SELECT p.id FROM passes p WHERE p.mode = {mode} AND NOT EXISTS (SELECT 1 FROM scans s WHERE s.pass_id = p.id AND s.org_id = {org} AND s.mode = {mode} AND p.org_id = {org})`,
      `SELECT p.id FROM passes p WHERE ${tenantTie} AND NOT EXISTS (SELECT 1 FROM scans s WHERE s.pass_id = p.id AND (s.org_id = {org} OR 1) AND s.mode = {mode})`,
      `SELECT p.id FROM passes p WHERE ${tenantTie} AND EXISTS (SELECT 1 FROM passes p WHERE p.id = ?)`,
      'SELECT p.id FROM passes p LEFT JOIN scan_events e ON e.id = p.id AND e.org_id = {org} WHERE p.org_id = {org} AND p.mode = {mode}',
      'SELECT x.id FROM (SELECT id, org_id FROM scans) x JOIN passes p ON p.org_id = {org}',
      'SELECT p.id FROM passes p WHERE p.org_id IS NOT DISTINCT FROM {org}',
      'SELECT p.id FROM "passes" p WHERE p.org_id = {org}',
      `SELECT p.id FROM passes p WHERE ${tenantTie} AND p.id = ?1`,
      `SELECT p.id FROM passes p WHERE ${tenantTie} AND p.id = :id`,
    ])
      expect(read(sql, /\?1|:id|p\.id = \?\)/.test(sql) ? ['x'] : []), sql).toBe(OVERRIDE);
    for (const sql of [
      `SELECT p.id FROM passes p WHERE ${tenantTie}`,
      `SELECT p.id FROM passes p WHERE p.id = ? AND (${tenantTie})`,
      `SELECT p.id FROM passes p JOIN scans s ON s.pass_id = p.id AND s.org_id = {org} AND s.mode = {mode} WHERE ${tenantTie}`,
      `SELECT p.id, CASE WHEN p.status = 'active' OR 1 THEN 1 END AS live FROM passes p WHERE ${tenantTie}`,
      // A subquery alias holds its term in its own WHERE, even inside NOT EXISTS.
      `SELECT p.id FROM passes p WHERE ${tenantTie} AND NOT EXISTS (SELECT 1 FROM scans s WHERE s.pass_id = p.id AND s.org_id = {org} AND s.mode = {mode})`,
      `SELECT p.id FROM passes p WHERE p.mode = {mode} AND EXISTS (SELECT 1 FROM scans s WHERE s.pass_id = p.id AND p.org_id = {org} AND s.org_id = {org} AND s.mode = {mode})`,
      // A literal is inert: 'ag' is not the grant alias.
      `SELECT p.id FROM passes p WHERE ${tenantTie} AND 'ag' = 'ag'`,
      'SELECT g.state FROM scan_gates g WHERE g.org_id = {org} AND g.mode = {mode}',
    ])
      expect(read(sql, sql.includes('p.id = ?') ? ['x'] : []), sql).toBeNull();
    // An org grant has no mode to compare.
    const org = grant(a.route, {
      purpose: 'org.test.bypass',
      principal: a.member(),
      tables: TABLES,
    });
    expect(
      codeOf(() => org.include(readPart('SELECT p.id FROM passes p WHERE p.org_id = {org}'))),
    ).toBeNull();
  });

  it('writes: a pass-bearing row under a tenant grant is tied to a pass of {org} and {mode}', async () => {
    const { a, b } = await two('l2-tie');
    const g = mk(a, [...TABLES, 'revisions']);
    const bad = (sql: string, params: (string | number)[] = []) =>
      codeOf(() => g.include(writePart(sql, params)));
    for (const [sql, params] of [
      ['DELETE FROM registrations WHERE pass_id = ? AND {grant}', ['x']],
      [
        'DELETE FROM registrations WHERE pass_id IN (SELECT p.id FROM passes p WHERE p.org_id = {org}) AND {grant}',
        [],
      ],
      [
        `DELETE FROM registrations WHERE pass_id IN (SELECT p.id FROM passes p WHERE ${tenantTie}) OR 1 AND {grant}`,
        [],
      ],
      [
        `DELETE FROM registrations WHERE pass_id NOT IN (SELECT p.id FROM passes p WHERE ${tenantTie}) AND {grant}`,
        [],
      ],
      [
        `DELETE FROM registrations WHERE NOT EXISTS (SELECT 1 FROM passes p WHERE p.id = registrations.pass_id AND ${tenantTie}) AND {grant}`,
        [],
      ],
      [`UPDATE revisions SET pass_id = p.id FROM passes p WHERE ${tenantTie} AND {grant}`, []],
      [
        `INSERT INTO revisions (pass_id, at) SELECT ?, 1 FROM passes p WHERE p.id = ? AND ${tenantTie} AND {grant}`,
        ['x', 'x'],
      ],
      [
        `WITH t AS (SELECT 1) DELETE FROM registrations WHERE pass_id IN (SELECT id FROM passes p WHERE p.org_id = {org}) AND {grant} RETURNING *`,
        [],
      ],
      [
        `WITH passes AS (SELECT ? AS id, {org} AS org_id, {mode} AS mode) DELETE FROM registrations WHERE pass_id IN (SELECT p.id FROM passes p WHERE ${tenantTie}) AND {grant}`,
        ['x'],
      ],
      ['DELETE FROM registrations WHERE pass_id = ?1 AND {grant}', ['x']],
      ['DELETE FROM counters WHERE key = ? OR {grant}', ['k']],
    ] as const)
      expect(bad(sql, [...params]), sql).toBe(OVERRIDE);
    const inTenant = `pass_id IN (SELECT p.id FROM passes p WHERE p.id = ? AND ${tenantTie})`;
    for (const sql of [
      `DELETE FROM registrations WHERE ${inTenant} AND {grant}`,
      `DELETE FROM registrations WHERE EXISTS (SELECT 1 FROM passes p WHERE p.id = ? AND p.id = registrations.pass_id AND ${tenantTie}) AND {grant}`,
      `WITH t AS (SELECT 1) DELETE FROM registrations WHERE ${inTenant} AND {grant} RETURNING *`,
    ])
      expect(bad(sql, ['x']), sql).toBeNull();

    // In D1: another tenant's pass id deletes and inserts nothing; the grant's own pass does.
    const seed = (passId: string) =>
      db.prepare('INSERT INTO revisions (pass_id, at) VALUES (?, 1)').bind(passId).run();
    await seed(a.s.pass.id);
    await seed(b.s.pass.id);
    const revs = (passId: string) =>
      count('SELECT count(*) AS n FROM revisions WHERE pass_id = ?', [passId]);
    const run = async (passId: string) => {
      const w = mk(a, [...TABLES, 'revisions']);
      w.include(
        writePart(`DELETE FROM revisions WHERE ${inTenant} AND {grant}`, [passId]),
        writePart(
          `INSERT INTO revisions (pass_id, at) SELECT p.id, 2 FROM passes p WHERE p.id = ? AND ${tenantTie} AND {grant}`,
          [passId],
        ),
      );
      await w.commit();
    };
    const foreign = await revs(b.s.pass.id);
    await run(b.s.pass.id);
    expect(await revs(b.s.pass.id)).toBe(foreign);
    expect(await count('SELECT count(*) AS n FROM revisions WHERE at = 2')).toBe(0);
    await run(a.s.pass.id);
    expect(await revs(a.s.pass.id)).toBe(1);
    expect(
      await count('SELECT count(*) AS n FROM revisions WHERE pass_id = ? AND at = 2', [
        a.s.pass.id,
      ]),
    ).toBe(1);
  });

  it('a holder write keeps {pass} and {grant} as conjuncts', async () => {
    const x = await setupGrant('l2-holder');
    const row = await first<{ identity_id: string; serial: string; auth_token: string }>(
      db,
      'SELECT identity_id, serial, auth_token FROM passes WHERE id = ?',
      [x.s.pass.id],
    );
    const g = grant(x.route, {
      purpose: 'org_mode.pass.personalize',
      principal: {
        kind: 'holder',
        passId: x.s.pass.id,
        proof: {
          via: 'device',
          identityId: row?.identity_id ?? '',
          serial: row?.serial ?? '',
          authToken: row?.auth_token ?? '',
          credentialGeneration: 0,
        },
      },
      tables: ['registrations'],
    });
    const part = (sql: string) => codeOf(() => g.include(writePart(sql)));
    expect(part('DELETE FROM registrations WHERE pass_id = {pass} OR 1 AND {grant}')).toBe(
      OVERRIDE,
    );
    expect(part('DELETE FROM registrations WHERE NOT pass_id = {pass} AND {grant}')).toBe(OVERRIDE);
    expect(part('UPDATE registrations SET pass_id = {pass} WHERE {grant}')).toBe(OVERRIDE);
    expect(part('DELETE FROM registrations WHERE pass_id = {pass} AND {grant}')).toBeNull();
  });

  it('rawCheck reserves the actor alias a; tenantSql keeps its tenant term a conjunct', async () => {
    const { a, b } = await two('l2-cond');
    const check = (sql: string, params: (string | number)[] = []) =>
      codeOf(() =>
        grant(a.route, {
          purpose: 'org_mode.test.bypass',
          principal: a.member(),
          checks: [rawCheck('lineage', sql, params)],
        }),
      );
    expect(
      check('EXISTS (SELECT 1 FROM passes a WHERE a.id = ? AND a.org_id = ?)', [
        b.s.pass.id,
        b.s.org.id,
      ]),
    ).toBe(OVERRIDE);
    expect(check('EXISTS (SELECT 1 FROM passes A WHERE A.id = ?)', [b.s.pass.id])).toBe(OVERRIDE);
    expect(check('EXISTS (SELECT 1 FROM passes x WHERE x.id = ?1)', [b.s.pass.id])).toBe(OVERRIDE);
    expect(
      check('EXISTS (SELECT 1 FROM orgs o WHERE o.id = a.org_id AND o.status = ?)', ['active']),
    ).toBeNull();
    const ok = grant(a.route, {
      purpose: 'org_mode.test.bypass',
      principal: a.member(),
      checks: [rawCheck('lineage', 'EXISTS (SELECT 1 FROM orgs o WHERE o.id = a.org_id)')],
    });
    await ok.commit();

    const cond = (sql: string, params: (string | number)[] = []) =>
      codeOf(() => tenantSql(sql, params));
    for (const sql of [
      'EXISTS (SELECT 1 FROM passes x WHERE x.id = ? AND (x.org_id = {org} OR 1))',
      'EXISTS (SELECT 1 FROM passes x WHERE x.id = ? AND x.org_id = {org} OR 1)',
      'EXISTS (SELECT 1 FROM passes x WHERE x.id = ? AND NOT (x.org_id = {org}))',
      'EXISTS (SELECT 1 FROM passes x WHERE x.id = ? AND coalesce(x.org_id = {org}, 1))',
      'EXISTS (SELECT 1 FROM passes x WHERE x.id = ? AND CASE WHEN 1 THEN 1 ELSE x.org_id = {org} END)',
      'EXISTS (SELECT 1 FROM passes x WHERE x.id = ?1 AND x.org_id = {org})',
    ])
      expect(cond(sql, ['p']), sql).toBe(OVERRIDE);
    for (const sql of [
      'EXISTS (SELECT 1 FROM passes x WHERE x.id = ? AND x.org_id = {org})',
      // A negated body only refuses more: a tenant term inside NOT EXISTS may sit under an OR.
      'NOT EXISTS (SELECT 1 FROM passes x WHERE x.id = ? AND x.org_id = {org})',
      'NOT EXISTS (SELECT 1 FROM passes x WHERE x.id = ? OR (x.status = 1 AND x.org_id = {org}))',
      'EXISTS (SELECT 1 FROM templates t WHERE t.id = ? AND (t.org_id IS NULL OR t.org_id = {org}))',
      '(? IS NULL OR EXISTS (SELECT 1 FROM outbox ob WHERE ob.id = ? AND ob.org_id = {org}))',
    ])
      expect(cond(sql, sql.startsWith('(?') ? ['p', 'p'] : ['p']), sql).toBeNull();
  });

  it('unguarded: the grant-row predicate counts only outside string literals', async () => {
    const x = await setupGrant('l2-unguarded');
    const g = mk(x);
    expect(
      codeOf(() => g.unguarded("UPDATE counters SET count = 0 WHERE key = 'authority_grants'", [])),
    ).toBe('GRANT_FOREIGN_STATEMENT');
    expect(
      codeOf(() =>
        g.unguarded(
          'UPDATE counters SET count = 0 WHERE key = ? AND EXISTS (SELECT 1 FROM authority_grants g WHERE g.id = ?)',
          ['k', g.id],
        ),
      ),
    ).toBeNull();
  });
});
