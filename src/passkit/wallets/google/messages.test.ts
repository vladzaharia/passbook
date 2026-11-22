import { describe, expect, it } from 'vitest';
import type { PassJson } from '../../schema/pass-types.ts';
import { type DeliveredMessage, googleChangeMessage, withMessageHistory } from './messages.ts';
import type { GoogleObjectCommon } from './types.ts';

interface F {
  key: string;
  value: unknown;
  label?: string;
  changeMessage?: string;
  dateStyle?: string;
  currencyCode?: string;
}

const pass = (
  fields: F[],
  extra: { organizationName?: string; back?: F[]; voided?: boolean } = {},
): PassJson =>
  ({
    formatVersion: 1,
    organizationName: extra.organizationName ?? 'Acme',
    description: 'd',
    serialNumber: 's',
    passTypeIdentifier: 'p',
    teamIdentifier: 't',
    generic: { primaryFields: fields, backFields: extra.back ?? [] },
  }) as unknown as PassJson;

const tier = (value: string, message = 'Tier is now %@'): F => ({
  key: 'tier',
  value,
  changeMessage: message,
});

describe('googleChangeMessage', () => {
  it('is null with fewer than two versions', () => {
    expect(googleChangeMessage([pass([tier('Gold')])])).toBeNull();
    expect(googleChangeMessage([])).toBeNull();
  });

  it('fills the value and uses the organization as header', () => {
    const msg = googleChangeMessage([pass([tier('Silver')]), pass([tier('Gold')])]);
    expect(msg).toEqual({ header: 'Acme', body: 'Tier is now Gold' });
  });

  it('turns %% into a percent sign in one pass', () => {
    const msg = googleChangeMessage([
      pass([tier('1', '%% off: %@')]),
      pass([tier('50', '%% off: %@')]),
    ]);
    expect(msg?.body).toBe('% off: 50');
  });

  it('formats dates and currency like the text module', () => {
    const date = (v: string) => ({
      key: 'd',
      value: v,
      dateStyle: 'PKDateStyleMedium',
      changeMessage: 'Moved to %@',
    });
    const when = googleChangeMessage([
      pass([date('2026-12-01T10:00:00Z')]),
      pass([date('2026-12-02T10:00:00Z')]),
    ]);
    expect(when?.body).toMatch(/^Moved to .*2026/u);
    const cash = (v: number) => ({
      key: 'c',
      value: v,
      currencyCode: 'USD',
      changeMessage: 'Balance %@',
    });
    expect(googleChangeMessage([pass([cash(5)]), pass([cash(7)])])?.body).toBe('Balance 7 USD');
  });

  it('ignores new, unmoved and silent fields', () => {
    expect(googleChangeMessage([pass([]), pass([tier('Gold')])])).toBeNull();
    expect(googleChangeMessage([pass([tier('Gold')]), pass([tier('Gold')])])).toBeNull();
    const silent = { key: 'tier', value: 'Gold' };
    expect(googleChangeMessage([pass([tier('Silver')]), pass([silent])])).toBeNull();
  });

  it('joins fields in front-to-back order', () => {
    const a = (v: string): F => ({ key: 'a', value: v, changeMessage: 'A is %@' });
    const b = (v: string): F => ({ key: 'b', value: v, changeMessage: 'B is %@' });
    const msg = googleChangeMessage([
      pass([a('1')], { back: [b('1')] }),
      pass([a('2')], { back: [b('2')] }),
    ]);
    expect(msg?.body).toBe('A is 2\nB is 2');
  });

  it('keeps a change from an earlier version in the range', () => {
    const a = (v: string, m?: string): F => ({
      key: 'a',
      value: v,
      ...(m ? { changeMessage: m } : {}),
    });
    const b = (v: string, m?: string): F => ({
      key: 'b',
      value: v,
      ...(m ? { changeMessage: m } : {}),
    });
    const v4 = pass([a('1'), b('1')]);
    const v5 = pass([a('2', 'A is %@'), b('1')]);
    const v6 = pass([a('2'), b('2', 'B is %@')]);
    expect(googleChangeMessage([v4, v5, v6])?.body).toBe('A is 2\nB is 2');
  });

  it('drops a change a later silent move overtook', () => {
    const a = (v: string, m?: string): F => ({
      key: 'a',
      value: v,
      ...(m ? { changeMessage: m } : {}),
    });
    const v1 = pass([a('1')]);
    const v2 = pass([a('2', 'A is %@')]);
    const v3 = pass([a('3')]);
    expect(googleChangeMessage([v1, v2, v3])).toBeNull();
  });

  it('removes control characters', () => {
    const msg = googleChangeMessage([pass([tier('a')]), pass([tier('b\u0007c')])]);
    expect(msg?.body).toBe('Tier is now b c');
  });

  it('cuts 600 characters to 500 with an ellipsis', () => {
    const msg = googleChangeMessage([pass([tier('a')]), pass([tier('x'.repeat(600), '%@')])]);
    expect([...(msg?.body ?? '')]).toHaveLength(500);
    expect(msg?.body.endsWith('…')).toBe(true);
  });
});

