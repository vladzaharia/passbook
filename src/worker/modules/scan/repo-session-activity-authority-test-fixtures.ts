import { expect } from 'vitest';
import { makeSession, makeUser, type ScannerFixture } from '../../../../test/helpers/index.ts';
import type { Mode } from '../../../shared/contracts/common.ts';
import { ScanOutcomeSchema } from '../../../shared/contracts/scan.ts';
import {
  ScanningSessionDetailSchema,
  SessionActivitySchema,
} from '../../../shared/contracts/scanning-sessions.ts';
import { createApp } from '../../app.ts';
import { denyAllStores } from '../../platform/auth.ts';
import { first, run } from '../../platform/db.ts';
import { createSessionStore } from '../auth/sessions.ts';
import type { Pass } from '../passes/repo.ts';
import { createScannerStore } from './auth-store.ts';
import { DEFAULT_SETTINGS } from './dto-console.ts';
import {
  codeOf,
  grantScanMembership,
  key,
  ORIGIN,
  type ScanKit,
  setupScanKit,
} from './test-kit.ts';

export const ACTIVITY_NAME = 'Activity Alice';
export const ACTION = {
  id: 'check_in',
  label: 'Check in',
  kind: 'check_in',
  repeat: 'always',
} as const;
type Role = 'door' | 'desk' | 'manager';

export async function activityFixture(
  options: { mode?: Mode; role?: Role; record?: boolean } = {},
) {
  const kit = await setupScanKit();
  const mode = options.mode ?? 'live';
  const template = await kit.scanTemplate('Activity passes', { actions: [ACTION] });
  const event = await kit.event({ mode, templateIds: [template] });
  const staff = options.role ? await kit.staff(options.role) : null;
  const settings = { ...DEFAULT_SETTINGS, staffSignIn: !!staff };
  const scanner = await kit.scanner({
    mode,
    eventId: event.id,
    ...(staff ? { staffId: staff.id, settings: { staffSignIn: true } } : {}),
  });
  const sessionId = await workspace(kit, scanner, { eventId: event.id }, settings);
  const user = await makeUser(kit.fx);
  const membershipId = await grantScanMembership(kit.fx, kit.org.id, user.id, ['org_admin']);
  const browser = await makeSession(kit.fx, { userId: user.id });
  const viewer = await makeUser(kit.fx);
  await grantScanMembership(kit.fx, kit.org.id, viewer.id, ['read_only']);
  const reader = await makeSession(kit.fx, { userId: viewer.id });
  const sessions = createSessionStore(kit.env, kit.clock);
  const auth = await sessions.resolve(browser.cookieValue);
  if (!auth) throw new Error('Missing real browser session');
  const app = createApp({
    clock: kit.clock,
    stores: {
      ...denyAllStores,
      sessions,
      scanners: createScannerStore(kit.env, kit.clock),
    },
  });
  const request = (path: string, headers: Record<string, string> = browser.headers) =>
    Promise.resolve(
      app.request(
        `${ORIGIN}/api/v1${path}`,
        {
          headers: {
            ...(mode === 'test' ? { 'x-passbook-mode': 'test' } : {}),
            ...headers,
            origin: ORIGIN,
          },
        },
        kit.env,
      ),
    );
  const device = () => request('/scan/activity', scanner.headers);
  const console = (headers = browser.headers) =>
    request(`/scanning-sessions/${sessionId}`, headers);
  const pass = await kit.scanPass(template, { memberName: ACTIVITY_NAME }, { mode });
  const scanId = options.record === false ? null : await record(kit, scanner, pass);
  return {
    kit,
    mode,
    template,
    event,
    staff,
    scanner,
    sessionId,
    user,
    membershipId,
    browser,
    reader,
    auth,
    request,
    device,
    console,
    pass,
    scanId,
  };
}

export async function workspace(
  kit: ScanKit,
  scanner: ScannerFixture,
  accepts: { eventId: string } | { templateIds: string[] } | null,
  settings: object = DEFAULT_SETTINGS,
) {
  const id = kit.fx.ids.id();
  const result = await run(
    kit.env.DB,
    `INSERT INTO scanning_sessions
    (id,org_id,mode,name,status,accepts,settings,time_zone,created_at,updated_at)
    SELECT ?,org_id,mode,'Activity session','active',?,?,'UTC',?,? FROM scanners WHERE id=?`,
    [
      id,
      accepts === null ? null : JSON.stringify(accepts),
      JSON.stringify(settings),
      kit.clock.now(),
      kit.clock.now(),
      scanner.id,
    ],
  );
  expect(result.changes).toBe(1);
  await attach(kit, scanner, id);
  return id;
}

