import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import { grant } from './authority.ts';
import { tenantSql } from './authority-cond.ts';
import { GrantedStatement } from './authority-granted.ts';
import { setupGrant } from './authority-test-fixtures.ts';
import { all } from './db.ts';

const db = env.DB;
const row = (at: number, action: string, orgId: string) => ({
  at,
  orgId,
  actorType: 'user',
  actorId: 'u',
  action,
  targetType: null,
  targetId: null,
  requestId: null,
  ipPrefix: null,
  detail: null,
});
const audits = (action: string) =>
  all<{ action: string }>(db, 'SELECT action FROM audit_log WHERE action = ?', [action]);

describe('statements cannot be forged', () => {
  it('refuses to construct a statement without the builder token', async () => {
    const { route, member } = await setupGrant('forge');
    const g = grant(route, { purpose: 'org_mode.scan.update', principal: member() });
    const forged = () =>
      new GrantedStatement(Symbol('x') as never, g.id, {
        sql: 'UPDATE passes SET status = 1',
        params: [],
      });
    expect(forged).toThrowError(expect.objectContaining({ code: 'GRANT_FOREIGN_STATEMENT' }));
  });

  it('unguarded refuses guarded, authority and append-only tables, and a write without the grant row', async () => {
    const { route, member } = await setupGrant('unguarded');
    const g = grant(route, {
      purpose: 'org_mode.scan.update',
      principal: member(),
      tables: ['counters'],
    });
    const gp = ' FROM authority_grants g WHERE g.id = ?';
    for (const sql of [
      `UPDATE passes SET status = 'voided' WHERE EXISTS (SELECT 1${gp})`,
      `DELETE FROM audit_log WHERE EXISTS (SELECT 1${gp})`,
      `INSERT INTO authority_grants (id) SELECT 1${gp}`,
      `INSERT INTO settings (scope, key, value) SELECT 'platform', 'k', 'v'${gp}`,
    ])
      expect(() => g.unguarded(sql, [g.id]), sql).toThrowError(
        expect.objectContaining({ code: 'GRANT_UNGUARDED_TABLE' }),
      );
    expect(() => g.unguarded('INSERT INTO counters (key) VALUES (1)', [])).toThrowError(
      expect.objectContaining({ code: 'GRANT_FOREIGN_STATEMENT' }),
    );
    expect(() =>
      g.unguarded(`INSERT INTO counters (key, window_start, count) SELECT 'k', 1, 1${gp}`, [g.id]),
    ).not.toThrow();
  });
});

describe('Grant.audit', () => {
  it('commits the audit row with its grant and only then', async () => {
    const { s, route, member } = await setupGrant('audit-commit');
    const g = grant(route, { purpose: 'org_mode.scan.update', principal: member() });
    g.add(g.audit(row(1, 'audit.test.ok', s.org.id)));
    await g.commit();
    expect(await audits('audit.test.ok')).toHaveLength(1);

    const denied = grant(route, {
      purpose: 'org_mode.scan.update',
      principal: member({ orgAccessRevision: 99 }),
    });
    denied.add(denied.audit(row(1, 'audit.test.denied', s.org.id)));
    await expect(denied.commit()).rejects.toMatchObject({ status: 403 });
    expect(await audits('audit.test.denied')).toHaveLength(0);
  });

  it('evaluates its condition at its position in the batch: earlier writes are visible, later ones are not', async () => {
    const { s, route, member } = await setupGrant('audit-order');
    const g = grant(route, {
      purpose: 'org_mode.scan.update',
      principal: member(),
      tables: ['counters'],
    });
    const seen = (key: string) => [
      tenantSql('EXISTS (SELECT 1 FROM counters c WHERE c.key = ?)', [key]),
    ];
    const put = (key: string) =>
      g.unguarded(
        `INSERT INTO counters (key, window_start, count) SELECT ?, 1, 1 FROM authority_grants g WHERE g.id = ?`,
        [key, g.id],
      );
    // Statements run in the order they were added; audit() adds itself, unguarded() waits for add().
    g.audit(row(1, 'audit.order.before', s.org.id), seen('order-key'));
    g.add(put('order-key'));
    g.audit(row(1, 'audit.order.after', s.org.id), seen('order-key'));
    await g.commit();
    // The audit added after the insert sees the row; the one added before it does not.
    expect(await audits('audit.order.before')).toHaveLength(0);
    expect(await audits('audit.order.after')).toHaveLength(1);
  });

  it('honours a read-only condition and refuses a write in it', async () => {
    const { s, route, member } = await setupGrant('audit-when');
    const g = grant(route, { purpose: 'org_mode.scan.update', principal: member() });
    g.add(g.audit(row(1, 'audit.test.never', s.org.id), [tenantSql('1 = 0')]));
    g.add(g.audit(row(1, 'audit.test.always', s.org.id), [tenantSql('1 = 1')]));
    await g.commit();
    expect(await audits('audit.test.never')).toHaveLength(0);
    expect(await audits('audit.test.always')).toHaveLength(1);
    expect(() => tenantSql('1 = 1; DELETE FROM passes')).toThrowError(
      expect.objectContaining({ code: 'GRANT_SCOPE_OVERRIDE' }),
    );
  });
});

describe('Grant.audit takes the org from the grant row', () => {
  it('a tenant grant writes its own org, refuses a different one and fills a missing one', async () => {
    const a = await setupGrant('audit-org-a');
    const b = await setupGrant('audit-org-b');
    const mk = () => grant(a.route, { purpose: 'org_mode.scan.update', principal: a.member() });
    const org = async (action: string) =>
      (
        await all<{ org_id: string | null }>(db, 'SELECT org_id FROM audit_log WHERE action = ?', [
          action,
        ])
      )[0]?.org_id;
    const own = mk();
    own.audit(row(1, 'audit.org.own', a.s.org.id));
    await own.commit();
    expect(await org('audit.org.own')).toBe(a.s.org.id);
    const missing = mk();
    missing.audit({ ...row(1, 'audit.org.null', a.s.org.id), orgId: null });
    await missing.commit();
    expect(await org('audit.org.null')).toBe(a.s.org.id);
    const other = mk();
    other.audit(row(1, 'audit.org.other', b.s.org.id));
    await expect(other.commit()).rejects.toMatchObject({ code: 'ORG_ACCESS_CHANGED' });
    expect(await org('audit.org.other')).toBeUndefined();
  });
});
