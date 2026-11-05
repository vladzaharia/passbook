import { Hono } from 'hono';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  type Fixtures,
  fakeAuth,
  fixtures,
  makeEnv,
  makeOrg,
  makePass,
  makeScanEvent,
  makeScanner,
  makeScanStaff,
  makeTemplate,
  makeUser,
  persistTemplate,
} from '../../../../test/helpers/index.ts';
import { createApp } from '../../app.ts';
import { ManualClock } from '../../platform/clock.ts';
import { type AppBindings, requestContext } from '../../platform/context.ts';
import { all, first, run } from '../../platform/db.ts';
import type { AppEnv } from '../../platform/env.ts';
import { handleError } from '../../platform/error-handler.ts';
import { createScannerStore } from './auth-store.ts';
import { type ConsoleUndo, EXPORT_MAX_ROWS } from './feed.ts';
import { createScansRoutes } from './routes-scans.ts';

const ORIGIN = 'https://wallet.test';
const DAY = 86_400_000;

const codeOf = async (res: Response) => ((await res.json()) as { code: string }).code;

let env: AppEnv;
let f: Fixtures;
let clock: ManualClock;
let fake: ReturnType<typeof fakeAuth>;
let app: ReturnType<typeof createApp>;
let orgId: string;
let userId: string;
let template: ReturnType<typeof makeTemplate>;
let scannerId: string;
let staffId: string;
let eventId: string;
let passId: string;

beforeEach(async () => {
  clock = new ManualClock(Date.UTC(2026, 5, 1, 12));
  env = await makeEnv();
  f = fixtures(env, clock);
  fake = fakeAuth(ORIGIN);
  app = createApp({ stores: { ...fake.stores, scanners: createScannerStore(env, clock) }, clock });
  await run(env.DB, 'DELETE FROM audit_log');
  await run(env.DB, 'DELETE FROM counters');
  userId = (await makeUser(f)).id;
  orgId = (await makeOrg(f)).id;
  template = makeTemplate({ id: f.ids.id(), orgId });
  Object.assign(template.resolved.manifest, {
    scan: { actions: [{ id: 'enter', label: 'Let in', kind: 'check_in' }] },
  });
  await persistTemplate(f, template.resolved);
  scannerId = (await makeScanner(f, { orgId, templateIds: [template.resolved.id] })).id;
  staffId = (await makeScanStaff(f, { orgId, name: 'Dana' })).id;
  eventId = (await makeScanEvent(f, { orgId, templateIds: [template.resolved.id] })).id;
  passId = (
    await makePass(f, {
      orgId,
      template: template.resolved,
      personalization: { memberName: 'Alex Morgan' },
    })
  ).id;
  await run(
    env.DB,
    "UPDATE passes SET display_title = 'Alex Morgan', external_id = 'ext-1' WHERE id = ?",
    [passId],
  );
});

