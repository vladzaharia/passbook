/* istanbul ignore file -- @preserve */
import { expect } from 'vitest';
import { makeSession, makeUser, type ScannerFixture } from '../../../../test/helpers/index.ts';
import type { ScanOutcome } from '../../../shared/contracts/scan.ts';
import { all, first, run } from '../../platform/db.ts';
import { createSessionStore } from '../auth/sessions.ts';
import { type TenantPassWrite, tenantAuthorityOf } from '../passes/http.ts';
import type { Pass } from '../passes/repo.ts';
import {
  captureConsoleSessionCountAuthority,
  type SessionCountAuthority,
} from './scanning-session-dto.ts';
import { codeOf, grantScanMembership, key, type ScanKit, setupScanKit } from './test-kit.ts';

export let kit: ScanKit;
export let template: string;
export let managerTemplate: string;
export let otherOwner: string;
export let sessionCreator: string;
export let sessionWriteAuthority: TenantPassWrite;
export let sessionCountAuthority: SessionCountAuthority;

export async function setupCommitFenceFixture() {
  kit = await setupScanKit();
  template = await kit.scanTemplate('Commit fence entry', {
    actions: [{ id: 'check_in', label: 'Check in', kind: 'check_in' }],
  });
  managerTemplate = await kit.scanTemplate('Manager commit fence entry', {
    actions: [{ id: 'check_in', label: 'Check in', kind: 'check_in', minRole: 'manager' }],
  });
  otherOwner = (await makeUser(kit.fx)).id;
  sessionCreator = (await makeUser(kit.fx)).id;
  await grantScanMembership(kit.fx, kit.org.id, sessionCreator);
  const fixture = await makeSession(kit.fx, { userId: sessionCreator });
  const auth = await createSessionStore(kit.env, kit.clock).resolve(fixture.cookieValue);
  if (!auth) throw new Error('Missing session creator login.');
  sessionWriteAuthority = await tenantAuthorityOf(kit.ctx, auth, kit.org.id, 'scanning:manage');
  sessionCountAuthority = await captureConsoleSessionCountAuthority(
    kit.ctx,
    auth,
    await tenantAuthorityOf(kit.ctx, auth, kit.org.id, 'scanning:read'),
  );
}

type Scanner = ScannerFixture;
type BatchKind = 'check-in' | 'stop' | 'gate-loser' | 'undo';
type Mutation = (db: D1Database, scanId: string) => Promise<void>;

export const tracking = { checkIn: { mode: 'in_out' }, direction: 'both' };

export const maskedNotFound = {
  scanId: null,
  kind: 'refused',
  reason: 'not_found',
  replay: false,
  action: null,
  card: null,
  display: null,
  template: null,
  previous: null,
  undoUntil: null,
  approvals: false,
  overridable: false,
  milestone: null,
  access: null,
  group: null,
  value: null,
  at: null,
  flags: [],
  counts: { today: 0, event: null, asOf: 0, configRev: 0 },
};

export async function action(
  scanner: Scanner,
  pass: Pass,
  idempotencyKey: string,
  extra: Record<string, unknown> = {},
) {
  return kit.post(scanner.headers, '/actions', {
    idempotencyKey,
    input: codeOf(pass),
    clientTs: kit.clock.now(),
    actionId: 'check_in',
    ...extra,
  });
}

