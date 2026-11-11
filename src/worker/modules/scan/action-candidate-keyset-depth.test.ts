import { expect, it } from 'vitest';
import { installKeysetTestEnv } from '../../../../test/helpers/credential-keyset.ts';
import { makeSession, makeUser } from '../../../../test/helpers/index.ts';
import { createApp } from '../../app.ts';
import { denyAllStores } from '../../platform/auth.ts';
import { first, run, stmt } from '../../platform/db.ts';
import { createSessionStore, hashSessionCookie } from '../auth/sessions.ts';
import { credentialRefKeysetCommitment } from '../passes/credential-keyset.ts';
import { withKitDatabase } from '../passes/pass-test-fixtures.ts';
import { candidateInitializationFence } from './repo-act.ts';
import {
  grantScanMembership,
  key,
  makeLegacyScanPass,
  ORIGIN,
  type ScanKit,
  setupScanKit,
} from './test-kit.ts';

const makeEnv = installKeysetTestEnv();
type Change =
  | 'none'
  | 'session'
  | 'scanner csrf'
  | 'membership'
  | 'event'
  | 'event templates'
  | 'template release'
  | 'claim'
  | 'no change'
  | 'retained'
  | 'existing';

interface Fixture {
  kit: ScanKit;
  pass: { id: string };
  event: { id: string };
  scanner: { id: string };
  templateId: string;
  membershipId: string;
  request: { idempotencyKey: string };
  actorKey: string;
  sessionId: string;
  commitment: string;
  post(): Response | Promise<Response>;
}

async function fixture(): Promise<Fixture> {
  const env = await makeEnv();
  const kit = await withKitDatabase(env.DB, setupScanKit);
  const templateId = await kit.scanTemplate('Scoped bootstrap', {
    actions: [{ id: 'check_in', label: 'Check in', kind: 'check_in' }],
  });
  const template = await kit.registry.resolve(templateId);
  const pass = await makeLegacyScanPass(kit.fx, { orgId: kit.org.id, template });
  const event = await kit.event({ templateIds: [templateId] });
  const scanner = await kit.scanner({ eventId: event.id });
  const user = await makeUser(kit.fx);
  const membershipId = await grantScanMembership(kit.fx, kit.org.id, user.id, ['pass_operator']);
  const session = await makeSession(kit.fx, { userId: user.id, roles: ['user'] });
  await run(
    kit.env.DB,
    `INSERT INTO scanner_setups (scanner_id,org_id,mode,admin_session,admin_user_id)
    VALUES (?,?,'live',1,?)`,
    [scanner.id, kit.org.id, user.id],
  );
  const app = createApp({
    stores: { ...denyAllStores, sessions: createSessionStore(kit.env, kit.clock) },
    clock: kit.clock,
  });
  const request = {
    idempotencyKey: key(),
    input: { passId: pass.id, method: 'manual' },
    clientTs: kit.clock.now(),
    actionId: 'check_in',
    scope: { orgId: kit.org.id, setupId: scanner.id, templateIds: [templateId], timeZone: 'UTC' },
  };
  const post = () =>
    app.request(
      `${ORIGIN}/api/v1/scan/actions`,
      {
        method: 'POST',
        headers: { ...session.headers, origin: ORIGIN, 'content-type': 'application/json' },
        body: JSON.stringify(request),
      },
      kit.env,
    );
  return {
    kit,
    pass,
    templateId,
    membershipId,
    event,
    scanner,
    request,
    actorKey: `u:${user.id}`,
    sessionId: await hashSessionCookie(session.cookieValue),
    commitment: await credentialRefKeysetCommitment(kit.env),
    post,
  };
}

