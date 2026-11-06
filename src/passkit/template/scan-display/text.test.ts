import { describe, expect, it } from 'vitest';
import { testCond } from './condition.ts';
import { ctxOf, NOW, scopeOf } from './test-kit.ts';
import { evalExpr, evalText, parseParts, resolve } from './text.ts';

const DAY = 86_400_000;

describe('bindings', () => {
  const ctx = ctxOf(
    scopeOf(
      { tier: 'VIP', seat: 12, row: '', n: 1 },
      { history: { visits: { total: 3 } }, scan: { before: 7 } },
    ),
  );

  it('resolves roots, bare inputs and nested paths', () => {
    expect(resolve(ctx.scope, 'inputs.tier')).toBe('VIP');
    expect(resolve(ctx.scope, 'tier')).toBe('VIP');
    expect(resolve(ctx.scope, 'history.visits.total')).toBe(3);
    expect(resolve(ctx.scope, 'inputs.__proto__')).toBeUndefined();
    expect(resolve(ctx.scope, 'constructor.name')).toBeUndefined();
  });

  it('keeps a lone path typed and stringifies the rest', () => {
    expect(evalExpr('{{inputs.seat}}', ctx)).toBe(12);
    expect(evalExpr('Seat {{inputs.seat}}', ctx)).toBe('Seat 12');
  });

  it('is strict: any empty binding empties the whole text', () => {
    expect(evalText('Row {{inputs.row}} · Seat {{inputs.seat}}', ctx)).toBe('');
    expect(evalText('Seat {{inputs.nope}}', ctx)).toBe('');
    expect(evalText('{{inputs.tier|upper}}', ctx)).toBe('VIP');
  });

  it('never yields unbound syntax', () => {
    expect(evalText('Hi {{inputs.tier', ctx)).toBe('');
    expect(evalText('{{}}', ctx)).toBe('');
    expect(parseParts('{{a|b|c}}').error).toMatch(/one filter/);
    const odd = ctxOf(scopeOf({ name: 'x {{y}}' }));
    expect(evalText('{{inputs.name}}', odd)).toBe('');
  });

  it('picks plural forms with Intl.PluralRules and fills #', () => {
    const plural = { count: '{{inputs.n}}', one: '# visit', other: '# visits', zero: 'None' };
    expect(evalText(plural, ctx)).toBe('1 visit');
    expect(evalText(plural, ctxOf(scopeOf({ n: 3 })))).toBe('3 visits');
    expect(evalText(plural, ctxOf(scopeOf({ n: 0 })))).toBe('None');
    expect(
      evalText({ count: '{{inputs.n}}', one: '#', other: '#' }, ctxOf(scopeOf({ n: 1240 }))),
    ).toBe('1,240');
    expect(evalText(plural, ctxOf(scopeOf({})))).toBe('');
  });
});

describe('conditions', () => {
  const ctx = ctxOf(
    scopeOf(
      { tier: 'VIP', stamps: '7', blank: '' },
      {
        pass: { validUntil: NOW + 10 * DAY },
        history: { lastVisit: { at: NOW - 45 * DAY }, visits: { total: 3 } },
      },
    ),
  );

  it('compares by path and by the input sugar', () => {
    expect(testCond({ path: 'inputs.tier', eq: 'VIP' }, ctx)).toBe(true);
    expect(testCond({ input: 'tier', eq: 'Gold' }, ctx)).toBe(false);
    expect(testCond({ path: 'inputs.tier', in: ['Gold', 'VIP'] }, ctx)).toBe(true);
    expect(testCond({ path: 'inputs.blank', empty: true }, ctx)).toBe(true);
    expect(testCond({ path: 'inputs.nope', empty: true }, ctx)).toBe(true);
    expect(testCond({ path: 'inputs.nope', eq: 'x' }, ctx)).toBe(false);
  });

  it('coerces numeric strings and is false on non-numbers', () => {
    expect(testCond({ path: 'inputs.stamps', gte: 7 }, ctx)).toBe(true);
    expect(testCond({ path: 'inputs.stamps', gt: 7 }, ctx)).toBe(false);
    expect(testCond({ path: 'inputs.tier', gt: 1 }, ctx)).toBe(false);
  });

  it('measures daysFromNow in calendar days, past negative', () => {
    expect(testCond({ path: 'pass.validUntil', daysFromNow: { gte: 0, lte: 14 } }, ctx)).toBe(true);
    expect(testCond({ path: 'pass.validUntil', daysFromNow: { lte: 5 } }, ctx)).toBe(false);
    expect(testCond({ path: 'history.lastVisit.at', daysFromNow: { lt: -30 } }, ctx)).toBe(true);
    expect(testCond({ path: 'inputs.nope', daysFromNow: { lt: 0 } }, ctx)).toBe(false);
  });

  it('combines all, any and not', () => {
    const vip = { path: 'inputs.tier', eq: 'VIP' };
    const gold = { path: 'inputs.tier', eq: 'Gold' };
    expect(testCond({ all: [vip, { not: gold }] }, ctx)).toBe(true);
    expect(testCond({ any: [gold, { path: 'history.visits.total', gte: 3 }] }, ctx)).toBe(true);
    expect(testCond({ all: [vip, gold] }, ctx)).toBe(false);
  });
});