const NOW = Date.UTC(2026, 10, 22);
const DAY = 24 * 60 * 60 * 1000;
const msg = (n: number, ageDays: number): DeliveredMessage => ({
  id: `pbm_${n}`,
  header: 'Acme',
  body: `m${n}`,
  settledAt: NOW - ageDays * DAY,
});
const base = { multipleDevicesAndHoldersAllowedStatus: 'x' } as unknown as GoogleObjectCommon;

describe('withMessageHistory', () => {
  it('keeps the newest 9 as TEXT, oldest first', () => {
    const history = Array.from({ length: 12 }, (_, i) => msg(i, 12 - i));
    const out = withMessageHistory(base, history, false, NOW).messages ?? [];
    expect(out.map((m) => m.body)).toEqual([
      'm3',
      'm4',
      'm5',
      'm6',
      'm7',
      'm8',
      'm9',
      'm10',
      'm11',
    ]);
    expect(out.every((m) => m.messageType === 'TEXT')).toBe(true);
  });

  it('drops messages older than 30 days', () => {
    const out = withMessageHistory(base, [msg(1, 31), msg(2, 29)], false, NOW).messages ?? [];
    expect(out.map((m) => m.body)).toEqual(['m2']);
  });

  it('sends an empty list for no history', () => {
    expect(withMessageHistory(base, [], false, NOW).messages).toEqual([]);
  });

  it('carries only the voided message for a voided pass', () => {
    const out = withMessageHistory(base, [msg(1, 1)], true, NOW).messages ?? [];
    expect(out.map((m) => m.id)).toEqual(['voided']);
  });
});

describe('googleChangeMessage edge cases', () => {
  it('is null for a voided target', () => {
    const v1 = pass([tier('Silver')]);
    const v2 = { ...pass([tier('Gold')]), voided: true } as PassJson;
    expect(googleChangeMessage([v1, v2])).toBeNull();
  });

  it('lists a field once when a poster carries it in two dictionaries', () => {
    const f = (v: string) => tier(v, 'Your tier is now %@.');
    const poster = (v: string) =>
      ({
        ...pass([f(v)]),
        posterGeneric: { primaryFields: [f(v)] },
      }) as unknown as PassJson;
    expect(googleChangeMessage([poster('Silver'), poster('Gold')])?.body).toBe(
      'Your tier is now Gold.',
    );
  });

  it('lists identical lines once across different keys (Henry fields)', () => {
    const f = (key: string, v: string): F => ({ key, value: v, changeMessage: 'Now %@' });
    const msg = googleChangeMessage([
      pass([f('status', 'a'), f('club', 'a')]),
      pass([f('status', 'b'), f('club', 'b')]),
    ]);
    expect(msg?.body).toBe('Now b');
  });

  it("words a date as the target's style shows it", () => {
    const date = (style: string): F => ({
      key: 'd',
      value: '2026-12-02T10:00:00Z',
      dateStyle: style,
      changeMessage: 'Moved to %@',
    });
    const short = googleChangeMessage([
      pass([date('PKDateStyleShort')]),
      pass([date('PKDateStyleShort')]),
    ]);
    expect(short).toBeNull();
    const target = pass([{ ...date('PKDateStyleFull'), changeMessage: 'Moved to %@' }]);
    const base = pass([{ ...date('PKDateStyleShort'), value: '2026-12-01T10:00:00Z' }]);
    const full = googleChangeMessage([base, target])?.body;
    const medium = googleChangeMessage([
      pass([{ ...date('PKDateStyleMedium'), value: '2026-12-01T10:00:00Z' }]),
      pass([date('PKDateStyleMedium')]),
    ])?.body;
    expect(full).not.toBe(medium);
    expect(full).toMatch(/December/u);
  });

  it('gives no message for a field that moves silently and then back', () => {
    const a = (v: string, m?: string): F => ({
      key: 'a',
      value: v,
      ...(m ? { changeMessage: m } : {}),
    });
    const v1 = pass([a('1')]);
    const v2 = pass([a('2', 'A is %@')]);
    const v3 = pass([a('3')]);
    const v4 = pass([a('2')]);
    expect(googleChangeMessage([v1, v2, v3, v4])).toBeNull();
  });
});

describe('withMessageHistory ordering', () => {
  it('breaks settledAt ties on id, stable under shuffled input', () => {
    const history = Array.from({ length: 11 }, (_, i) => ({ ...msg(i, 1), settledAt: NOW - DAY }));
    const shuffled = [...history].reverse();
    const a = withMessageHistory(base, history, false, NOW).messages ?? [];
    const b = withMessageHistory(base, shuffled, false, NOW).messages ?? [];
    expect(a).toEqual(b);
    expect(a).toHaveLength(9);
  });

  it('drops a message exactly 30 days old and keeps one just inside', () => {
    const edge = { ...msg(1, 30), settledAt: NOW - 30 * DAY };
    const inside = { ...msg(2, 30), settledAt: NOW - 30 * DAY + 1 };
    const out = withMessageHistory(base, [edge, inside], false, NOW).messages ?? [];
    expect(out.map((m) => m.id)).toEqual(['pbm_2']);
  });
});
