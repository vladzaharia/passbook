import { describe, expect, it } from 'vitest';
import { recordedCheckIn } from './console-privacy-actions-test-fixtures.ts';
import {
  admin,
  app,
  exportPath,
  fake,
  get,
  kit,
  privatePass,
  setupPrivacyKit,
  templateId,
} from './console-privacy-test-fixtures.ts';
import { ORIGIN } from './test-kit.ts';

setupPrivacyKit();

/**
 * Sequential D1 round trips after the first statement that matches `from`: a call that starts while
 * another is in flight rides the same trip. `calls` counts every statement call, a batch as one.
 */
async function tripsFrom(from: RegExp, work: () => Promise<unknown>) {
  const real = kit.env.DB;
  const texts = new WeakMap<D1PreparedStatement, string>();
  const reals = new WeakMap<D1PreparedStatement, D1PreparedStatement>();
  let inflight = 0;
  let started = false;
  let trips = 0;
  let calls = 0;
  const begin = (sql: string) => {
    if (!started && from.test(sql)) started = true;
    if (!started) return false;
    if (inflight === 0) trips++;
    inflight++;
    calls++;
    return true;
  };
  const run = <T>(sql: string, call: () => Promise<T>): Promise<T> => {
    const counted = begin(sql);
    return call().finally(() => {
      if (counted) inflight--;
    });
  };
  const wrap = (statement: D1PreparedStatement, sql: string): D1PreparedStatement => {
    const proxy: D1PreparedStatement = new Proxy(statement, {
      get(target, member) {
        const value = Reflect.get(target, member, target);
        if (member === 'bind') return (...args: unknown[]) => wrap(target.bind(...args), sql);
        if (member === 'first' || member === 'all' || member === 'run' || member === 'raw')
          return (...args: unknown[]) =>
            run(sql, () => (value as (...a: unknown[]) => Promise<never>).apply(target, args));
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    texts.set(proxy, sql);
    reals.set(proxy, statement);
    return proxy;
  };
  kit.env.DB = new Proxy(real, {
    get(target, property) {
      if (property === 'prepare') return (sql: string) => wrap(target.prepare(sql), sql);
      if (property === 'batch')
        return (statements: D1PreparedStatement[]) =>
          run(statements.map((s) => texts.get(s) ?? '').join('\n'), () =>
            target.batch(statements.map((s) => reals.get(s) ?? s)),
          );
      const value = Reflect.get(target, property, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  try {
    await work();
  } finally {
    kit.env.DB = real;
  }
  return { trips, calls };
}

const PAGE = /page AS MATERIALIZED/;

async function signedScan() {
  const scanner = await kit.scanner({ templateIds: [templateId] });
  const pass = await privatePass();
  return recordedCheckIn(scanner, pass.id);
}

describe('history read round trips', () => {
  it('a console list is the page batch, then the manifests with the keyset', async () => {
    await signedScan();
    const { trips, calls } = await tripsFrom(PAGE, async () => {
      expect((await get(`?orgId=${kit.org.id}`)).status).toBe(200);
    });
    expect(trips).toBe(2);
    expect(calls).toBe(3);
  });

  it('a console detail takes the same two trips', async () => {
    const row = await signedScan();
    const { trips } = await tripsFrom(PAGE, async () => {
      expect((await get(`/${row.id}`)).status).toBe(200);
    });
    expect(trips).toBe(2);
  });

  it('an export page takes the same two trips, and a second page adds only its batch', async () => {
    await signedScan();
    const { trips } = await tripsFrom(PAGE, async () => {
      const response = await get(exportPath());
      expect(response.status).toBe(200);
      await response.text();
    });
    expect(trips).toBeLessThanOrEqual(2);
  });

  it('an API-key feed takes at most two trips', async () => {
    await signedScan();
    const apiKey = fake.apiKey({ orgId: kit.org.id, scopes: ['scans:read'] });
    const { trips } = await tripsFrom(PAGE, async () => {
      expect((await get('', apiKey)).status).toBe(200);
    });
    expect(trips).toBeLessThanOrEqual(2);
  });

  it('an empty page is one trip: no keyset and no manifests', async () => {
    const { trips, calls } = await tripsFrom(PAGE, async () => {
      expect((await get(`?orgId=${kit.org.id}`)).status).toBe(200);
    });
    expect(trips).toBe(1);
    expect(calls).toBe(1);
  });

  it('the staff roster takes three trips: the zones, the roster with proofs, the manifests and keyset', async () => {
    const staff = await kit.staff('manager');
    const scanner = await kit.scanner({
      templateIds: [templateId],
      staffId: staff.id,
      settings: { staffSignIn: true },
    });
    await recordedCheckIn(scanner, (await privatePass()).id);
    const { trips } = await tripsFrom(/SELECT DISTINCT sc\.time_zone/, async () => {
      const response = await Promise.resolve(
        app.request(`${ORIGIN}/api/v1/scan-staff?orgId=${kit.org.id}`, { headers: admin }, kit.env),
      );
      expect(response.status).toBe(200);
    });
    expect(trips).toBe(3);
  });
});
