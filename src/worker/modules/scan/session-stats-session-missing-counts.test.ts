import { describe, expect, it } from 'vitest';
import { installKeysetTestEnv } from '../../../../test/helpers/credential-keyset.ts';
import {
  type Fixtures,
  makePass,
  makeScanner,
  makeTemplate,
} from '../../../../test/helpers/index.ts';
import { run } from '../../platform/db.ts';
import { recordSessionCountScan } from './repo-session-count-scope-test-fixtures.ts';
import {
  atCountBatch,
  freshFixture,
  singleton,
} from './repo-session-stats-authority-test-fixtures.ts';

const makeEnv = installKeysetTestEnv();

function countResultIndexes(statements: readonly ({ sql: string } | undefined)[]) {
  const initialize = statements.findIndex((entry) =>
    /INSERT\s+INTO\s+credential_ref_keyset/i.test(entry?.sql ?? ''),
  );
  const authority = statements.findIndex((entry) =>
    /WITH\s+session_scope\s+AS\s+MATERIALIZED\s*\(/i.test(entry?.sql ?? ''),
  );
  const devices = statements.findIndex((entry) =>
    /SELECT\s+count\(\*\)\s+AS\s+devices\b/i.test(entry?.sql ?? ''),
  );
  const today = statements.findIndex((entry) =>
    /SELECT\s+count\(\*\)\s+AS\s+n\s+FROM\s+scans\s+s\b/i.test(entry?.sql ?? ''),
  );
  expect(statements).toHaveLength(4);
  if ([initialize, authority, devices, today].some((index) => index < 0))
    throw new Error('Missing a session stats batch statement');
  expect(new Set([initialize, authority, devices, today]).size).toBe(4);
  return { initialize, authority, devices, today };
}

async function seedVisibleCount(fx: Fixtures, orgId: string, sessionId: string) {
  const scanner = await makeScanner(fx, { orgId });
  await run(
    fx.env.DB,
    `INSERT INTO scanning_devices (scanner_id,session_id,org_id,mode)
    VALUES (?,?,?,'live')`,
    [scanner.id, sessionId, orgId],
  );
  const template = makeTemplate({ id: fx.ids.id(), orgId });
  const pass = await makePass(fx, { orgId, template: template.resolved });
  await recordSessionCountScan(fx, orgId, scanner.id, pass.id);
}

async function expectNoPartialCounts(response: Response, status: number, code: string) {
  expect(response.status).toBe(status);
  const body = await response.text();
  expect(JSON.parse(body)).toMatchObject({ code });
  expect(body).not.toMatch(/"(?:items|counts|devices|deviceCount|online|onlineCount|today|n)"\s*:/);
}

describe('scanning session missing count results', () => {
  it.each(
    (['list', 'detail'] as const).flatMap((view) =>
      (
        [
          'device result',
          'device row',
          'devices value',
          'online value',
          'today result',
          'today row',
          'today value',
        ] as const
      ).map((missing) => ({ view, missing })),
    ),
  )(
    'fails $view without partial counts when the $missing is missing',
    async ({ view, missing }) => {
      const f = await freshFixture(await makeEnv());
      await seedVisibleCount(f.fx, f.org.id, f.id);
      if (view === 'list') {
        const sibling = f.fx.ids.id();
        await run(
          f.env.DB,
          `INSERT INTO scanning_sessions
        (id,org_id,mode,name,status,accepts,settings,time_zone,created_at,updated_at)
        SELECT ?,org_id,mode,name,status,accepts,settings,time_zone,created_at,updated_at
        FROM scanning_sessions WHERE id=?`,
          [sibling, f.id],
        );
        await seedVisibleCount(f.fx, f.org.id, sibling);
      }
      const path =
        view === 'list' ? `/scanning-sessions?orgId=${f.org.id}` : `/scanning-sessions/${f.id}`;
      const { result } = await atCountBatch(
        f.env,
        () => f.request(path),
        async () => {},
        (results, statements) => {
          const indexes = countResultIndexes(statements);
          expect(results[indexes.authority]?.results).toEqual([{ keyset: 1 }]);
          expect(results[indexes.devices]?.results).toEqual([{ devices: 1, online: 1 }]);
          expect(results[indexes.today]?.results).toEqual([{ n: 1 }]);
          const index = missing.startsWith('today') ? indexes.today : indexes.devices;
          if (missing.endsWith('result')) {
            const damaged = [...results];
            damaged[index] = undefined as unknown as D1Result;
            return damaged;
          }
          return results.map((entry, position) => {
            if (position !== index) return entry;
            if (missing.endsWith('row')) return { ...entry, results: [] };
            const row = { ...(entry.results[0] as Record<string, unknown>) };
            const field =
              missing === 'devices value' ? 'devices' : missing === 'online value' ? 'online' : 'n';
            delete row[field];
            return { ...entry, results: [row] };
          });
        },
      );
      await expectNoPartialCounts(result, 503, 'SCANNING_SESSION_COUNTS_UNAVAILABLE');
      expect(await singleton(f)).toEqual({ commitment: f.proof.credentialKeysetCommitment });
    },
  );

  it.each(
    (['list', 'detail'] as const).flatMap((view) =>
      (['revoked authority', 'mismatched keyset'] as const).map((failure) => ({ view, failure })),
    ),
  )('prioritizes $failure over missing $view counts', async ({ view, failure }) => {
    const f = await freshFixture(await makeEnv());
    await seedVisibleCount(f.fx, f.org.id, f.id);
    const other =
      f.proof.credentialKeysetCommitment === '0'.repeat(64) ? '1'.repeat(64) : '0'.repeat(64);
    const path =
      view === 'list' ? `/scanning-sessions?orgId=${f.org.id}` : `/scanning-sessions/${f.id}`;
    const { result } = await atCountBatch(
      f.env,
      () => f.request(path),
      async (db) => {
        await run(db, 'INSERT INTO credential_ref_keyset (id,commitment) VALUES (1,?)', [other]);
        if (failure === 'revoked authority')
          await run(db, 'UPDATE org_memberships SET revoked_at=? WHERE id=?', [
            f.clock.now(),
            f.membershipId,
          ]);
      },
      (results, statements) => {
        const indexes = countResultIndexes(statements);
        expect(results[indexes.authority]?.results).toEqual(
          failure === 'revoked authority' ? [] : [{ keyset: 0 }],
        );
        expect(results[indexes.devices]?.results).toEqual([{ devices: 1, online: 1 }]);
        expect(results[indexes.today]?.results).toEqual([{ n: 1 }]);
        return results.map((entry, position) =>
          position === indexes.devices || position === indexes.today
            ? { ...entry, results: [] }
            : entry,
        );
      },
    );
    await expectNoPartialCounts(
      result,
      failure === 'revoked authority' ? 404 : 503,
      failure === 'revoked authority'
        ? 'SCANNING_SESSION_NOT_FOUND'
        : 'CREDENTIAL_REF_KEYSET_UNAVAILABLE',
    );
    expect(await singleton(f)).toEqual({ commitment: other });
  });

  // Device workspace counts also fail closed when their results are absent.
  it.each(['today', 'managers'] as const)(
    'fails unavailable instead of fabricating a zero for a missing %s result',
    async (missing) => {
      const f = await freshFixture(await makeEnv());
      const scanner = await makeScanner(f.fx, { orgId: f.org.id });
      await run(
        f.env.DB,
        `INSERT INTO scanning_devices (scanner_id,session_id,org_id,mode)
        VALUES (?,?,?,'live')`,
        [scanner.id, f.id, f.org.id],
      );
      const { result } = await atCountBatch(
        f.env,
        () => f.request('/scan/session', scanner.headers),
        async () => {},
        (results, statements) => {
          const index = statements.findIndex((statement) =>
            missing === 'today'
              ? /SELECT count\(\*\) AS n FROM scans s/i.test(statement?.sql ?? '')
              : /SELECT EXISTS \(SELECT 1 FROM scan_staff/i.test(statement?.sql ?? ''),
          );
          if (index < 0) throw new Error(`Missing ${missing} count statement`);
          return results.map((entry, position) =>
            position === index ? { ...entry, results: [] } : entry,
          );
        },
      );
      expect(result.status).toBe(503);
      expect(await result.json()).toMatchObject({ code: 'SCAN_COUNTS_UNAVAILABLE' });
    },
  );
});
