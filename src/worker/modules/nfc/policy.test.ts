import { describe, expect, it } from 'vitest';
import {
  assertSessionLevel,
  type Confirm,
  doorConfirm,
  sessionTakesType,
  strongerConfirm,
  type TagTypeFacts,
  typeFit,
} from './policy.ts';

const type = (over: Partial<TagTypeFacts> = {}): TagTypeFacts => ({
  id: 'ty-1',
  name: 'Wristband',
  use: 'member',
  confirm: 'none',
  templateIds: [],
  ...over,
});
const rank = { none: 0, staff: 1, manager: 2 } as const;
const CONFIRMS: Confirm[] = ['none', 'staff', 'manager'];

describe('the door policy matrix', () => {
  it.each([
    [undefined, null, true],
    [undefined, type(), true],
    [[], null, false],
    [[], type(), false],
    [['standard'], null, true],
    [['standard'], type(), false],
    [['ty-1'], type(), true],
    [['ty-1'], null, false],
    [['ty-2', 'standard'], type(), false],
    [['ty-2', 'ty-1'], type(), true],
  ] as const)('session types %j takes type %j: %s', (types, t, takes) => {
    expect(sessionTakesType(types, t)).toBe(takes);
  });

  it.each([
    // [type templates, template, uses, type use, fit]
    [[], 't1', undefined, 'member', 'ok'],
    [['t1'], 't1', undefined, 'member', 'ok'],
    [['t2'], 't1', undefined, 'member', 'template'],
    [['t1', 't2'], 't2', ['member'], 'member', 'ok'],
    [[], 't1', ['staff'], 'member', 'use'],
    [[], 't1', ['staff', 'member'], 'member', 'ok'],
    [[], 't1', ['visitor'], 'staff', 'use'],
    [['t2'], 't1', ['staff'], 'staff', 'template'],
  ] as const)(
    'templates %j, pass of %s taking %j, type of use %s: %s',
    (templateIds, template, uses, use, fit) => {
      expect(typeFit(type({ templateIds, use }), template, uses)).toBe(fit);
    },
  );

  it('Standard is a member tag on any template', () => {
    expect(typeFit(null, 't1', undefined)).toBe('ok');
    expect(typeFit(null, 't1', ['member', 'staff'])).toBe('ok');
    expect(typeFit(null, 't1', ['staff'])).toBe('use');
  });

  it.each(CONFIRMS.flatMap((a) => CONFIRMS.map((b) => [a, b] as const)))(
    'the stronger of %s and %s',
    (a, b) => {
      const expected = rank[a] >= rank[b] ? a : b;
      expect(strongerConfirm(a, b)).toBe(expected);
    },
  );

  it.each(
    (['uid', 'sun'] as const).flatMap((system) =>
      [null, ...CONFIRMS].flatMap((own) =>
        [undefined, ...CONFIRMS].map((session) => [system, own, session] as const),
      ),
    ),
  )('%s tag, type confirm %s, session confirmBasic %s', (system, own, session) => {
    const t = own === null ? null : type({ confirm: own });
    // The session rule binds Basic tags only; the type's own confirm always applies.
    const fromType = own === null ? 'none' : own;
    const fromSession = system === 'uid' ? (session ?? 'none') : 'none';
    const expected = rank[fromType] >= rank[fromSession] ? fromType : fromSession;
    expect(doorConfirm(t, system, session)).toBe(expected);
  });

  it.each([
    ['uid', undefined, true],
    ['uid', 'basic', true],
    ['uid', 'secure', false],
    ['uid', 'off', false],
    ['sun', undefined, true],
    ['sun', 'basic', true],
    ['sun', 'secure', true],
    ['sun', 'off', false],
  ] as const)('a %s tag at session level %s binds: %s', (system, level, ok) => {
    if (ok) expect(() => assertSessionLevel(level, system)).not.toThrow();
    else
      expect(() => assertSessionLevel(level, system)).toThrow(
        expect.objectContaining({ code: level === 'off' ? 'TAGS_OFF' : 'TAG_SECURE_REQUIRED' }),
      );
  });
});
