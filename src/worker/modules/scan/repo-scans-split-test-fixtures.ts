import type { OpenAPIHono } from '@hono/zod-openapi';
import { beforeEach, expect } from 'vitest';
import {
  type FakeAuth,
  type Fixtures,
  fakeAuth,
  fixtures,
  makeEnv,
  makeOrg,
  makePass,
  makeScanEvent,
  makeScanner,
  makeScanStaff,
  makeSession,
  makeTemplate,
  makeUser,
  persistTemplate,
  type ScannerFixture,
  type TestTemplate,
} from '../../../../test/helpers/index.ts';
import type { ScanOutcome } from '../../../shared/contracts/scan.ts';
import { createApp } from '../../app.ts';
import { ManualClock } from '../../platform/clock.ts';
import type { AppBindings } from '../../platform/context.ts';
import { run } from '../../platform/db.ts';
import type { AppEnv } from '../../platform/env.ts';
import { createServiceContext, type ServiceContext } from '../../platform/service-context.ts';
import { createSessionStore } from '../auth/sessions.ts';
import { approveAppleRelease } from '../passes/apple-release-test-fixtures.ts';
import { createScannerStore } from './auth-store.ts';
import { grantScanMembership, key } from './test-kit.ts';

export const ORIGIN = 'https://wallet.test';
export const DAY = 86_400_000;

export const codeOf = async (res: Response) => {
  // The tests assert the error returned by this in-process route.
  const body = (await res.json()) as { code: string };
  return body.code;
};

export let env: AppEnv;
export let f: Fixtures;
export let clock: ManualClock;
export let ctx: ServiceContext;
export let fake: FakeAuth;
export let app: OpenAPIHono<AppBindings>;
export let orgId: string;
export let userId: string;
let adminHeaders: Record<string, string>;
export let userHeaders: Record<string, string>;
export let template: TestTemplate;
export let scannerFixture: ScannerFixture;
export let scannerId: string;
export let staffId: string;
export let eventId: string;
export let passId: string;
export let liveReleaseId: string;
let testReleaseId: string;

/** The pass_created trigger already wrote version 1 with no body; fill in the signed JSON. */
export async function recordVersion(id: string) {
  await run(
    env.DB,
    `INSERT INTO pass_versions
    (pass_id,version,template_version,personalization,pass_json,cause,created_at)
    SELECT p.id,p.version,p.template_version,p.personalization,
      json_set(tv.pass_json, '$.serialNumber', p.serial, '$.passTypeIdentifier', si.pass_type_identifier,
        '$.teamIdentifier', si.team_identifier), 'create', ?
    FROM passes p JOIN template_versions tv ON tv.template_id=p.template_id AND tv.version=p.template_version
      JOIN signing_identities si ON si.id=p.identity_id
    WHERE p.id=?
    ON CONFLICT(pass_id,version) DO UPDATE SET template_version=excluded.template_version,
      personalization=excluded.personalization, pass_json=excluded.pass_json`,
    [clock.now(), id],
  );
}

beforeEach(async () => {
  clock = new ManualClock(Date.UTC(2026, 5, 1, 12));
  env = await makeEnv();
  f = fixtures(env, clock);
  ctx = createServiceContext(env, { clock });
  fake = fakeAuth(ORIGIN);
  fake.bindApiKeys(env, clock);
  app = createApp({
    stores: {
      ...fake.stores,
      sessions: createSessionStore(env, clock),
      scanners: createScannerStore(env, clock),
    },
    clock,
  });
  await run(env.DB, 'DELETE FROM counters');
  userId = (await makeUser(f)).id;
  orgId = (await makeOrg(f)).id;
  await grantScanMembership(f, orgId, userId);
  adminHeaders = {
    ...(await makeSession(f, { userId, roles: ['admin', 'user'] })).headers,
    origin: ORIGIN,
  };
  const outsider = await makeUser(f);
  await grantScanMembership(f, orgId, outsider.id, ['template_author']);
  userHeaders = { ...(await makeSession(f, { userId: outsider.id })).headers, origin: ORIGIN };
  template = makeTemplate({ id: f.ids.id(), orgId });
  Object.assign(template.resolved.manifest, {
    scan: { actions: [{ id: 'enter', label: 'Let in', kind: 'check_in', repeat: 'always' }] },
  });
  await persistTemplate(f, template.resolved, { registry: template.registry });
  for (const mode of ['live', 'test'] as const) {
    const release = await approveAppleRelease(
      { ctx, fx: f, registry: template.registry },
      { orgId, mode, templateId: template.resolved.id, version: template.resolved.version },
    );
    if (mode === 'live') liveReleaseId = release.id;
    else testReleaseId = release.id;
  }
  await run(env.DB, 'DELETE FROM audit_log');
  staffId = (await makeScanStaff(f, { orgId, name: 'Dana', role: 'manager' })).id;
  eventId = (await makeScanEvent(f, { orgId, templateIds: [template.resolved.id] })).id;
  scannerFixture = await makeScanner(f, {
    orgId,
    eventId,
    staffId,
    settings: { staffSignIn: true },
  });
  scannerId = scannerFixture.id;
  passId = (
    await makePass(f, {
      orgId,
      template: template.resolved,
      personalization: { memberName: 'Alex Morgan' },
    })
  ).id;
  await run(env.DB, 'UPDATE passes SET release_id = ? WHERE id = ?', [liveReleaseId, passId]);
  await recordVersion(passId);
  await run(
    env.DB,
    "UPDATE passes SET display_title = 'Alex Morgan', external_id = 'ext-1' WHERE id = ?",
    [passId],
  );
});

