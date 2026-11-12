import { describe, expect, it } from 'vitest';
import { localDayStart, planCounts } from './counts.ts';
import { registerCountsCacheAuthorityCases } from './repo-counts-cache-authority-cases-test-fixtures.ts';
import {
  adminFor,
  csrfFence,
  kit,
  registerCountsFixture,
  scenario,
} from './repo-counts-cache-fixtures.ts';
import { registerCountsCacheReadCases } from './repo-counts-cache-read-cases-fixtures.ts';
import { registerCountsCacheReleaseCases } from './repo-counts-cache-release-cases-fixtures.ts';
import { registerCountsCacheScopeCases } from './repo-counts-cache-scope-cases-fixtures.ts';

describe('scanner local midnight', () => {
  it.each([
    ['2026-11-01T18:00:00Z', 'America/New_York', '2026-11-01T04:00:00Z'],
    ['2026-03-08T18:00:00Z', 'America/New_York', '2026-03-08T05:00:00Z'],
    ['2026-10-04T10:00:00Z', 'Australia/Lord_Howe', '2026-10-03T13:30:00Z'],
    ['2026-11-05T18:00:00Z', 'Asia/Kolkata', '2026-11-04T18:30:00Z'],
  ])('finds midnight across offset changes in %s, %s', (now, zone, midnight) => {
    expect(localDayStart(Date.parse(now), zone)).toBe(Date.parse(midnight));
  });
});

describe('event expected-count cache authority', () => {
  registerCountsFixture();
  registerCountsCacheReadCases();
  registerCountsCacheAuthorityCases();
  registerCountsCacheReleaseCases();
  registerCountsCacheScopeCases();
  it.each([
    { principal: 'scanner', session: true },
    { principal: 'admin', session: true },
    { principal: 'admission', session: false },
    { principal: 'admission', session: true },
  ] as const)(
    'explains every count statement for $principal (session=$session)',
    async ({ principal, session }) => {
      const s = await scenario({ session, admission: principal === 'admission' });
      const actor = principal === 'admin' ? await adminFor(s) : s.actor;
      const countedActor = principal === 'admission' ? { ...actor, event: s.event } : actor;
      const statementNames = [
        'today',
        'managers',
        'event totals',
        'cache CAS',
        'expected fallback',
      ];
      for (const guarded of [false, true]) {
        const guard = guarded ? await csrfFence(actor) : undefined;
        const captured: { sql: string; params: unknown[] }[] = [];
        const db = new Proxy(kit.env.DB, {
          get(target, prop) {
            if (prop === 'prepare')
              return (sql: string) => {
                const statement = target.prepare(sql);
                return new Proxy(statement, {
                  get(prepared, member) {
                    if (member === 'bind')
                      return (...params: unknown[]) => {
                        captured.push({ sql, params });
                        return prepared.bind(...params);
                      };
                    const value = Reflect.get(prepared, member, prepared);
                    return typeof value === 'function' ? value.bind(prepared) : value;
                  },
                });
              };
            const value = Reflect.get(target, prop, target);
            return typeof value === 'function' ? value.bind(target) : value;
          },
        });
        const plan = planCounts(
          { ...kit.ctx, env: { ...kit.env, DB: db } },
          countedActor,
          undefined,
          actor,
          guard,
        );
        expect(plan.stmts.length).toBe(5);
        expect(captured.length).toBe(5);
        const failures: string[] = [];
        for (const [index, { sql, params }] of captured.entries()) {
          try {
            await kit.env.DB.prepare(`EXPLAIN ${sql}`)
              .bind(...params)
              .all();
          } catch (error) {
            const reason =
              error instanceof Error && error.message.includes('Expression tree is too large')
                ? 'expression depth'
                : 'SQL compilation';
            failures.push(`${index} (${statementNames[index]}): ${reason}`);
          }
        }
        expect(failures, `guarded=${guarded}`).toEqual([]);
      }
    },
  );
});
