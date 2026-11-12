import { expect } from 'vitest';
import { makeSession, makeUser } from '../../../../test/helpers/index.ts';
import { resolveSession } from '../auth/sessions.ts';
import { tenantAuthorityOf } from '../passes/http.ts';
import { putMemberPhoto } from '../passes/member-photo.ts';
import { makePng } from '../templates/package/fixtures.ts';
import { act, CHECK_IN, kit, out, tpl } from './act-test-fixtures.ts';
import { adminActor, captureScanTenantAuthority, tenantScanRole } from './actor.ts';
import {
  actionGateInsertSql,
  scanByIdempotencyKey,
  scanEventIds,
  scanGateRows,
} from './repo-act-support-test-fixtures.ts';
import { grantScanMembership } from './test-kit.ts';

export async function tenantActor(
  role: 'read_only' | 'pass_operator',
  capability: 'scanning:read' | 'passes:operate',
) {
  const user = await makeUser(kit.fx);
  const membershipId = await grantScanMembership(kit.fx, kit.org.id, user.id, [role]);
  const fixture = await makeSession(kit.fx, { userId: user.id, roles: ['user'] });
  const session = await resolveSession(kit.env, kit.clock, fixture.cookieValue);
  if (!session) throw new Error('Missing tenant session');
  const authority = await tenantAuthorityOf(kit.ctx, session, kit.org.id, capability);
  if (authority.kind !== 'session') throw new Error('Expected session authority');
  const actor = {
    ...adminActor(session, 'live', {
      orgId: kit.org.id,
      event: null,
      templateIds: [tpl],
      timeZone: 'UTC',
    }),
    role: tenantScanRole(authority),
    platformSessionId: session.sessionId,
    tenantAuthority: await captureScanTenantAuthority(kit.ctx, session, authority),
  };
  return { actor, user, membershipId, fixture };
}

/** Mutate after evaluation and immediately before the chosen atomic action batch. */
export async function raceGate(
  headers: Record<string, string>,
  input: unknown,
  mutate: (db: D1Database) => Promise<unknown>,
  over: Record<string, unknown> = {},
  statementSql = actionGateInsertSql,
  skipBatches = 0,
  send: typeof act = act,
): Promise<Response> {
  const original = kit.env.DB;
  const gateStatements = new WeakSet<D1PreparedStatement>();
  let raced = false;
  let matchingBatches = 0;
  const db = new Proxy(original, {
    get(target, prop) {
      if (prop === 'prepare')
        return (sql: string) => {
          const prepared = target.prepare(sql);
          if (!sql.includes(statementSql)) return prepared;
          return new Proxy(prepared, {
            get(statement, member) {
              if (member === 'bind')
                return (...params: unknown[]) => {
                  const bound = statement.bind(...params);
                  // The claim batch opens a grant too; the race is for the action's own batch.
                  if (!params.includes('org_mode.scan.claim')) gateStatements.add(bound);
                  return bound;
                };
              const value = Reflect.get(statement, member, statement);
              return typeof value === 'function' ? value.bind(statement) : value;
            },
          });
        };
      if (prop === 'batch')
        return async (statements: D1PreparedStatement[]) => {
          if (
            !raced &&
            statements.some((statement) => gateStatements.has(statement)) &&
            matchingBatches++ >= skipBatches
          ) {
            raced = true;
            await mutate(target);
          }
          return target.batch(statements);
        };
      const value = Reflect.get(target, prop, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  Object.assign(kit.env, { DB: db });
  try {
    const response = await send(headers, input, over);
    expect(
      raced,
      `no batch to race: ${response.status} ${(await response.clone().text()).slice(0, 200)}`,
    ).toBe(true);
    return response;
  } finally {
    Object.assign(kit.env, { DB: original });
  }
}

export async function photoGrantFixture(stop: boolean) {
  const template = await kit.scanTemplate('Deferred action photo', {
    actions: [CHECK_IN],
    flags: [{ input: 'tier', label: 'Review needed', equals: ['review'], stop: true }],
    display: { v: 1, header: {}, photo: { minRole: 'door' } },
  });
  const scanner = await kit.scanner({ templateIds: [template], settings: { flow: 'choose' } });
  const pass = await kit.scanPass(template, { tier: stop ? 'review' : 'clear' });
  const png = btoa(String.fromCharCode(...makePng(270, 270)));
  await putMemberPhoto(
    kit.ctx,
    { type: 'system', id: null },
    pass.id,
    { png, includeInPass: false },
    null,
  );
  return { scanner, pass };
}

export type BlockedCode =
  | 'SCAN_PASS_CHANGED'
  | 'SCAN_CONFIG_CHANGED'
  | 'SCAN_STAFF_CHANGED'
  | 'SCAN_IN_PROGRESS'
  | 'SCANNER_REPAIR'
  | 'ACTOR_CHANGED';

const STATUS: Record<BlockedCode, number> = {
  SCAN_PASS_CHANGED: 409,
  SCAN_CONFIG_CHANGED: 409,
  SCAN_STAFF_CHANGED: 409,
  SCAN_IN_PROGRESS: 409,
  SCANNER_REPAIR: 401,
  ACTOR_CHANGED: 403,
};

/**
 * A change between preflight and commit is refused by the grant with a classified 409 (a revoked or
 * retired credential is the 401 re-pair). Nothing is written, and the retry key is free again.
 */
export async function expectBlocked(
  response: Response,
  passId: string,
  idempotencyKey: string,
  code: BlockedCode,
) {
  const body = (await response.json()) as { code?: string };
  const got = `${response.status} ${body.code}`;
  if (got !== `${STATUS[code]} ${code}`) throw new Error(`BLOCKED ${got}`);
  expect(await scanGateRows(kit.env.DB, passId)).toHaveLength(0);
  expect(await scanEventIds(kit.env.DB, passId)).toHaveLength(0);
  // The claim is released as a pristine failure: the same key is retryable and nothing was decided.
  const claim = await scanByIdempotencyKey(kit.env.DB, idempotencyKey);
  expect(claim === null || (claim.state === 'failed' && claim.outcome === null)).toBe(true);
}

/**
 * A publish, an edit, a sync, a newer release or an identity swap between preflight and commit is not
 * authority (epochs: content is not authority), so the ticket is admitted and the scan is recorded.
 */
export async function expectAdmitted(response: Response, passId: string) {
  expect(response.status).toBe(200);
  const outcome = await out(response);
  expect(outcome.kind).not.toBe('refused');
  expect(outcome.scanId).not.toBeNull();
  expect(await scanGateRows(kit.env.DB, passId)).toHaveLength(1);
}
