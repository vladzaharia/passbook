import { describe, expect, it } from 'vitest';
import { makeOrg, runOne } from '../../../../test/helpers/index.ts';
import { first } from '../../platform/db.ts';
import { recordedCheckIn, recordedNoMatch } from './console-privacy-actions-test-fixtures.ts';
import {
  expectNoSecrets,
  exportPath,
  fake,
  get,
  kit,
  lastExportCount,
  PUBLIC,
  page,
  privatePass,
  setupPrivacyKit,
  templateId,
} from './console-privacy-test-fixtures.ts';
import { startScanCredentialTransfer } from './test-kit.ts';

setupPrivacyKit();

describe('scan console and feed privacy', () => {
  it.each(['console', 'api key', 'export'] as const)(
    'does not expose a ledger row when its scanner becomes foreign during %s output',
    async (surface) => {
      const scanner = await kit.scanner({ templateIds: [templateId] });
      const row = await recordedNoMatch(scanner);
      const other = await makeOrg(kit.fx);
      const apiKey = fake.apiKey({ orgId: kit.org.id, scopes: ['scans:read'] });
      const db = kit.env.DB;
      let intercepted = 0;
      const wrap = (statement: D1PreparedStatement): D1PreparedStatement =>
        new Proxy(statement, {
          get(target, property) {
            if (property === 'bind') return (...values: unknown[]) => wrap(target.bind(...values));
            if (property === 'all')
              return async () => {
                const result = await target.all();
                if (intercepted === 0) {
                  intercepted++;
                  await runOne(db, 'UPDATE scanners SET org_id = ? WHERE id = ?', [
                    other.id,
                    scanner.id,
                  ]);
                }
                return result;
              };
            const value = Reflect.get(target, property, target);
            return typeof value === 'function' ? value.bind(target) : value;
          },
        });
      const proxy = new Proxy(db, {
        get(target, property) {
          if (property === 'prepare')
            return (sql: string) => {
              const statement = target.prepare(sql);
              return /FROM\s+scans\s+s[\s\S]*ORDER BY s\.at DESC/i.test(sql)
                ? wrap(statement)
                : statement;
            };
          const value = Reflect.get(target, property, target);
          return typeof value === 'function' ? value.bind(target) : value;
        },
      });
      Object.assign(kit.env, { DB: proxy });
      try {
        const response =
          surface === 'console'
            ? await get(`?orgId=${kit.org.id}`)
            : surface === 'api key'
              ? await get('', apiKey)
              : await get(exportPath());
        expect(response.status).toBe(200);
        const body = await response.text();
        if (surface === 'export') {
          expect(
            body
              .replace(/^\uFEFF/, '')
              .trimEnd()
              .split('\r\n'),
          ).toHaveLength(1);
          expect(body).not.toContain(new Date(row.at).toISOString());
        } else {
          expect(JSON.parse(body)).toMatchObject({ items: [] });
          expect(body).not.toContain(row.id);
          expect(body).not.toContain(scanner.id);
        }
        expect(intercepted).toBe(1);
      } finally {
        Object.assign(kit.env, { DB: db });
      }
    },
  );

  it.each([
    ['console', 'voided'],
    ['api key', 'voided'],
    ['export', 'voided'],
    ['console', 'credential'],
    ['api key', 'credential'],
    ['export', 'credential'],
    ['console', 'lifecycle'],
    ['api key', 'lifecycle'],
    ['export', 'lifecycle'],
  ] as const)(
    'keeps immutable history redacted during %s output after a %s change',
    async (surface, change) => {
      const scanner = await kit.scanner({ templateIds: [templateId] });
      const pass = await privatePass();
      const row = await recordedCheckIn(scanner, pass.id);
      const apiKey = fake.apiKey({ orgId: kit.org.id, scopes: ['scans:read'] });
      const db = kit.env.DB;
      let intercepted = 0;
      const wrap = (statement: D1PreparedStatement): D1PreparedStatement =>
        new Proxy(statement, {
          get(target, property) {
            if (property === 'bind') return (...values: unknown[]) => wrap(target.bind(...values));
            if (property === 'all')
              return async () => {
                const result = await target.all();
                if (intercepted === 0) {
                  intercepted++;
                  if (change === 'credential') {
                    expect(await startScanCredentialTransfer(kit, pass.id, { db })).toMatchObject({
                      state: 'completed',
                    });
                  } else {
                    const mutation =
                      change === 'voided'
                        ? "UPDATE passes SET status = 'voided' WHERE id = ?"
                        : 'UPDATE passes SET lifecycle_generation = lifecycle_generation + 1 WHERE id = ?';
                    // A pass update also moves row_version; D1 counts trigger changes.
                    await runOne(db, mutation, [pass.id]);
                  }
                }
                return result;
              };
            const value = Reflect.get(target, property, target);
            return typeof value === 'function' ? value.bind(target) : value;
          },
        });
      const proxy = new Proxy(db, {
        get(target, property) {
          if (property === 'prepare')
            return (sql: string) => {
              const statement = target.prepare(sql);
              return /FROM\s+scans\s+s[\s\S]*ORDER BY s\.at DESC/i.test(sql)
                ? wrap(statement)
                : statement;
            };
          const value = Reflect.get(target, property, target);
          return typeof value === 'function' ? value.bind(target) : value;
        },
      });
      Object.assign(kit.env, { DB: proxy });
      try {
        const response =
          surface === 'console'
            ? await get(`?orgId=${kit.org.id}`)
            : surface === 'api key'
              ? await get('', apiKey)
              : await get(exportPath());
        expect(response.status).toBe(200);
        const body = await response.text();
        if (surface === 'export') {
          expect(
            body
              .replace(/^\uFEFF/, '')
              .trimEnd()
              .split('\r\n'),
          ).toHaveLength(2);
          expect(body).toContain(new Date(row.at).toISOString());
        } else {
          const result = JSON.parse(body) as { items: unknown[] };
          expect(result.items).toHaveLength(1);
          expect(result.items[0]).toMatchObject({
            id: row.id,
            at: row.at,
            outcome: 'ok',
            passId: null,
            templateId: null,
            kind: null,
            actionId: null,
            before: null,
            after: null,
          });
        }
        expectNoSecrets(body, pass);
        expect(body).not.toContain(pass.id);
        expect(body).not.toContain(PUBLIC);
        expect(intercepted).toBe(1);
      } finally {
        Object.assign(kit.env, { DB: db });
      }
    },
  );

  it('retains a scan minimally when its signing identity no longer matches the Wallet', async () => {
    const scanner = await kit.scanner({ templateIds: [templateId] });
    const pass = await privatePass();
    const row = await recordedCheckIn(scanner, pass.id);
    const identity = await first<{ identity_id: string }>(
      kit.env.DB,
      'SELECT identity_id FROM passes WHERE id = ?',
      [pass.id],
    );
    if (!identity) throw new Error('The issued pass must have a signing identity.');
    await runOne(kit.env.DB, 'UPDATE signing_identities SET team_identifier = ? WHERE id = ?', [
      'OTHERTEAM',
      identity.identity_id,
    ]);

    const history = await page(`?orgId=${kit.org.id}`);
    expect(history.items).toHaveLength(1);
    expect(history.items[0]).toMatchObject({
      id: row.id,
      passId: null,
      templateId: null,
      passTitle: null,
      kind: null,
      actionId: null,
    });
    expect((await page(`?orgId=${kit.org.id}&passId=${pass.id}`)).items).toEqual([]);
    const apiKey = fake.apiKey({ orgId: kit.org.id, scopes: ['scans:read'] });
    expect((await page('', apiKey)).items[0]).toMatchObject({
      id: row.id,
      passId: null,
      templateId: null,
    });
    const detail = await get(`/${row.id}`);
    expect(detail.status).toBe(200);
    expect(await detail.json()).toMatchObject({ id: row.id, passId: null, passTitle: null });
    const exported = await get(exportPath());
    expect(exported.status).toBe(200);
    const csv = await exported.text();
    expect(
      csv
        .replace(/^\uFEFF/, '')
        .trimEnd()
        .split('\r\n'),
    ).toHaveLength(2);
    expect(csv).not.toContain(pass.id);
    expect(csv).not.toContain(PUBLIC);
    expect(await lastExportCount()).toBe(1);
  });
});
