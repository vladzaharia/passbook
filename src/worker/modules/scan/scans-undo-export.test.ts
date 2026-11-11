import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';
import type { createApp } from '../../app.ts';
import { type AppBindings, requestContext } from '../../platform/context.ts';
import { all, first, run } from '../../platform/db.ts';
import { handleError } from '../../platform/error-handler.ts';
import { createSessionStore } from '../auth/sessions.ts';
import { createScannerStore } from './auth-store.ts';
import { type ConsoleUndo, EXPORT_MAX_ROWS } from './feed.ts';
import {
  admin,
  clock,
  codeOf,
  DAY,
  env,
  fake,
  get,
  orgId,
  passId,
  post,
  recordedAction,
  scannerFixture,
  scannerId,
  seed,
  template,
  userHeaders,
  userId,
} from './repo-scans-split-test-fixtures.ts';
import { createScansRoutes } from './routes-scans.ts';

describe('GET /scans/{id}', () => {
  it('returns the record, or a 404', async () => {
    const row = await recordedAction(scannerFixture, passId);
    const res = await get(`/${row.id}`);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      id: row.id,
      actionLabel: 'Let in',
      staffName: 'Dana',
      eventName: 'Event',
      templateName: 'Test template',
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
        stores: {
          ...fake.stores,
          sessions: createSessionStore(env, clock),
          scanners: createScannerStore(env, clock),
        },
        clock,
      }),
    );
    a.onError(handleError);
    a.route('/api/v1/scans', createScansRoutes({ undo }));
    return a as unknown as ReturnType<typeof createApp>;
  }

  it('delegates the undo and its atomic audit to the service as the admin', async () => {
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
    expect(audit).toEqual([]);
  });

  it('refuses a scan over 30 days old, and an unknown scan', async () => {
    const row = await seed({ at: clock.now() - 31 * DAY });
    const target = mini(async () => outcome as never);
    const res = await post(`/${row.id}/undo`, { idempotencyKey: key }, admin(), target);
    expect(res.status).toBe(403);
    expect(await codeOf(res)).toBe('SCAN_UNDO_EXPIRED');
    expect((await post('/missing/undo', { idempotencyKey: key }, admin(), target)).status).toBe(
      404,
    );
    expect(await first(env.DB, 'SELECT 1 AS x FROM audit_log')).toBeNull();
  });

  it('needs a valid key, an admin, and a gate that still names the scan', async () => {
    const row = await seed();
    expect((await post(`/${row.id}/undo`, { idempotencyKey: 'nope' })).status).toBe(422);
    expect((await post(`/${row.id}/undo`, { idempotencyKey: key }, userHeaders)).status).toBe(403);
    const res = await post(`/${row.id}/undo`, { idempotencyKey: key });
    expect(res.status).toBe(409);
    expect(await codeOf(res)).toBe('UNDO_SUPERSEDED');
  });
});

describe('GET /scans/export', () => {
  const window = (extra = '') =>
    `?orgId=${orgId}&from=${clock.now() - DAY}&to=${clock.now() + DAY}${extra}`;

  it('streams a CSV, escapes cells, guards formulas and audits the export', async () => {
    await run(env.DB, 'UPDATE passes SET display_title = ? WHERE id = ?', [
      'PRIVATE-RAW-TITLE',
      passId,
    ]);
    await run(env.DB, 'UPDATE scanners SET name = ? WHERE id = ?', ['=HYPERLINK("x")', scannerId]);
    const a = await recordedAction(scannerFixture, passId);
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
    expect(lines[2]).toContain('Test template,Event,');
    expect(lines[2]).toContain(',Dana,');
    expect(text).not.toContain('PRIVATE-RAW-TITLE');
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
       INSERT INTO scans (id, org_id, mode, pass_id, template_id, actor_type, actor_id, actor_key, idempotency_key, request_hash, method, state, outcome, at)
       SELECT 'bulk-' || i, ?, 'live', ?, ?, 'scanner', 'x', 's:x', 'bulk' || i, 'h', 'camera', 'done', 'ok', ? FROM n`,
      [orgId, passId, template.resolved.id, clock.now()],
    );
    const res = await get(`/export${window()}`);
    expect(res.status).toBe(422);
    expect(await codeOf(res)).toBe('SCAN_EXPORT_TOO_LARGE');
    expect(
      await first(env.DB, "SELECT 1 AS x FROM audit_log WHERE action = 'scan.export'"),
    ).toBeNull();
    // A rejected export does not use up the hourly allowance.
    await run(env.DB, "DELETE FROM scans WHERE id LIKE 'bulk-%'");
    for (let i = 0; i < 10; i++) expect((await get(`/export${window()}`)).status).toBe(200);
    expect((await get(`/export${window()}`)).status).toBe(429);
  }, 120_000);

  it('allows ten exports an hour per admin', async () => {
    for (let i = 0; i < 10; i++) expect((await get(`/export${window()}`)).status).toBe(200);
    const res = await get(`/export${window()}`);
    expect(res.status).toBe(429);
    clock.advance(30 * 60_000);
    expect((await get(`?orgId=${orgId}`)).status).toBe(200);
    clock.advance(30 * 60_000);
    expect((await get(`/export${window()}`)).status).toBe(200);
  });
});
