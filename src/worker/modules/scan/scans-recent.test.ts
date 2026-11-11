import { describe, expect, it } from 'vitest';
import {
  makePass,
  makeScanner,
  makeScanStaff,
  makeTemplate,
  persistTemplate,
} from '../../../../test/helpers/index.ts';
import { run } from '../../platform/db.ts';
import { approveAppleRelease } from '../passes/apple-release-test-fixtures.ts';
import {
  app,
  clock,
  ctx,
  env,
  f,
  liveReleaseId,
  ORIGIN,
  orgId,
  passId,
  type Rec,
  recordedAction,
  recordedNoMatch,
  recordVersion,
  seed,
  template,
} from './repo-scans-split-test-fixtures.ts';

describe('scanner recent and summary privacy', () => {
  const scannerGet = (headers: Record<string, string>, path: string) =>
    app.request(`${ORIGIN}/api/v1/scan${path}`, { headers }, env);
  const own = (id: string) => ({ scanner_id: id, actor_id: id, actor_key: `s:${id}` });

  it('retains redacted unavailable-pass history in paging and totals without leaking action aggregates', async () => {
    const scanner = await makeScanner(f, { orgId, templateIds: [template.resolved.id] });
    await run(
      env.DB,
      "UPDATE pass_versions SET pass_json = json_set(pass_json, '$.voided', json('false'), '$.expirationDate', ?) WHERE pass_id = ?",
      ['2026-07-01T12:00:00+00:00', passId],
    );
    const allowed = await recordedAction(scanner, passId);
    const noMatch = await recordedNoMatch(scanner);
    const cases = [
      { set: 'test_data_quarantined = 1' },
      { set: 'deleted_at = 1' },
      { set: 'removed_at = 1' },
      { set: "status = 'voided'" },
      { wallet: { voided: true } },
      { wallet: { expirationDate: '2020-01-01T00:00:00Z' } },
      { wallet: { expirationDate: 'invalid' } },
      { raw: '{invalid' },
      { remove: true },
    ];
    const redacted: { id: string; at: number }[] = [];
    let quarantinedId: string | null = null;
    for (const entry of cases) {
      const pass = await makePass(f, { orgId, template: template.resolved });
      await run(env.DB, 'UPDATE passes SET release_id = ? WHERE id = ?', [liveReleaseId, pass.id]);
      await recordVersion(pass.id);
      const row = await recordedAction(scanner, pass.id);
      if (entry.set === 'test_data_quarantined = 1') quarantinedId = row.id;
      else redacted.push(row);
      if (entry.set) await run(env.DB, `UPDATE passes SET ${entry.set} WHERE id = ?`, [pass.id]);
      if (entry.wallet)
        await run(
          env.DB,
          'UPDATE pass_versions SET pass_json = json_patch(pass_json, ?) WHERE pass_id = ?',
          [JSON.stringify(entry.wallet), pass.id],
        );
      if (entry.raw)
        await run(env.DB, 'UPDATE pass_versions SET pass_json = ? WHERE pass_id = ?', [
          entry.raw,
          pass.id,
        ]);
      if (entry.remove) await run(env.DB, 'DELETE FROM passes WHERE id = ?', [pass.id]);
    }
    const unprovenOrphan = await seed({
      ...own(scanner.id),
      pass_id: null,
      template_id: template.resolved.id,
      pass_version: 1,
    });
    const ambiguousPassless = await seed({
      ...own(scanner.id),
      pass_id: null,
      template_id: null,
      action_id: null,
      action_kind: null,
      outcome: 'refused',
      reason: 'ambiguous',
    });
    const actionPassless = await seed({
      ...own(scanner.id),
      pass_id: null,
      template_id: null,
      outcome: 'refused',
      reason: 'not_found',
    });
    const recent = await scannerGet(scanner.headers, '/scans?limit=2');
    expect(recent.status).toBe(200);
    expect(await recent.json()).toMatchObject({
      items: redacted
        .slice(-2)
        .reverse()
        .map((row) => ({
          scanId: row.id,
          title: null,
          actionLabel: 'Scan',
          outcome: 'ok',
          reason: null,
        })),
    });
    const allRecent = await scannerGet(scanner.headers, '/scans?limit=20');
    expect(allRecent.status).toBe(200);
    const recentRows = (await allRecent.json()) as { items: Rec[] };
    expect(recentRows.items.find((row) => row.scanId === noMatch.id)).toMatchObject({
      title: null,
      actionLabel: 'Scan',
      outcome: 'refused',
      reason: 'not_found',
    });
    expect(recentRows.items.find((row) => row.scanId === allowed.id)).toMatchObject({
      title: 'Alex Morgan',
      actionLabel: 'Let in',
      outcome: 'ok',
    });
    expect(recentRows.items.some((row) => row.scanId === quarantinedId)).toBe(false);
    expect(recentRows.items.some((row) => row.scanId === unprovenOrphan.id)).toBe(false);
    expect(recentRows.items.some((row) => row.scanId === ambiguousPassless.id)).toBe(false);
    expect(recentRows.items.some((row) => row.scanId === actionPassless.id)).toBe(false);
    const summary = await scannerGet(scanner.headers, '/summary');
    expect(summary.status).toBe(200);
    expect(await summary.json()).toMatchObject({
      total: 10,
      ok: 9,
      headsUp: 0,
      refused: 1,
      byAction: [],
      firstAt: allowed.at,
      lastAt: redacted.at(-1)?.at,
    });
    const visibleScanner = await makeScanner(f, { orgId, templateIds: [template.resolved.id] });
    await recordedAction(visibleScanner, passId);
    const visible = await scannerGet(visibleScanner.headers, '/summary');
    expect(visible.status).toBe(200);
    expect(await visible.json()).toMatchObject({
      total: 1,
      ok: 1,
      byAction: [{ actionId: 'enter', label: 'Let in', count: 1, amount: 0 }],
    });
  });

  it('hides a manager-only action from Door history and aggregates while allowing a Manager', async () => {
    const restricted = makeTemplate({ id: f.ids.id(), orgId });
    Object.assign(restricted.resolved.manifest, {
      scan: {
        actions: [
          { id: 'vip_entry', label: 'Manager admission', kind: 'check_in', minRole: 'manager' },
        ],
      },
    });
    await persistTemplate(f, restricted.resolved, { registry: restricted.registry });
    const release = await approveAppleRelease(
      { ctx, fx: f, registry: restricted.registry },
      {
        orgId,
        mode: 'live',
        templateId: restricted.resolved.id,
        version: restricted.resolved.version,
      },
    );
    const pass = await makePass(f, { orgId, template: restricted.resolved });
    await run(env.DB, 'UPDATE passes SET release_id = ? WHERE id = ?', [release.id, pass.id]);
    await recordVersion(pass.id);
    const staff = await makeScanStaff(f, { orgId, role: 'manager' });
    const scanner = await makeScanner(f, {
      orgId,
      templateIds: [restricted.resolved.id],
      staffId: staff.id,
      settings: { staffSignIn: true },
    });
    const row = await recordedAction(scanner, pass.id, 'vip_entry');
    await run(
      env.DB,
      "UPDATE scan_staff SET role = 'door', updated_at = updated_at + 1 WHERE id = ?",
      [staff.id],
    );
    const doorRecent = await scannerGet(scanner.headers, '/scans');
    expect(doorRecent.status).toBe(200);
    expect(await doorRecent.json()).toMatchObject({
      items: [{ scanId: row.id, actionLabel: 'Scan', outcome: 'ok' }],
    });
    const doorSummary = await scannerGet(scanner.headers, '/summary');
    expect(doorSummary.status).toBe(200);
    expect(await doorSummary.json()).toMatchObject({ total: 1, ok: 1, byAction: [] });
    await run(
      env.DB,
      "UPDATE scan_staff SET role = 'manager', updated_at = updated_at + 1 WHERE id = ?",
      [staff.id],
    );
    const managerRecent = await scannerGet(scanner.headers, '/scans');
    expect(managerRecent.status).toBe(200);
    expect(await managerRecent.json()).toMatchObject({
      items: [{ scanId: row.id, actionLabel: 'Manager admission', outcome: 'ok' }],
    });
    const managerSummary = await scannerGet(scanner.headers, '/summary');
    expect(managerSummary.status).toBe(200);
    expect(await managerSummary.json()).toMatchObject({
      total: 1,
      ok: 1,
      byAction: [{ actionId: 'vip_entry', label: 'Manager admission', count: 1, amount: 0 }],
    });
  });

  it('uses a neutral recent label instead of an unknown stored action identifier', async () => {
    const scanner = await makeScanner(f, { orgId, templateIds: [template.resolved.id] });
    const unknownAction = 'unrecognized_action_sentinel';
    const row = await seed({ ...own(scanner.id), action_id: unknownAction, pass_version: 1 });
    const response = await scannerGet(scanner.headers, '/scans');
    expect(response.status).toBe(200);
    const body = (await response.json()) as { items: Rec[] };
    expect(body.items).toEqual([
      expect.objectContaining({
        scanId: row.id,
        title: null,
        actionLabel: 'Scan',
        outcome: 'ok',
      }),
    ]);
    expect(JSON.stringify(body)).not.toContain(unknownAction);
    const summary = await scannerGet(scanner.headers, '/summary');
    expect(summary.status).toBe(200);
    const totals = (await summary.json()) as Rec;
    expect(totals).toMatchObject({ total: 1, ok: 1, byAction: [] });
    expect(JSON.stringify(totals)).not.toContain(unknownAction);
  });

  it('revalidates pass and actor authority after reading a candidate', async () => {
    const scanner = await makeScanner(f, { orgId, templateIds: [template.resolved.id] });
    const row = await recordedAction(scanner, passId);
    const before = await scannerGet(scanner.headers, '/scans');
    expect(before.status).toBe(200);
    expect(await before.json()).toMatchObject({
      items: [{ scanId: row.id, title: 'Alex Morgan' }],
    });
    const real = env.DB;
    let fired = false;
    let invalidate: 'pass' | 'scanner' = 'pass';
    const wrap = (statement: D1PreparedStatement): D1PreparedStatement =>
      new Proxy(statement, {
        get(target, prop) {
          if (prop === 'bind') return (...values: unknown[]) => wrap(target.bind(...values));
          if (prop === 'first')
            return async () => {
              const row = await target.first<{ id: string }>();
              if (!fired && row?.id === passId) {
                fired = true;
                if (invalidate === 'pass')
                  await run(real, 'UPDATE passes SET test_data_quarantined = 1 WHERE id = ?', [
                    passId,
                  ]);
                else
                  await run(real, 'UPDATE scanners SET revoked_at = ? WHERE id = ?', [
                    clock.now(),
                    scanner.id,
                  ]);
              }
              return row;
            };
          const value = Reflect.get(target, prop, target);
          return typeof value === 'function' ? value.bind(target) : value;
        },
      });
    const db = new Proxy(real, {
      get(target, prop) {
        if (prop === 'prepare')
          return (sql: string) => {
            const statement = target.prepare(sql);
            return sql.includes('FROM passes p') && sql.includes('WHERE p.org_id = ?')
              ? wrap(statement)
              : statement;
          };
        const value = Reflect.get(target, prop, target);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    Object.assign(env, { DB: db });
    try {
      const recent = await scannerGet(scanner.headers, '/scans');
      expect(recent.status).toBe(200);
      expect(await recent.json()).toEqual({ items: [] });
      expect(fired).toBe(true);
      await run(real, 'UPDATE passes SET test_data_quarantined = 0 WHERE id = ?', [passId]);
      fired = false;
      const summary = await scannerGet(scanner.headers, '/summary');
      expect(summary.status).toBe(200);
      expect(await summary.json()).toMatchObject({ total: 0, ok: 0, byAction: [] });
      expect(fired).toBe(true);
      await run(real, 'UPDATE passes SET test_data_quarantined = 0 WHERE id = ?', [passId]);
      fired = false;
      invalidate = 'scanner';
      const revoked = await scannerGet(scanner.headers, '/scans');
      expect(fired).toBe(true);
      expect(revoked.status).toBe(200);
      expect(await revoked.json()).toEqual({ items: [] });
    } finally {
      Object.assign(env, { DB: real });
    }
  });
});
