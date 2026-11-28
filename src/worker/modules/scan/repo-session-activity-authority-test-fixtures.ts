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
import { afterBatch, beforeBatch } from './batch-interceptor-test-support.ts';
import { DEFAULT_SETTINGS } from './dto-console.ts';
import { RACE_HISTORY_PAGE } from './race-tags.ts';
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

/**
 * Interleave a real database change at the activity page batch: before it (the change is in the
 * snapshot the page reads) or after it (the answer is the snapshot's, and the next request shows
 * the change).
 */
export async function atActivityRead<T>(
  env: { DB: D1Database },
  operation: () => Promise<T>,
  change: (db: D1Database) => Promise<void>,
  options: { when?: 'before' | 'after' } = {},
): Promise<T> {
  const hook = options.when === 'after' ? afterBatch : beforeBatch;
  const { result, fired } = await hook(env, RACE_HISTORY_PAGE, change, operation);
  expect(fired).toBe(true);
  return result;
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