/** Record only statements prepared through this request. Every statement still runs on real D1. */
export async function atCommit<T>(
  kind: BatchKind,
  mutate: (db: D1Database) => Promise<void>,
  call: () => Promise<T>,
) {
  const db = kit.env.DB;
  const sqlOf = new WeakMap<D1PreparedStatement, { sql: string; values: unknown[] }>();
  let intercepted = 0;
  // Every commit, held finish and stop opens its batch with a grant; the claim has its own.
  const isCommitGrant = (q: { sql: string; values: unknown[] }) =>
    /\bINSERT\s+INTO\s+authority_grants\b/i.test(q.sql) &&
    !q.values.includes('org_mode.scan.claim');
  const matches = (queries: { sql: string; values: unknown[] }[]) => {
    const grant = queries.some(isCommitGrant);
    const gateInsert = queries.some((q) => /\bINSERT\s+INTO\s+scan_gates\b/i.test(q.sql));
    if (kind === 'check-in') return grant && gateInsert;
    if (kind === 'undo') return queries.some((q) => /\bUPDATE\s+scan_gates\s+SET\b/i.test(q.sql));
    return grant && !gateInsert;
  };
  const proxy = new Proxy(db, {
    get(target, property) {
      if (property === 'prepare') {
        return (sql: string) => {
          const statement = target.prepare(sql);
          return new Proxy(statement, {
            get(prepared, member) {
              if (member === 'bind') {
                return (...values: unknown[]) => {
                  const bound = prepared.bind(...values);
                  sqlOf.set(bound, { sql, values });
                  return bound;
                };
              }
              const value = Reflect.get(prepared, member, prepared);
              return typeof value === 'function' ? value.bind(prepared) : value;
            },
          });
        };
      }
      if (property === 'batch') {
        return async (statements: D1PreparedStatement[]) => {
          const queries = statements.map(
            (statement) => sqlOf.get(statement) ?? { sql: '', values: [] },
          );
          if (intercepted === 0 && matches(queries)) {
            intercepted++;
            // The complete batch has already been built from the resolved pass and actor. Mutate
            // through the original connection immediately before D1 executes that batch.
            await mutate(db);
          }
          return target.batch(statements);
        };
      }
      const value = Reflect.get(target, property, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  Object.assign(kit.env, { DB: proxy });
  try {
    const result = await call();
    expect(intercepted, `the ${kind} commit batch was reached`).toBe(1);
    return result;
  } finally {
    Object.assign(kit.env, { DB: db });
  }
}

export interface Effects {
  pass: unknown;
  gates: unknown[];
  scans: unknown[];
  ledger: unknown[];
  presence: unknown[];
  audit: unknown[];
}

/** Concrete pre/post snapshots, including the original rows when testing undo or a stale gate. */
export async function effects(db: D1Database, passId: string): Promise<Effects> {
  return {
    pass: await first(
      db,
      `SELECT p.*, c.generation AS connection_generation
      FROM passes p LEFT JOIN connections c ON c.id = p.connection_id WHERE p.id = ?`,
      [passId],
    ),
    gates: await all(db, 'SELECT * FROM scan_gates WHERE pass_id = ? ORDER BY action_id, scope', [
      passId,
    ]),
    scans: await all(db, 'SELECT * FROM scans WHERE pass_id = ? ORDER BY id', [passId]),
    ledger: await all(
      db,
      "SELECT * FROM pass_events WHERE pass_id = ? AND kind LIKE 'scan.%' ORDER BY id",
      [passId],
    ),
    presence: await all(db, 'SELECT * FROM scan_presence WHERE pass_id = ? ORDER BY scope', [
      passId,
    ]),
    audit: await all(
      db,
      "SELECT * FROM audit_log WHERE org_id = ? AND action LIKE 'scan.%' ORDER BY id",
      [kit.org.id],
    ),
  };
}

export async function pending(db: D1Database, scanner: Scanner, idempotencyKey: string) {
  const row = await first<{ id: string; state: string; pass_id: string | null }>(
    db,
    'SELECT id, state, pass_id FROM scans WHERE actor_key = ? AND idempotency_key = ?',
    [`s:${scanner.id}`, idempotencyKey],
  );
  expect(row).toMatchObject({ state: 'pending', pass_id: null });
  if (!row) throw new Error('The action did not reach its pending claim.');
  return row.id;
}

const CODE_STATUS = {
  SCAN_PASS_CHANGED: 409,
  SCAN_CONFIG_CHANGED: 409,
  SCAN_STAFF_CHANGED: 409,
  SCAN_IN_PROGRESS: 409,
  SCANNER_REPAIR: 401,
  ACTOR_CHANGED: 403,
  ORG_ACCESS_CHANGED: 403,
} as const;
export type FenceCode = keyof typeof CODE_STATUS;

/** A classified refusal: status and code, no effect of any kind, and the claim released unfinished. */
export async function expectRefusedWith(
  response: Response,
  code: FenceCode,
  scanId: string,
  passId: string,
  before: Effects | undefined,
) {
  const body = (await response.json()) as { code?: string };
  expect(`${response.status} ${body.code}`).toBe(`${CODE_STATUS[code]} ${code}`);
  expect(before).toBeDefined();
  expect(await effects(kit.env.DB, passId)).toEqual(before);
  const claim = await first<{ state: string; outcome: string | null }>(
    kit.env.DB,
    'SELECT state, outcome FROM scans WHERE id = ?',
    [scanId],
  );
  expect(claim === null || (claim.state === 'failed' && claim.outcome === null)).toBe(true);
}

/**
 * `code` is the classified refusal the grant gives. 'admitted' is for content that is not authority
 * (a version, a link generation, a connection sync): the scan is recorded.
 */
export async function expectFencedAction(
  scanner: Scanner,
  pass: Pass,
  mutate: Mutation,
  options: {
    kind?: 'check-in' | 'stop' | 'gate-loser';
    extra?: Record<string, unknown>;
    code: FenceCode | 'admitted';
  },
) {
  const idempotencyKey = key();
  let before: Effects | undefined;
  let scanId = '';
  const response = await atCommit(
    options.kind ?? 'check-in',
    async (db) => {
      scanId = await pending(db, scanner, idempotencyKey);
      await mutate(db, scanId);
      before = await effects(db, pass.id);
    },
    () => action(scanner, pass, idempotencyKey, options.extra),
  );
  if (options.code === 'admitted') {
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ scanId });
    expect(await all(kit.env.DB, 'SELECT id FROM scans WHERE id = ?', [scanId])).toHaveLength(1);
    return;
  }
  await expectRefusedWith(response, options.code, scanId, pass.id, before);
}

export async function undoResponse(scanner: Scanner, scanId: string, idempotencyKey: string) {
  return kit.post(scanner.headers, `/scans/${scanId}/undo`, { idempotencyKey });
}

export async function accepted(scanner: Scanner, pass: Pass, extra: Record<string, unknown> = {}) {
  const response = await action(scanner, pass, key(), extra);
  expect(response.status).toBe(200);
  const outcome = (await response.json()) as ScanOutcome;
  expect(outcome).toMatchObject({ kind: 'ok', reason: null, replay: false });
  if (!outcome.scanId) throw new Error('A successful scan must have an id.');
  return outcome.scanId;
}

export async function connect(pass: Pass) {
  const connection = kit.fx.ids.id();
  await run(
    kit.env.DB,
    `INSERT INTO connections (id, org_id, connector_type, name, generation, created_at, updated_at)
     VALUES (?, ?, 'demo', ?, 1, ?, ?)`,
    [connection, kit.org.id, `fence-${connection}`, kit.clock.now(), kit.clock.now()],
  );
  await run(
    kit.env.DB,
    "UPDATE passes SET connection_id = ?, external_ref = 'fence' WHERE id = ?",
    [connection, pass.id],
  );
  return connection;
}