function mutation(f: Fixture, change: Change): D1PreparedStatement | null {
  const db = f.kit.env.DB;
  const now = f.kit.clock.now();
  switch (change) {
    case 'none':
      return null;
    case 'session':
      return stmt(db, 'DELETE FROM sessions WHERE id_hash=?', [f.sessionId]);
    case 'scanner csrf':
      return stmt(db, 'UPDATE scanners SET csrf_secret=?,updated_at=updated_at+1 WHERE id=?', [
        'replaced-scanner-secret',
        f.scanner.id,
      ]);
    case 'membership':
      return stmt(db, 'UPDATE org_memberships SET revoked_at=? WHERE id=?', [now, f.membershipId]);
    case 'event':
      // A real configuration change; touching the stamp alone no longer moves authority.
      return stmt(db, 'UPDATE scan_events SET closes_at=closes_at+1 WHERE id=?', [f.event.id]);
    case 'event templates':
      return stmt(db, 'DELETE FROM scan_event_templates WHERE event_id=? AND template_id=?', [
        f.event.id,
        f.templateId,
      ]);
    case 'template release':
      return stmt(db, "UPDATE templates SET status='archived',updated_at=updated_at+1 WHERE id=?", [
        f.templateId,
      ]);
    case 'claim':
      return stmt(db, "UPDATE scans SET reason='stale' WHERE actor_key=? AND idempotency_key=?", [
        f.actorKey,
        f.request.idempotencyKey,
      ]);
    case 'no change':
      return stmt(db, 'UPDATE scan_events SET updated_at=updated_at WHERE id=? AND 0', [
        f.event.id,
      ]);
    case 'retained':
      return stmt(
        db,
        `INSERT INTO scan_asset_grant_provenance
        (token_hash,org_id,mode,expires_at,credential_refs) VALUES (?,?,'live',?,?)`,
        ['a'.repeat(64), f.kit.org.id, now + 60_000, JSON.stringify(['b'.repeat(64)])],
      );
    case 'existing':
      return stmt(db, 'INSERT INTO credential_ref_keyset (id,commitment) VALUES (1,?)', [
        f.commitment === '0'.repeat(64) ? '1'.repeat(64) : '0'.repeat(64),
      ]);
  }
}