let seq = 0;
async function seed(over: Record<string, unknown> = {}) {
  const row = {
    id: f.ids.id(),
    org_id: orgId,
    mode: 'live',
    pass_id: passId,
    template_id: template.resolved.id,
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

const admin = (mode?: 'test') =>
  fake.session({ userId, roles: ['admin', 'user'], ...(mode ? { mode } : {}) });
const get = (path: string, headers: Record<string, string> = admin()) =>
  app.request(`${ORIGIN}/api/v1/scans${path}`, { headers }, env);
const post = (path: string, body: unknown, headers = admin(), target = app) =>
  target.request(
    `${ORIGIN}/api/v1/scans${path}`,
    {
      method: 'POST',
      headers: { ...headers, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    },
    env,
  );
type Rec = Record<string, any>;
const items = async (res: Response) => ((await res.json()) as { items: Rec[] }).items;

describe('GET /scans (admin)', () => {
  it('serves records with the names, the action label and the override flag', async () => {
    const ok = await seed();
    const refused = await seed({
      outcome: 'refused',
      reason: 'voided',
      action_kind: null,
      action_id: null,
      staff_id: null,
      override_of: 'x',
    });
    const res = await get(`?orgId=${orgId}`);
    expect(res.status).toBe(200);
    const rows = await items(res);
    expect(rows.map((r) => r.id)).toEqual([refused.id, ok.id]);
    expect(rows[1]).toMatchObject({
      outcome: 'ok',
      kind: 'check_in',
      actionLabel: 'Let in',
      passTitle: 'Alex Morgan',
      templateName: 'Test template',
      scannerName: expect.stringContaining('Scanner'),
      staffName: 'Dana',
      eventName: 'Event',
      override: false,
      offline: false,
      actor: { type: 'scanner', id: scannerId },
      undoneAt: null,
    });
    expect(rows[0]).toMatchObject({ reason: 'voided', override: true, staffName: null });
  });

  it('filters by org, mode, scanner, staff, event, pass, outcome, reason and time; pages', async () => {
    const other = await makeOrg(f);
    const otherScanner = await makeScanner(f, { orgId: other.id });
    const a = await seed();
    const b = await seed({ outcome: 'heads_up', reason: 'already_done' });
    const c = await seed({
      outcome: 'refused',
      reason: 'not_found',
      pass_id: null,
      event_id: null,
      staff_id: null,
      scanner_id: null,
      actor_id: 'u',
      actor_type: 'user',
      actor_key: 'u:u',
    });
    await seed({
      org_id: other.id,
      scanner_id: otherScanner.id,
      pass_id: null,
      template_id: null,
      event_id: null,
      staff_id: null,
    });
    await seed({ mode: 'test' });
    const ids = async (q: string, headers = admin()) =>
      (await items(await get(q, headers))).map((r) => r.id);
    expect(await ids(`?orgId=${orgId}`)).toEqual([c.id, b.id, a.id]);
    expect(await ids(`?orgId=${orgId}`, admin('test'))).toHaveLength(1);
    expect(await ids(`?scannerId=${scannerId}`)).toEqual([b.id, a.id]);
    expect(await ids(`?staffId=${staffId}`)).toEqual([b.id, a.id]);
    expect(await ids(`?eventId=${eventId}`)).toEqual([b.id, a.id]);
    expect(await ids(`?passId=${passId}`)).toEqual([b.id, a.id]);
    expect(await ids(`?orgId=${orgId}&outcome=heads_up`)).toEqual([b.id]);
    expect(await ids(`?orgId=${orgId}&reason=not_found`)).toEqual([c.id]);
    expect(await ids(`?orgId=${orgId}&from=${b.at}&to=${b.at}`)).toEqual([b.id]);
    const one = (await (await get(`?orgId=${orgId}&limit=2`)).json()) as {
      items: Rec[];
      nextCursor: string;
    };
    expect(one.items).toHaveLength(2);
    expect(one.nextCursor).toBe(b.id);
    expect(await ids(`?orgId=${orgId}&limit=2&cursor=${one.nextCursor}`)).toEqual([a.id]);
    expect(c.id).toBeTruthy();
  });

  it('shows an unknown code as a row with no pass', async () => {
    await seed({
      outcome: 'refused',
      reason: 'not_found',
      pass_id: null,
      template_id: null,
      action_id: null,
      action_kind: null,
    });
    const [row] = await items(await get(`?orgId=${orgId}`));
    expect(row).toMatchObject({
      passId: null,
      passTitle: null,
      templateId: null,
      reason: 'not_found',
      actionLabel: null,
    });
  });

  it('shows who undid a scan', async () => {
    const target = await seed();
    const undo = await seed({ action_kind: 'undo', action_id: null, undoes: target.id });
    await run(env.DB, 'UPDATE scans SET undone_at = ?, undone_by = ? WHERE id = ?', [
      undo.at,
      undo.id,
      target.id,
    ]);
    const rows = await items(await get(`?orgId=${orgId}`));
    expect(rows.find((r) => r.id === target.id)).toMatchObject({
      undoneAt: undo.at,
      undoneBy: 'Dana',
    });
    expect(rows.find((r) => r.id === undo.id)).toMatchObject({
      kind: 'undo',
      actionLabel: 'Undo',
      undoes: target.id,
    });
  });

  it('is the admin console only for a signed-in user', async () => {
    expect((await get('', fake.user())).status).toBe(403);
    expect((await get('', {})).status).toBe(401);
  });
});

describe('GET /scans (API key)', () => {
  it('sees its org only and its mode, and the feed has no names', async () => {
    const other = await makeOrg(f);
    const mine = await seed();
    await seed({ mode: 'test' });
    await seed({
      org_id: other.id,
      pass_id: null,
      template_id: null,
      event_id: null,
      staff_id: null,
      scanner_id: null,
    });
    const res = await get('', fake.apiKey({ orgId, scopes: ['scans:read'] }));
    expect(res.status).toBe(200);
    const rows = await items(res);
    expect(rows.map((r) => r.id)).toEqual([mine.id]);
    const keys = Object.keys(rows[0] ?? {});
    expect(keys).toEqual(
      expect.arrayContaining(['id', 'at', 'passId', 'externalId', 'outcome', 'scannerName']),
    );
    for (const banned of [
      'passTitle',
      'staffName',
      'staffId',
      'approvedBy',
      'actor',
      'actionLabel',
    ])
      expect(keys).not.toContain(banned);
    expect(JSON.stringify(rows)).not.toContain('Dana');
    expect(JSON.stringify(rows)).not.toContain('Alex Morgan');
    const test = await items(
      await get('', fake.apiKey({ orgId, scopes: ['scans:read'], mode: 'test' })),
    );
    expect(test).toHaveLength(1);
    expect(test[0]?.id).not.toBe(mine.id);
  });

  it('an org key cannot name another org; a platform key can pick one', async () => {
    const other = await makeOrg(f);
    await seed();
    const key = fake.apiKey({ orgId, scopes: ['scans:read'] });
    expect((await get(`?orgId=${other.id}`, key)).status).toBe(403);
    expect(
      await items(
        await get(`?orgId=${orgId}`, fake.apiKey({ orgId: null, scopes: ['scans:read'] })),
      ),
    ).toHaveLength(1);
    expect(
      await items(
        await get(`?orgId=${other.id}`, fake.apiKey({ orgId: null, scopes: ['scans:read'] })),
      ),
    ).toHaveLength(0);
  });

  it('needs the scans:read scope, and opens no other scans route', async () => {
    const row = await seed();
    expect((await get('', fake.apiKey({ orgId, scopes: ['passes:read'] }))).status).toBe(403);
    const key = fake.apiKey({ orgId, scopes: ['scans:read'] });
    expect((await get(`/${row.id}`, key)).status).toBe(401);
    expect((await get(`/export?orgId=${orgId}&from=0&to=1`, key)).status).toBe(401);
    expect(
      (
        await post(
          `/${row.id}/undo`,
          { idempotencyKey: '018f0000-0000-7000-8000-000000000000' },
          key,
        )
      ).status,
    ).toBe(401);
  });
});

describe('GET /scans/{id}', () => {
  it('returns the record, or a 404', async () => {
    const row = await seed();
    const res = await get(`/${row.id}`);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      id: row.id,
      actionLabel: 'Let in',
      staffName: 'Dana',
    });
    expect((await get('/nope')).status).toBe(404);
  });
});

describe('POST /scans/{id}/undo', () => {
  const key = '018f0000-0000-7000-8000-000000000001';
  const outcome = {
    scanId: 'u',
    kind: 'ok',
    reason: null,
    replay: false,
    action: null,
    card: null,
    previous: null,
    template: null,
    at: 1,
    cooldownRemainingMs: null,
    value: null,
    flags: [],
    overridable: false,
    approvals: false,
    group: null,
    counts: { today: 0, event: null, asOf: 1, configRev: 0 },
    milestone: null,
    undoUntil: null,
    display: null,
  };
  function mini(undo: ConsoleUndo) {
    const a = new Hono<AppBindings>();
    a.use(
      '*',
      requestContext({
        stores: { ...fake.stores, scanners: createScannerStore(env, clock) },
        clock,
      }),
    );
    a.onError(handleError);
    a.route('/api/v1/scans', createScansRoutes({ undo }));
    return a as unknown as ReturnType<typeof createApp>;
  }

  it('runs the undo service as the admin, ties it to the scan, and audits it', async () => {
    const row = await seed();
    const calls: unknown[] = [];
    const target = mini(async (_ctx, session, input) => {
      calls.push({ user: session.userId, ...input });
      return outcome as never;
    });
    const res = await post(`/${row.id}/undo`, { idempotencyKey: key }, admin(), target);
    expect(res.status).toBe(200);
    expect(calls).toEqual([
      {
        user: userId,
        scanId: row.id,
        orgId,
        mode: 'live',
        idempotencyKey: key,
        maxAgeMs: 30 * DAY,
      },
    ]);
    const audit = await all<{ action: string; target_id: string; actor_id: string }>(
      env.DB,
      'SELECT action, target_id, actor_id FROM audit_log',
    );
    expect(audit).toEqual([{ action: 'scan.undo', target_id: row.id, actor_id: userId }]);
  });

  it('refuses a scan over 30 days old, and an unknown scan', async () => {
    const row = await seed();
    clock.advance(31 * DAY);
    const target = mini(async () => outcome as never);
    const res = await post(`/${row.id}/undo`, { idempotencyKey: key }, admin(), target);
    expect(res.status).toBe(403);
    expect(await codeOf(res)).toBe('SCAN_UNDO_EXPIRED');
    expect((await post('/missing/undo', { idempotencyKey: key }, admin(), target)).status).toBe(
      404,
    );
    expect(await first(env.DB, 'SELECT 1 AS x FROM audit_log')).toBeNull();
  });

  it('needs a valid key, an admin, and a service', async () => {
    const row = await seed();
    expect((await post(`/${row.id}/undo`, { idempotencyKey: 'nope' })).status).toBe(422);
    expect((await post(`/${row.id}/undo`, { idempotencyKey: key }, fake.user())).status).toBe(403);
    const res = await post(`/${row.id}/undo`, { idempotencyKey: key });
    expect(res.status).toBe(503);
    expect(await codeOf(res)).toBe('SCAN_UNDO_UNAVAILABLE');
  });
});

describe('GET /scans/export', () => {
  const window = (extra = '') =>
    `?orgId=${orgId}&from=${clock.now() - DAY}&to=${clock.now() + DAY}${extra}`;

  it('streams a CSV, escapes cells, guards formulas and audits the export', async () => {
    await run(env.DB, 'UPDATE passes SET display_title = \'=HYPERLINK("x")\' WHERE id = ?', [
      passId,
    ]);
    const a = await seed();
    await seed({ outcome: 'refused', reason: 'voided' });
    const res = await get(`/export${window()}`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/csv');
    expect(res.headers.get('content-disposition')).toMatch(
      /^attachment; filename="scans-2026-05-31-2026-06-02\.csv"$/,
    );
    const text = await res.text();
    const lines = text.replace(/^﻿/, '').trimEnd().split('\r\n');
    expect(lines[0]).toBe(
      'Time (UTC),Result,Reason,Action,Pass,Template,Event,Scanner,Staff,Approved by,Method,Amount,Override,Offline,Undone',
    );
    expect(lines).toHaveLength(3);
    expect(lines[2]).toContain(new Date(a.at).toISOString());
    expect(lines[2]).toContain('\'=HYPERLINK(""x"")');
    expect(lines[1]).toContain('Refused,Voided');
    const audit = await first<{ action: string; org_id: string; detail: string }>(
      env.DB,
      "SELECT action, org_id, detail FROM audit_log WHERE action = 'scan.export'",
    );
    expect(audit?.org_id).toBe(orgId);
    expect(JSON.parse(audit?.detail ?? '{}')).toMatchObject({ rows: 2 });
  });

  it('refuses a window over 92 days, no window, and more than 100,000 rows', async () => {
    expect((await get(`/export?orgId=${orgId}&from=0&to=${93 * DAY}`)).status).toBe(422);
    expect((await get(`/export?orgId=${orgId}&from=5&to=5`)).status).toBe(422);
    expect((await get(`/export?orgId=${orgId}`)).status).toBe(422);
    await run(
      env.DB,
      `WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i <= ${EXPORT_MAX_ROWS})
       INSERT INTO scans (id, org_id, mode, actor_type, actor_id, actor_key, idempotency_key, request_hash, method, state, outcome, at)
       SELECT 'bulk-' || i, ?, 'live', 'scanner', 'x', 's:x', 'bulk' || i, 'h', 'camera', 'done', 'ok', ? FROM n`,
      [orgId, clock.now()],
    );
    const res = await get(`/export${window()}`);
    expect(res.status).toBe(422);
    expect(await codeOf(res)).toBe('SCAN_EXPORT_TOO_LARGE');
    expect(
      await first(env.DB, "SELECT 1 AS x FROM audit_log WHERE action = 'scan.export'"),
    ).toBeNull();
  }, 60_000);

  it('allows ten exports an hour per admin', async () => {
    for (let i = 0; i < 10; i++) expect((await get(`/export${window()}`)).status).toBe(200);
    const res = await get(`/export${window()}`);
    expect(res.status).toBe(429);
    clock.advance(3_600_000);
    expect((await get(`/export${window()}`)).status).toBe(200);
  });
});
