import { beforeAll, describe, expect, it } from 'vitest';
import { countD1 } from '../../../../test/helpers/index.ts';
import { putPassCheckIn } from '../passes/check-in.ts';
import { putMemberPhoto } from '../passes/member-photo.ts';
import { clearSettingsCache } from '../settings/service.ts';
import { makePng } from '../templates/package/fixtures.ts';
import { act, CHECK_IN, kit, out, setupActionFixture, tpl } from './act-test-fixtures.ts';
import { codeOf } from './test-kit.ts';

beforeAll(setupActionFixture);

/** DB calls an action makes after the guard's own reads; a batch is one call. */
async function tripsOf(headers: Record<string, string>, run: () => Promise<unknown>) {
  const original = kit.env.DB;
  const counted = countD1(original);
  const calls: string[] = [];
  const traced = new Proxy(counted.db, {
    get(target, prop) {
      const value = Reflect.get(target, prop, target);
      if (prop === 'batch')
        return (statements: D1PreparedStatement[]) => {
          const done = (value as (s: D1PreparedStatement[]) => Promise<unknown>).call(
            target,
            statements,
          );
          const batch = counted.sql().slice(-statements.length);
          calls.push(
            `[${statements.length}] ${batch.map((q) => q.replace(/\s+/g, ' ').slice(0, 28)).join(' | ')}`,
          );
          return done;
        };
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  Object.assign(kit.env, { DB: traced });
  try {
    await kit.post(headers, '/actions', {});
    const guard = counted.count();
    counted.reset();
    calls.length = 0;
    clearSettingsCache(counted.db);
    await run();
    return { trips: counted.count() - guard, calls };
  } finally {
    Object.assign(kit.env, { DB: original });
  }
}

const heads = (calls: string[]) => `\n${calls.join('\n')}`;

describe('scan write round trips (design 4.7)', () => {
  it('a cold check-in with history and photo takes at most five', async () => {
    const templateId = await kit.scanTemplate('Cold visit history trips', {
      actions: [{ ...CHECK_IN, repeat: 'always' }],
      display: {
        v: 1,
        header: { title: 'First visit' },
        variants: [
          {
            id: 'returning',
            name: 'Returning',
            when: { path: 'history.visits.total', gte: 1 },
            header: { title: 'Returning member' },
          },
        ],
        photo: { minRole: 'door' },
        panels: [
          { id: 'p', rows: [{ id: 'r', type: 'history', source: 'scans', show: ['action'] }] },
        ],
      },
    });
    const scanner = await kit.scanner({ templateIds: [templateId] });
    const pass = await kit.scanPass(templateId);
    await putPassCheckIn(kit.ctx, { type: 'system', id: null }, pass.id, { mode: 'in_out' }, null);
    const png = btoa(String.fromCharCode(...makePng(270, 270)));
    await putMemberPhoto(
      kit.ctx,
      { type: 'system', id: null },
      pass.id,
      { png, includeInPass: false },
      null,
    );
    const seen = await tripsOf(scanner.headers, async () => {
      expect((await out(await act(scanner.headers, codeOf(pass)))).kind).toBe('ok');
    });
    expect(seen.trips, heads(seen.calls)).toBeLessThanOrEqual(5);
  });

  it('a cold admission with a photo takes at most five', async () => {
    const scanner = await kit.scanner({ templateIds: [tpl] });
    const pass = await kit.scanPass(tpl);
    await putPassCheckIn(kit.ctx, { type: 'system', id: null }, pass.id, { mode: 'in_out' }, null);
    const png = btoa(String.fromCharCode(...makePng(270, 270)));
    await putMemberPhoto(
      kit.ctx,
      { type: 'system', id: null },
      pass.id,
      { png, includeInPass: false },
      null,
    );
    const seen = await tripsOf(scanner.headers, async () => {
      expect((await out(await act(scanner.headers, codeOf(pass)))).kind).toBe('ok');
    });
    expect(seen.trips, heads(seen.calls)).toBeLessThanOrEqual(5);
  });

  it('a held scan (already done) takes at most four', async () => {
    const scanner = await kit.scanner({ templateIds: [tpl] });
    const pass = await kit.scanPass(tpl);
    expect((await out(await act(scanner.headers, codeOf(pass)))).kind).toBe('ok');
    const seen = await tripsOf(scanner.headers, async () => {
      expect((await out(await act(scanner.headers, codeOf(pass)))).kind).toBe('heads_up');
    });
    expect(seen.trips, heads(seen.calls)).toBeLessThanOrEqual(4);
  });

  it('a stop (voided pass) takes at most four', async () => {
    const scanner = await kit.scanner({ templateIds: [tpl] });
    const pass = await kit.scanPass(tpl);
    await kit.env.DB.prepare("UPDATE passes SET status='voided' WHERE id=?").bind(pass.id).run();
    const seen = await tripsOf(scanner.headers, async () => {
      expect((await out(await act(scanner.headers, codeOf(pass)))).kind).toBe('refused');
    });
    expect(seen.trips, heads(seen.calls)).toBeLessThanOrEqual(4);
  });

  it('a miss (unknown code) takes at most four', async () => {
    const scanner = await kit.scanner({ templateIds: [tpl] });
    const seen = await tripsOf(scanner.headers, async () => {
      const outcome = await out(
        await act(scanner.headers, { code: 'ZZZZ-NOPE', method: 'camera' }),
      );
      expect(outcome.kind).toBe('refused');
    });
    expect(seen.trips, heads(seen.calls)).toBeLessThanOrEqual(4);
  });
});