/** Explain the actual bound initializer and inject one change after the actual claim acquisition. */
async function atInitialization(f: Fixture, change: Change) {
  const real = f.kit.env.DB;
  const pending = mutation(f, change);
  const captured = new WeakMap<D1PreparedStatement, { sql: string; values: unknown[] }>();
  const observed: {
    value: {
      index: number;
      binds: number;
      acquired: unknown;
      mutation: unknown;
      initialized: number | undefined;
      clear: number;
      candidates: number;
    } | null;
  } = { value: null };
  const db = new Proxy(real, {
    get(target, property) {
      if (property === 'prepare')
        return (sql: string) => {
          const prepared = target.prepare(sql);
          if (!sql.includes('INSERT INTO credential_ref_keyset')) return prepared;
          return new Proxy(prepared, {
            get(statement, member) {
              if (member === 'bind')
                return (...values: unknown[]) => {
                  const bound = statement.bind(...values);
                  captured.set(bound, { sql, values });
                  return bound;
                };
              const value = Reflect.get(statement, member, statement);
              return typeof value === 'function' ? value.bind(statement) : value;
            },
          });
        };
      if (property === 'batch')
        return async (statements: D1PreparedStatement[]) => {
          const index = statements.findIndex((statement) => captured.has(statement));
          if (index < 0 || observed.value) return target.batch(statements);
          const bound = captured.get(statements[index]!);
          if (!bound) throw new Error('Missing bound initializer');
          await target
            .prepare(`EXPLAIN ${bound.sql}`)
            .bind(...bound.values)
            .all();
          const inserted = pending
            ? [
                target.prepare('SELECT changes() AS n'),
                pending,
                target.prepare('SELECT changes() AS n'),
              ]
            : [target.prepare('SELECT changes() AS n')];
          const result = await target.batch<{ n: number }>([
            ...statements.slice(0, index),
            ...inserted,
            ...statements.slice(index),
          ]);
          const initIndex = index + inserted.length;
          observed.value = {
            index,
            binds: bound.values.length,
            acquired: result[index]?.results[0]?.n,
            mutation: pending ? result[index + 2]?.results[0]?.n : null,
            initialized: result[initIndex]?.meta.changes,
            clear: result[initIndex + 1]?.results.length ?? -1,
            candidates: result[initIndex + 2]?.results.length ?? -1,
          };
          return [...result.slice(0, index), ...result.slice(initIndex)];
        };
      const value = Reflect.get(target, property, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  Object.assign(f.kit.env, { DB: db });
  try {
    const response = await f.post();
    const body = await response.text();
    if (!observed.value) throw new Error('Action did not reach the keyset initialization batch');
    return { response, body, observed: observed.value };
  } finally {
    Object.assign(f.kit.env, { DB: real });
  }
}

it('initializes the exact keyset in the real scoped action claim batch', async () => {
  const f = await fixture();
  expect(await first(f.kit.env.DB, 'SELECT commitment FROM credential_ref_keyset')).toBeNull();
  const { response, body, observed } = await atInitialization(f, 'none');
  expect(observed).toMatchObject({
    index: 2,
    acquired: 1,
    initialized: 1,
    clear: 1,
    candidates: 1,
  });
  expect(observed.binds).toBeGreaterThan(40);
  expect(observed.binds).toBeLessThanOrEqual(100);
  expect(response.status).toBe(200);
  expect(JSON.parse(body)).toMatchObject({ kind: 'ok', scanId: expect.any(String) });
  expect(await first(f.kit.env.DB, 'SELECT commitment FROM credential_ref_keyset')).toEqual({
    commitment: f.commitment,
  });
});

it.each([
  'session',
  'scanner csrf',
  'membership',
  'event',
  'event templates',
  'template release',
  'claim',
  'no change',
  'retained',
  'existing',
] as const)(
  'does not initialize or expose a candidate after an intervening %s change',
  async (change) => {
    const f = await fixture();
    const { body, observed } = await atInitialization(f, change);
    expect(observed).toMatchObject({
      index: 2,
      acquired: 1,
      mutation: change === 'no change' ? 0 : 1,
      initialized: 0,
      clear: 0,
      candidates: change === 'existing' ? 1 : 0,
    });
    expect(body).not.toContain(f.pass.id);
    expect(body).not.toContain(f.commitment);
    const actual = await first<{ commitment: string }>(
      f.kit.env.DB,
      'SELECT commitment FROM credential_ref_keyset',
    );
    if (change === 'existing')
      expect(actual).toEqual({
        commitment: f.commitment === '0'.repeat(64) ? '1'.repeat(64) : '0'.repeat(64),
      });
    else expect(actual).toBeNull();
  },
);

it('preserves grouped OR, nulls, quoted parentheses and bind order in the claim fence', async () => {
  const f = await fixture();
  const db = f.kit.env.DB;
  const actorKey = f.actorKey;
  const idempotencyKey = f.request.idempotencyKey;
  await run(
    db,
    `INSERT INTO scans
    (id,org_id,mode,actor_type,actor_id,actor_key,idempotency_key,request_hash,method,state,at)
    VALUES (?,?, 'live','user',?,?,?,'hash','manual','pending',?)`,
    [
      f.kit.fx.ids.id(),
      f.kit.org.id,
      actorKey.slice(2),
      actorKey,
      idempotencyKey,
      f.kit.clock.now(),
    ],
  );
  const pristine = {
    sql: 'scans.org_id=? AND scans.request_hash=?',
    params: [f.kit.org.id, 'hash'],
  };
  const expression = `((?='quoted ) AND ( value') AND ((? IS NULL) OR (?=1)))
    AND ((?='escaped '' ) AND ( value') AND (?=1 /* ) AND ( */))`;
  const cases = [
    { params: ['quoted ) AND ( value', null, 0, "escaped ' ) AND ( value", 1], expected: 1 },
    { params: ['quoted ) AND ( value', 'not null', 0, "escaped ' ) AND ( value", 1], expected: 0 },
    { params: ['quoted ) AND ( value', null, 0, "escaped ' ) AND ( value", 0], expected: 0 },
  ];
  for (const { params, expected } of cases) {
    const guard = { sql: expression, params };
    const staged = candidateInitializationFence(actorKey, idempotencyKey, pristine, guard);
    const original = `changes()=1 AND EXISTS (SELECT 1 FROM scans
      WHERE scans.actor_key=? AND scans.idempotency_key=? AND scans.state='pending'
        AND (${pristine.sql})) AND (${guard.sql})`;
    const [, direct, isolated] = await db.batch<{ valid: number }>([
      stmt(db, 'UPDATE scans SET at=at WHERE actor_key=? AND idempotency_key=?', [
        actorKey,
        idempotencyKey,
      ]),
      stmt(db, `SELECT CASE WHEN (${original}) THEN 1 ELSE 0 END AS valid`, [
        actorKey,
        idempotencyKey,
        ...pristine.params,
        ...guard.params,
      ]),
      stmt(db, `SELECT CASE WHEN (${staged.sql}) THEN 1 ELSE 0 END AS valid`, staged.params),
    ]);
    expect(direct?.results).toEqual([{ valid: expected }]);
    expect(isolated?.results).toEqual(direct?.results);
  }
});