export async function attach(kit: ScanKit, scanner: ScannerFixture, sessionId: string) {
  const result = await run(
    kit.env.DB,
    `INSERT INTO scanning_devices
    (scanner_id,session_id,org_id,mode,surface,effective_surface,overrides)
    SELECT id,?,org_id,mode,'phone','phone','{}' FROM scanners WHERE id=?`,
    [sessionId, scanner.id],
  );
  // The insert also bumps scanners.config_epoch; D1 counts trigger changes.
  expect(result.changes).toBe(2);
}

/** Commit a real action and its authenticated event and retention evidence. */
export async function record(kit: ScanKit, scanner: ScannerFixture, pass: Pass) {
  kit.clock.advance(1);
  const response = await kit.post(scanner.headers, '/actions', {
    idempotencyKey: key(),
    input: codeOf(pass),
    clientTs: kit.clock.now(),
    actionId: ACTION.id,
  });
  expect(response.status).toBe(200);
  const result = ScanOutcomeSchema.parse(await response.json());
  expect(result.kind).toBe('ok');
  if (!result.scanId) throw new Error('Missing committed scan');
  expect(
    await first(kit.env.DB, 'SELECT scan_id FROM scan_retention_proofs WHERE scan_id=?', [
      result.scanId,
    ]),
  ).toEqual({ scan_id: result.scanId });
  expect(
    await first(
      kit.env.DB,
      `SELECT id FROM pass_events WHERE pass_id=?
    AND json_extract(data,'$.scanId')=?`,
      [pass.id, result.scanId],
    ),
  ).not.toBeNull();
  return result.scanId;
}

export async function deviceRows(response: Response) {
  expect(response.status).toBe(200);
  return SessionActivitySchema.parse(await response.json()).items;
}

export async function consoleRows(response: Response) {
  expect(response.status).toBe(200);
  const body: unknown = await response.json();
  expect(body).toHaveProperty('activity');
  return ScanningSessionDetailSchema.parse(body).activity;
}

/** Interleave a real database change just before an activity batch. */
export async function atActivityRead<T>(
  env: { DB: D1Database },
  operation: () => Promise<T>,
  change: (db: D1Database) => Promise<void>,
  options: { phase?: 'initial' | 'final'; omitFinalRows?: boolean; omitProofRows?: boolean } = {},
): Promise<T> {
  const real = env.DB;
  const prepared = new WeakMap<
    D1PreparedStatement,
    { original: D1PreparedStatement; selected: boolean }
  >();
  let hits = 0;
  const selectedHit = options.phase === 'initial' ? 1 : 2;
  const intervene = async () => {
    if (++hits === selectedHit) await change(real);
  };
  const wrap = (statement: D1PreparedStatement, selected: boolean): D1PreparedStatement => {
    const proxy = new Proxy(statement, {
      get(target, member) {
        if (member === 'bind') return (...args: unknown[]) => wrap(target.bind(...args), selected);
        if (member === 'all' || member === 'first' || member === 'raw')
          return async (...args: unknown[]) => {
            if (selected) await intervene();
            return (Reflect.get(target, member, target) as (...values: unknown[]) => unknown).apply(
              target,
              args,
            );
          };
        const value = Reflect.get(target, member, target);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    prepared.set(proxy, { original: statement, selected });
    return proxy;
  };
  env.DB = new Proxy(real, {
    get(target, member) {
      if (member === 'prepare')
        return (sql: string) =>
          wrap(target.prepare(sql), /\bWITH\s+authorized_activity\s+AS\s*\(/i.test(sql));
      if (member === 'batch')
        return async (statements: D1PreparedStatement[]) => {
          const entries = statements.map(
            (statement) => prepared.get(statement) ?? { original: statement, selected: false },
          );
          const selected = entries.some((entry) => entry.selected);
          if (selected) await intervene();
          const results = await target.batch(entries.map((entry) => entry.original));
          if (selected && hits === selectedHit && options.omitProofRows) {
            expect(results.length).toBeGreaterThan(1);
            return results.map((result, index) =>
              index === 1 ? { ...result, results: [] } : result,
            );
          }
          return selected && hits === selectedHit && options.omitFinalRows
            ? results.map((result, index) => (index === 0 ? { ...result, results: [] } : result))
            : results;
        };
      const value = Reflect.get(target, member, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  try {
    const result = await operation();
    expect(hits).toBe(selectedHit);
    return result;
  } finally {
    env.DB = real;
  }
}

export async function noLeak(
  response: Response,
  status: number,
  code: string,
  ...secrets: string[]
) {
  expect(response.status).toBe(status);
  const text = await response.text();
  expect(JSON.parse(text)).toMatchObject({ code });
  for (const secret of secrets) expect(text).not.toContain(secret);
}
