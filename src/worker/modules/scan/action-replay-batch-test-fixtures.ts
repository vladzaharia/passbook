import { expect } from 'vitest';
import { countD1 } from '../../../../test/helpers/index.ts';
import { ScanOutcomeSchema } from '../../../shared/contracts/scan.ts';
import { putPassCheckIn } from '../passes/check-in.ts';
import { putMemberPhoto } from '../passes/member-photo.ts';
import { clearSettingsCache } from '../settings/service.ts';
import { makePng } from '../templates/package/fixtures.ts';
import { codeOf, key, type ScanKit, setupScanKit } from './test-kit.ts';

export const ACTION = {
  id: 'check_in',
  label: 'Check in',
  kind: 'check_in',
  repeat: 'always',
} as const;

export async function fixture() {
  const kit = await setupScanKit();
  const template = await kit.scanTemplate('Replay history', {
    actions: [ACTION],
    display: {
      v: 1,
      header: { title: 'Welcome', subtitle: '{{history.lastScan.action}}' },
      panels: [
        {
          id: 'p_history',
          rows: [{ id: 'r_history', type: 'history', source: 'scans', show: ['action', 'where'] }],
        },
      ],
    },
  });
  const event = await kit.event({ templateIds: [template] });
  const scanner = await kit.scanner({ eventId: event.id });
  const pass = await kit.scanPass(template, { memberName: 'Replay Private Member' });
  await putPassCheckIn(
    kit.ctx,
    { type: 'system', id: null },
    pass.id,
    { mode: 'in_out', eventId: event.id },
    null,
  );
  const png = btoa(String.fromCharCode(...makePng(270, 270)));
  await putMemberPhoto(
    kit.ctx,
    { type: 'system', id: null },
    pass.id,
    { png, includeInPass: false },
    null,
  );
  const request = {
    idempotencyKey: key(),
    input: codeOf(pass),
    clientTs: kit.clock.now(),
    actionId: ACTION.id,
  };
  const firstResponse = await kit.post(scanner.headers, '/actions', request);
  expect(firstResponse.status).toBe(200);
  const original = ScanOutcomeSchema.parse(await firstResponse.json());
  expect(original).toMatchObject({ kind: 'ok', replay: false, scanId: expect.any(String) });
  if (!original.scanId) throw new Error('Missing recorded scan');
  return { kit, scanner, pass, request, original };
}

export async function coldReplay(kit: ScanKit, headers: Record<string, string>, body: unknown) {
  const real = kit.env.DB;
  const counted = countD1(real);
  Object.assign(kit.env, { DB: counted.db });
  try {
    await kit.post(headers, '/actions', {});
    const guard = counted.count();
    counted.reset();
    clearSettingsCache(counted.db);
    const response = await kit.post(headers, '/actions', body);
    expect(response.status).toBe(200);
    const outcome = ScanOutcomeSchema.parse(await response.json());
    return { outcome, postGuardTrips: counted.count() - guard };
  } finally {
    Object.assign(kit.env, { DB: real });
  }
}

/** Intercept only the final replay receipt CAS, after all original evidence was captured. */
export function beforeReceiptCas(db: D1Database, marker: string, change: () => Promise<unknown>) {
  const sqlByStatement = new WeakMap<D1PreparedStatement, string>();
  let fired = false;
  const wrapped = new Proxy(db, {
    get(target, prop) {
      if (prop === 'prepare')
        return (sql: string) =>
          new Proxy(target.prepare(sql), {
            get(statement, member) {
              if (member === 'bind')
                return (...values: unknown[]) => {
                  const bound = statement.bind(...values);
                  sqlByStatement.set(bound, sql);
                  return bound;
                };
              const value = Reflect.get(statement, member, statement);
              return typeof value === 'function' ? value.bind(statement) : value;
            },
          });
      if (prop === 'batch')
        return async (statements: D1PreparedStatement[]) => {
          if (
            !fired &&
            statements.some((statement) => sqlByStatement.get(statement)?.includes(marker))
          ) {
            fired = true;
            await change();
          }
          return target.batch(statements);
        };
      const value = Reflect.get(target, prop, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  return { db: wrapped, fired: () => fired };
}
