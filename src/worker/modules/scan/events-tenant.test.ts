import { describe, expect, it } from 'vitest';
import { ProblemSchema, ScanEventSchema } from '../../../shared/contracts/index.ts';
import { first, run } from '../../platform/db.ts';
import {
  admin,
  call,
  clock,
  env,
  eventId,
  f,
  freeScannerId,
  input,
  member,
  orgId,
  page,
  secondTemplateId,
  templateId,
} from './events-tenant-split-test-fixtures.ts';
import { state } from './repo-events-tenant-state-test-fixtures.ts';

describe('scan event tenant routes', () => {
  it('does not treat a platform admin as a member', async () => {
    const before = await state();
    expect(await page(await call(admin, 'GET', `?orgId=${orgId}`))).toEqual({
      items: [],
      nextCursor: null,
    });
    expect((await call(admin, 'GET', `/${eventId}`)).status).toBe(404);
    const create = await call(admin, 'POST', '', input());
    expect(create.status).toBe(404);
    expect(ProblemSchema.parse(await create.json()).code).toBe('ORG_NOT_FOUND');
    expect((await call(admin, 'PATCH', `/${eventId}`, { name: 'Changed' })).status).toBe(404);
    expect((await call(admin, 'POST', `/${eventId}/archive`)).status).toBe(404);
    expect(
      (await call(admin, 'POST', `/${eventId}/scanners`, { scannerIds: [freeScannerId] })).status,
    ).toBe(404);
    expect(await state()).toEqual(before);
  });

  it('allows an organization administrator without a platform admin role', async () => {
    const events = await page(await call(member, 'GET', `?orgId=${orgId}`));
    expect(events.items.map((item) => item.id)).toContain(eventId);
    expect((await call(member, 'GET', `/${eventId}`)).status).toBe(200);
    const created = await call(member, 'POST', '', input());
    expect(created.status).toBe(201);
    const { id } = ScanEventSchema.parse(await created.json());
    expect(
      (await call(member, 'PATCH', `/${id}`, { name: 'Revised', templateIds: [secondTemplateId] }))
        .status,
    ).toBe(200);
    expect(
      (await call(member, 'POST', `/${id}/scanners`, { scannerIds: [freeScannerId] })).status,
    ).toBe(200);
    expect((await call(member, 'POST', `/${id}/archive`)).status).toBe(200);
    expect((await call(member, 'PATCH', `/${id}`, { archived: false })).status).toBe(200);
  });

  it('assigns the full 200-scanner contract limit within D1 binding limits', async () => {
    const ids = Array.from({ length: 200 }, () => f.ids.id());
    await run(
      env.DB,
      `INSERT INTO scanners
      (id,org_id,mode,kind,device_role,name,settings,time_zone,created_at,updated_at)
      SELECT value,?,'live','device','scan',value,'{}','UTC',?,? FROM json_each(?)`,
      [orgId, clock.now(), clock.now(), JSON.stringify(ids)],
    );
    await run(
      env.DB,
      `INSERT INTO scanner_templates (scanner_id,template_id)
      SELECT value,? FROM json_each(?)`,
      [templateId, JSON.stringify(ids)],
    );

    const real = env.DB;
    let maxBindings = 0;
    const limited = new Proxy(real, {
      get(target, prop) {
        if (prop === 'prepare')
          return (sql: string) => {
            const prepared = target.prepare(sql);
            return new Proxy(prepared, {
              get(statement, member) {
                if (member === 'bind')
                  return (...values: unknown[]) => {
                    maxBindings = Math.max(maxBindings, values.length);
                    if (values.length > 100) throw new Error('D1 binding limit exceeded');
                    return statement.bind(...values);
                  };
                const value = Reflect.get(statement, member, statement);
                return typeof value === 'function' ? value.bind(statement) : value;
              },
            });
          };
        const value = Reflect.get(target, prop, target);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    Object.assign(env, { DB: limited });
    try {
      const response = await call(member, 'POST', `/${eventId}/scanners`, { scannerIds: ids });
      expect(response.status).toBe(200);
      expect(ScanEventSchema.parse(await response.json()).scanners).toBe(201);
      expect(maxBindings).toBeLessThanOrEqual(100);
      expect(
        await first(
          real,
          `SELECT count(*) AS n FROM scanners
        WHERE event_id=? AND id IN (SELECT value FROM json_each(?))`,
          [eventId, JSON.stringify(ids)],
        ),
      ).toEqual({ n: 200 });
      expect(
        await first(
          real,
          `SELECT count(*) AS n FROM scanner_templates
        WHERE scanner_id IN (SELECT value FROM json_each(?))`,
          [JSON.stringify(ids)],
        ),
      ).toEqual({ n: 0 });
    } finally {
      Object.assign(env, { DB: real });
    }
  }, 120_000);
});
