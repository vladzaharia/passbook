import { expect } from 'vitest';
import type { ScannerFixture } from '../../../../test/helpers/index.ts';
import type { ScanOutcome } from '../../../shared/contracts/scan.ts';
import type { Pass } from '../passes/repo.ts';
import { codeOf, key, type ScanKit, setupScanKit } from './test-kit.ts';

export const ACTION = { id: 'check_in', label: 'Check in', kind: 'check_in' } as const;

export interface BudgetKit {
  kit: ScanKit;
  managerTemplate: string;
  plainTemplate: string;
}

export async function budgetKit(): Promise<BudgetKit> {
  const kit = await setupScanKit();
  const managerTemplate = await kit.scanTemplate('PIN-protected action', {
    actions: [{ ...ACTION, minRole: 'manager' }],
  });
  const plainTemplate = await kit.scanTemplate('Unrestricted action', { actions: [ACTION] });
  return { kit, managerTemplate, plainTemplate };
}

export async function scenario(f: BudgetKit, template = f.managerTemplate) {
  const scanner = await f.kit.scanner({ templateIds: [template] });
  const manager = await f.kit.staff('manager');
  const pass = await f.kit.scanPass(template);
  return { scanner, manager, pass };
}

export function action(
  kit: ScanKit,
  scanner: ScannerFixture,
  pass: Pass,
  extra: Record<string, unknown> = {},
) {
  return kit.post(scanner.headers, '/actions', {
    idempotencyKey: key(),
    input: codeOf(pass),
    clientTs: kit.clock.now(),
    actionId: ACTION.id,
    ...extra,
  });
}

export async function outcome(response: Response): Promise<ScanOutcome> {
  expect(response.status).toBe(200);
  return (await response.json()) as ScanOutcome;
}

export interface RecordedStatement {
  sql: string;
  values: unknown[];
}
export type RecordedBatch = RecordedStatement[];
type Hook = (batch: RecordedBatch) => Promise<void>;

/** Observe and interleave at real D1 transaction boundaries, without replacing statements or results. */
export function traceD1(db: D1Database, hooks: { before?: Hook; after?: Hook } = {}) {
  const recorded = new WeakMap<D1PreparedStatement, RecordedStatement>();
  const batches: RecordedBatch[] = [];
  const proxy = new Proxy(db, {
    get(target, property) {
      if (property === 'prepare')
        return (sql: string) =>
          new Proxy(target.prepare(sql), {
            get(statement, member) {
              if (member === 'bind')
                return (...values: unknown[]) => {
                  const bound = statement.bind(...values);
                  recorded.set(bound, { sql, values });
                  return bound;
                };
              const value = Reflect.get(statement, member, statement);
              return typeof value === 'function' ? value.bind(statement) : value;
            },
          });
      if (property === 'batch')
        return async (statements: D1PreparedStatement[]) => {
          const batch = statements.map(
            (statement) => recorded.get(statement) ?? { sql: '', values: [] },
          );
          batches.push(batch);
          await hooks.before?.(batch);
          const result = await target.batch(statements);
          await hooks.after?.(batch);
          return result;
        };
      const value = Reflect.get(target, property, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  return { db: proxy, batches };
}

export const hasGate = (batch: RecordedBatch) =>
  batch.some(({ sql }) => /INSERT\s+INTO\s+scan_gates\b/i.test(sql));
export const hasReservation = (batch: RecordedBatch) =>
  batch.some(({ values }) =>
    values.some((value) => typeof value === 'string' && value.startsWith('scan:pin-reservation:')),
  );

export async function withTrace<T>(
  kit: ScanKit,
  hooks: { before?: Hook; after?: Hook },
  work: () => Promise<T>,
) {
  const real = kit.env.DB;
  const trace = traceD1(real, hooks);
  Object.assign(kit.env, { DB: trace.db });
  try {
    return { result: await work(), batches: trace.batches };
  } finally {
    Object.assign(kit.env, { DB: real });
  }
}