let seq = 0;
export async function seed(over: Record<string, unknown> = {}) {
  if (over.mode === 'test' && over.pass_id === undefined) {
    const pass = await makePass(f, { orgId, template: template.resolved, mode: 'test' });
    await run(env.DB, 'UPDATE passes SET release_id=? WHERE id=?', [testReleaseId, pass.id]);
    await recordVersion(pass.id);
    const scanner = await makeScanner(f, {
      orgId,
      mode: 'test',
      templateIds: [template.resolved.id],
    });
    over = {
      ...over,
      pass_id: pass.id,
      scanner_id: scanner.id,
      event_id: null,
      staff_id: null,
      actor_id: scanner.id,
      actor_key: `s:${scanner.id}`,
    };
  }
  const row = {
    id: f.ids.id(),
    org_id: orgId,
    mode: 'live',
    pass_id: passId,
    template_id: over.pass_id === null ? null : template.resolved.id,
    scanner_id: scannerId,
    event_id: eventId,
    actor_type: 'scanner',
    actor_id: scannerId,
    actor_key: `s:${scannerId}`,
    staff_id: staffId,
    idempotency_key: `k${++seq}-${f.ids.token(4)}`,
    request_hash: 'h',
    method: 'camera',
    state: 'done',
    outcome: 'ok',
    reason: null,
    action_id: 'enter',
    action_kind: 'check_in',
    pass_version: over.pass_id === null ? null : 1,
    at: clock.advance(1000),
    ...over,
  };
  const keys = Object.keys(row);
  await run(
    env.DB,
    `INSERT INTO scans (${keys.join(', ')}) VALUES (${keys.map(() => '?').join(', ')})`,
    Object.values(row) as never[],
  );
  return row;
}

export async function recordedAction(
  scanner: ScannerFixture,
  targetPassId: string,
  actionId = 'enter',
) {
  clock.advance(1000);
  const response = await app.request(
    `${ORIGIN}/api/v1/scan/actions`,
    {
      method: 'POST',
      headers: { ...scanner.headers, 'content-type': 'application/json' },
      body: JSON.stringify({
        idempotencyKey: key(),
        input: { passId: targetPassId, method: 'manual' },
        clientTs: clock.now(),
        actionId,
      }),
    },
    env,
  );
  expect(response.status).toBe(200);
  const outcome: ScanOutcome = await response.json();
  expect(outcome).toMatchObject({ kind: 'ok', reason: null, replay: false });
  if (!outcome.scanId || outcome.at === null)
    throw new Error('A successful scan must have an id and time.');
  return { id: outcome.scanId, at: outcome.at };
}

export async function recordedNoMatch(scanner: ScannerFixture) {
  clock.advance(1000);
  const response = await app.request(
    `${ORIGIN}/api/v1/scan/actions`,
    {
      method: 'POST',
      headers: { ...scanner.headers, 'content-type': 'application/json' },
      body: JSON.stringify({
        idempotencyKey: key(),
        input: { code: `NO-MATCH-${key()}`, method: 'camera' },
        clientTs: clock.now(),
        actionId: 'enter',
      }),
    },
    env,
  );
  expect(response.status).toBe(200);
  const outcome: ScanOutcome = await response.json();
  expect(outcome).toMatchObject({ kind: 'refused', reason: 'not_found', replay: false });
  if (!outcome.scanId || outcome.at === null)
    throw new Error('A no-match scan must have an id and time.');
  return { id: outcome.scanId, at: outcome.at };
}

export const admin = (mode?: 'test') => ({
  ...adminHeaders,
  ...(mode ? { 'x-passbook-mode': mode } : {}),
});
export const get = (path: string, headers: Record<string, string> = admin()) =>
  app.request(`${ORIGIN}/api/v1/scans${path}`, { headers }, env);
export const post = (path: string, body: unknown, headers = admin(), target = app) =>
  target.request(
    `${ORIGIN}/api/v1/scans${path}`,
    {
      method: 'POST',
      headers: { ...headers, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    },
    env,
  );
export type Rec = Record<string, unknown>;
export const items = async (res: Response) => {
  // The tests assert the items returned by this in-process route.
  const body = (await res.json()) as { items: Rec[] };
  return body.items;
};
