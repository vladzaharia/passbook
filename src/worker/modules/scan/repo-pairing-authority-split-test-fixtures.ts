import type { OpenAPIHono } from '@hono/zod-openapi';
import { beforeAll, expect } from 'vitest';
import { fakeRateLimiter, makeSession, makeUser } from '../../../../test/helpers/index.ts';
import type { OrgRole } from '../../../shared/contracts/org-membership.ts';
import { createApp } from '../../app.ts';
import { denyAllStores } from '../../platform/auth.ts';
import type { AppBindings } from '../../platform/context.ts';
import { all, first } from '../../platform/db.ts';
import { sha256Hex } from '../../platform/ids.ts';
import { createSessionStore } from '../auth/sessions.ts';
import { createScannerStore } from './auth-store.ts';
import { grantScanMembership, type ScanKit, setupScanKit } from './test-kit.ts';

export const ORIGIN = 'https://wallet.test';
export let kit: ScanKit;
let app: OpenAPIHono<AppBindings>;
export let templateId: string;
export let releaseId: string;

export const setupPairingAuthorityFixture = () =>
  beforeAll(async () => {
    kit = await setupScanKit();
    Object.assign(kit.env, { RL_SCAN_PAIR: fakeRateLimiter({ limit: 1000 }) });
    templateId = await kit.scanTemplate(
      'Pairing sample',
      { actions: [{ id: 'check_in', label: 'Check in', kind: 'check_in' }] },
      { releaseModes: ['live'] },
    );
    app = createApp({
      clock: kit.clock,
      stores: {
        ...denyAllStores,
        sessions: createSessionStore(kit.env, kit.clock),
        scanners: createScannerStore(kit.env, kit.clock),
      },
    });
    const author = await member();
    const reviewer = await member();
    const authorHeaders = { ...author.session.headers, 'x-passbook-mode': 'test' };
    const reviewerHeaders = { ...reviewer.session.headers, 'x-passbook-mode': 'test' };
    const scope = { orgId: kit.org.id, mode: 'test', provider: 'apple' };
    const base = `/templates/${templateId}`;
    const candidateResponse = await request('POST', `${base}/candidates`, authorHeaders, {
      ...scope,
      version: (await kit.registry.resolve(templateId)).version,
    });
    expect(candidateResponse.status).toBe(201);
    const candidate = (await candidateResponse.json()) as { id: string; candidateHash: string };
    const approvalResponse = await request(
      'POST',
      `${base}/candidates/${candidate.id}/approve`,
      reviewerHeaders,
      { ...scope, candidateHash: candidate.candidateHash },
    );
    expect(approvalResponse.status).toBe(201);
    const approval = (await approvalResponse.json()) as { id: string };
    const releaseResponse = await request('POST', `${base}/releases`, authorHeaders, {
      ...scope,
      candidateId: candidate.id,
      approvalId: approval.id,
      candidateHash: candidate.candidateHash,
      expectedGeneration: 0,
    });
    expect(releaseResponse.status).toBe(201);
    releaseId = ((await releaseResponse.json()) as { id: string }).id;
  }, 60_000);

export async function member(roles: OrgRole[] = ['org_admin'], platformAdmin = false) {
  const user = await makeUser(kit.fx);
  const membershipId = await grantScanMembership(kit.fx, kit.org.id, user.id, roles);
  const session = await makeSession(kit.fx, {
    userId: user.id,
    roles: platformAdmin ? ['admin', 'user'] : ['user'],
  });
  return { user, membershipId, session, sessionId: await sha256Hex(session.cookieValue) };
}

export function request(
  method: string,
  path: string,
  headers: Record<string, string>,
  body?: unknown,
) {
  return Promise.resolve(
    app.request(
      `${ORIGIN}/api/v1${path}`,
      {
        method,
        headers: {
          ...headers,
          origin: ORIGIN,
          'sec-fetch-site': 'same-origin',
          'content-type': 'application/json',
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      },
      kit.env,
    ),
  );
}

export const scannerPath = (id: string, action: string) => `/scanners/${id}/${action}`;

type CommitTarget = 'code' | 'credential' | 'pass';

/** Change real D1 state after authorization, just before the guarded write executes. */
export async function atCommit<T>(
  targetKind: CommitTarget,
  change: (db: D1Database) => Promise<void>,
  call: () => Promise<T>,
): Promise<T> {
  const db = kit.env.DB;
  const statements = new WeakMap<
    D1PreparedStatement,
    { sql: string; native: D1PreparedStatement }
  >();
  let intercepted = 0;
  const matches = (sql: string) => {
    if (targetKind === 'pass') return /^\s*INSERT\s+INTO\s+passes\b/i.test(sql);
    if (targetKind === 'code') return /^\s*UPDATE\s+scanners\s+SET\s+pair_code_hash\b/i.test(sql);
    return /^\s*UPDATE\s+scanners\s+SET\s+token_prefix\b/i.test(sql);
  };
  const intervene = async (sql: string) => {
    if (!intercepted && matches(sql)) {
      intercepted++;
      await change(db);
    }
  };
  const wrap = (native: D1PreparedStatement, sql: string): D1PreparedStatement => {
    const wrapped = new Proxy(native, {
      get(target, prop) {
        if (prop === 'bind') return (...values: unknown[]) => wrap(target.bind(...values), sql);
        if (prop === 'first')
          return async (column?: string) => {
            await intervene(sql);
            return column === undefined ? target.first() : target.first(column);
          };
        if (prop === 'run')
          return async () => {
            await intervene(sql);
            return target.run();
          };
        if (prop === 'all')
          return async () => {
            await intervene(sql);
            return target.all();
          };
        const value = Reflect.get(target, prop, target);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    statements.set(wrapped, { sql, native });
    return wrapped;
  };
  const proxy = new Proxy(db, {
    get(target, prop) {
      if (prop === 'prepare') return (sql: string) => wrap(target.prepare(sql), sql);
      if (prop === 'batch')
        return async (batch: D1PreparedStatement[]) => {
          for (const statement of batch) await intervene(statements.get(statement)?.sql ?? '');
          return target.batch(
            batch.map((statement) => statements.get(statement)?.native ?? statement),
          );
        };
      const value = Reflect.get(target, prop, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  Object.assign(kit.env, { DB: proxy });
  try {
    const result = await call();
    expect(intercepted, `${targetKind} mutation reached`).toBe(1);
    return result;
  } finally {
    Object.assign(kit.env, { DB: db });
  }
}

export async function scannerState(id: string) {
  return {
    scanner: await first(kit.env.DB, 'SELECT * FROM scanners WHERE id = ?', [id]),
    audit: await all(kit.env.DB, 'SELECT * FROM audit_log WHERE target_id = ? ORDER BY id', [id]),
  };
}

export async function passState() {
  return {
    passes: await all(kit.env.DB, 'SELECT id FROM passes ORDER BY id'),
    objects: (await kit.env.BUCKET.list({ prefix: 'passes/' })).objects.map((o) => o.key).sort(),
  };
}
