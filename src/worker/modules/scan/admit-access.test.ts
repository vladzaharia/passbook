import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { TEST_NOW } from '../../../../test/helpers/index.ts';
import { accessTemplate, grantOf, makeDoor } from './access-test-fixtures.ts';
import { HOUR, kit, MINUTE, setupActionFixture } from './act-test-fixtures.ts';

beforeAll(setupActionFixture);
afterEach(() => kit.clock.set(TEST_NOW));
const iso = (ms: number) => new Date(ms).toISOString();

describe('admit on an Access card', () => {
  it('counts guest visits, then names the type when none are left', async () => {
    const tpl = await accessTemplate();
    const d = await makeDoor([tpl]);
    const pass = await kit.scanPass(tpl, { plan: 'guest', visits: 2 });
    const one = await grantOf(d.headers, pass);
    expect(one.admit).toMatchObject({
      type: 'Guest day',
      rule: { kind: 'visit', n: 1, of: 2 },
    });
    kit.clock.advance(3 * HOUR);
    expect((await grantOf(d.headers, pass)).admit?.rule).toEqual({ kind: 'visit', n: 2, of: 2 });
    kit.clock.advance(3 * HOUR);
    const used = await grantOf(d.headers, pass);
    expect(used).toMatchObject({ reason: 'guest_visits_used', admit: { type: 'Guest day' } });
  });

  it('a guest past its end names the type', async () => {
    const tpl = await accessTemplate();
    const d = await makeDoor([tpl]);
    const pass = await kit.scanPass(tpl, { plan: 'guest', validUntil: iso(TEST_NOW - MINUTE) });
    const out = await grantOf(d.headers, pass);
    expect(out).toMatchObject({ reason: 'guest_expired', admit: { type: 'Guest day' } });
  });

  it('a timed plan carries its label and closing time', async () => {
    const tpl = await accessTemplate();
    const d = await makeDoor([tpl]);
    const pass = await kit.scanPass(tpl, { plan: 'off_peak' });
    const out = await grantOf(d.headers, pass);
    expect(out.kind).toBe('ok');
    expect(out.access?.closesAt).not.toBeNull();
    expect(out.admit).toMatchObject({
      type: 'Off-peak',
      rule: { kind: 'until', at: out.access?.closesAt },
    });
  });

  it('a 24/7 member has the plan label and no rule', async () => {
    const tpl = await accessTemplate();
    const d = await makeDoor([tpl]);
    const out = await grantOf(d.headers, await kit.scanPass(tpl, { plan: 'gold' }));
    expect(out.admit).toMatchObject({ type: '24/7 Gold', rule: null });
  });
});
