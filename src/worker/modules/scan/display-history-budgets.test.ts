import { beforeAll, describe, expect, it } from 'vitest';
import { countD1 } from '../../../../test/helpers/count-d1.ts';
import { clearSettingsCache } from '../settings/service.ts';
import { act, CHECK_IN, kit, out, setupActionFixture } from './act-test-fixtures.ts';
import { lookupHistoryPageStmt } from './repo-lookup-history.ts';
import { pendingDisplayHistoryStmt } from './repo-pending-display-history.ts';
import { READ_SQL_BYTE_BUDGET } from './repo-read-authority.ts';
import {
  displayHistoryCountsStmt,
  displayHistoryLineageStmt,
  displayHistoryPageStmt,
  displayHistoryTopStmt,
} from './repo-scan-display-history.ts';
import { historyPassScopePredicate } from './repo-scan-history.ts';
import { codeOf, key, type ScanKit } from './test-kit.ts';

type Display = NonNullable<NonNullable<Parameters<ScanKit['scanTemplate']>[1]>['display']>;

beforeAll(setupActionFixture);

const HISTORY_DISPLAY: Display = {
  v: 1,
  header: { title: 'Welcome' },
  variants: [
    {
      id: 'returning',
      name: 'Returning',
      when: { path: 'history.visits.total', gte: 1 },
      header: { title: 'Returning member' },
    },
  ],
  panels: [{ id: 'p', rows: [{ id: 'r', type: 'history', source: 'scans', show: ['action'] }] }],
};

/** D1 calls of one request after the guard's own reads; a batch is one call. */
async function trips(headers: Record<string, string>, run: () => Promise<unknown>) {
  const original = kit.env.DB;
  const counted = countD1(original);
  Object.assign(kit.env, { DB: counted.db });
  try {
    await kit.post(headers, '/actions', {});
    const guard = counted.count();
    counted.reset();
    clearSettingsCache(counted.db);
    await run();
    return counted.count() - guard;
  } finally {
    Object.assign(kit.env, { DB: original });
  }
}

async function resolveTrips(display: Display) {
  const templateId = await kit.scanTemplate('History trips', {
    actions: [{ ...CHECK_IN, repeat: 'always' }],
    display,
  });
  const scanner = await kit.scanner({ templateIds: [templateId] });
  const pass = await kit.scanPass(templateId);
  for (let i = 0; i < 2; i++) {
    expect((await out(await act(scanner.headers, codeOf(pass)))).kind).toBe('ok');
    kit.clock.advance(1_000);
  }
  let variant: string | null | undefined;
  const calls = await trips(scanner.headers, async () => {
    const response = await kit.post(scanner.headers, '/resolve', {
      idempotencyKey: key(),
      input: codeOf(pass),
      clientTs: kit.clock.now(),
    });
    const outcome = await out(response);
    expect(outcome.kind).toBe('ready');
    variant = outcome.card?.display.variant;
  });
  return { calls, variant };
}

describe('display history round trips', () => {
  it('a resolve that shows history costs no D1 call more than one that does not', async () => {
    const plain = await resolveTrips({ v: 1, header: { title: 'Welcome' } });
    const withHistory = await resolveTrips(HISTORY_DISPLAY);
    // The history is really read and shown: the returning variant needs the earlier visits.
    expect(withHistory.variant).toBe('returning');
    expect(plain.calls).toBeGreaterThan(0);
    expect(withHistory.calls).toBeLessThanOrEqual(plain.calls);
  });

  it('a cold check-in with history over earlier scans takes at most five', async () => {
    const templateId = await kit.scanTemplate('History action trips', {
      actions: [{ ...CHECK_IN, repeat: 'always' }],
      display: HISTORY_DISPLAY,
    });
    const scanner = await kit.scanner({ templateIds: [templateId] });
    const pass = await kit.scanPass(templateId);
    expect((await out(await act(scanner.headers, codeOf(pass)))).kind).toBe('ok');
    kit.clock.advance(1_000);
    const seen = await trips(scanner.headers, async () => {
      expect((await out(await act(scanner.headers, codeOf(pass)))).kind).toBe('ok');
    });
    expect(seen).toBeLessThanOrEqual(5);
  });
});

/** Every statement text and its binds, as the database receives them. */
function recording(db: D1Database) {
  const seen: { sql: string; binds: number }[] = [];
  const proxy = new Proxy(db, {
    get(target, property) {
      if (property === 'prepare')
        return (sql: string) => {
          const statement = target.prepare(sql);
          return new Proxy(statement, {
            get(bound, member) {
              if (member === 'bind')
                return (...values: unknown[]) => {
                  seen.push({ sql, binds: values.length });
                  return bound.bind(...values);
                };
              const value = Reflect.get(bound, member, bound);
              return typeof value === 'function' ? value.bind(bound) : value;
            },
          });
        };
      const value = Reflect.get(target, property, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  return { db: proxy, seen };
}

describe('display, lookup and pending history statements at their widest', () => {
  it('compile on D1 within the read byte and bind budgets', async () => {
    const recorder = recording(kit.env.DB);
    const db = recorder.db;
    const scope = {
      orgId: kit.org.id,
      mode: 'live' as const,
      passId: 'pass',
      templateId: 'template',
      eventId: 'event',
      credentialKeysetCommitment: '0'.repeat(64),
      until: kit.clock.now(),
    };
    const selected = historyPassScopePredicate(scope, scope.until);
    const statements = [
      displayHistoryPageStmt(db, scope, 100, kit.clock.now()),
      displayHistoryCountsStmt(db, selected, 0),
      displayHistoryTopStmt(db, selected),
      displayHistoryLineageStmt(db, {
        orgId: kit.org.id,
        mode: 'live',
        passId: 'pass',
        credentialGeneration: 1,
        lifecycleGeneration: 0,
      }),
      lookupHistoryPageStmt(
        db,
        scope,
        Array.from({ length: 50 }, (_, index) => `scan-${index}`),
        kit.clock.now(),
      ),
      pendingDisplayHistoryStmt(db, {
        scanId: 'scan',
        actorKey: 'key',
        orgId: kit.org.id,
        mode: 'live',
        passId: 'pass',
        templateId: 'template',
        walletVersion: 1,
        now: kit.clock.now(),
      }),
    ];
    expect(recorder.seen).toHaveLength(statements.length);
    for (const { sql, binds } of recorder.seen) {
      expect(new TextEncoder().encode(sql).length).toBeLessThanOrEqual(READ_SQL_BYTE_BUDGET);
      expect(binds).toBeLessThanOrEqual(90);
    }
    const results = await kit.env.DB.batch(statements);
    expect(results).toHaveLength(statements.length);
    expect(results.every((result) => result.success)).toBe(true);
  });
});
