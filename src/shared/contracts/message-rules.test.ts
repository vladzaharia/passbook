import { describe, expect, it } from 'vitest';
import { ruleSummary } from '../copy/message-rules.ts';
import { BroadcastTargetSchema, InputMatchSchema } from './broadcasts.ts';
import { MessageRuleBodySchema } from './message-rules.ts';
import { ScanTargetSchema } from './scan.ts';

const ID = '0190e9a0-0000-7000-8000-000000000001';
const base = {
  orgId: ID,
  name: 'Renewal',
  templateIds: [ID],
  anchor: { kind: 'input', input: 'expiry' },
  offset: { amount: 7, unit: 'day', when: 'before' },
  timeZone: 'Europe/Berlin',
  message: 'Renew soon.',
};
const issues = (body: object) => {
  const r = MessageRuleBodySchema.safeParse(body);
  return r.success ? [] : r.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`);
};

describe('message rule body', () => {
  it('accepts a day rule and fills defaults', () => {
    const r = MessageRuleBodySchema.parse(base);
    expect(r).toMatchObject({ sendAt: '10:00', yearly: false, on: true, clearAfter: 604_800_000 });
  });
  it('limits the send time', () => {
    expect(issues({ ...base, sendAt: '07:59' })).toEqual([
      'sendAt: Pick a time between 08:00 and 20:30.',
    ]);
    expect(issues({ ...base, sendAt: '20:31' })).toHaveLength(1);
    expect(issues({ ...base, sendAt: '08:00' })).toEqual([]);
    expect(issues({ ...base, sendAt: '20:30' })).toEqual([]);
    expect(issues({ ...base, sendAt: '25:00' }).length).toBeGreaterThan(0);
    expect(
      issues({ ...base, offset: { amount: 1, unit: 'hour', when: 'before' }, sendAt: '03:00' }),
    ).toEqual([]);
  });
  it('limits yearly to date inputs in days', () => {
    expect(issues({ ...base, yearly: true })).toEqual([]);
    expect(
      issues({ ...base, yearly: true, offset: { amount: 1, unit: 'hour', when: 'before' } }),
    ).toHaveLength(1);
    expect(
      issues({
        ...base,
        yearly: true,
        anchor: { kind: 'lastScan' },
        offset: { amount: 3, unit: 'day', when: 'after' },
      }),
    ).toHaveLength(1);
  });
  it('limits last scan to days after', () => {
    const scan = { anchor: { kind: 'lastScan' } };
    expect(
      issues({ ...base, ...scan, offset: { amount: 21, unit: 'day', when: 'after' } }),
    ).toEqual([]);
    expect(issues({ ...base, ...scan })).toHaveLength(1);
    expect(
      issues({ ...base, ...scan, offset: { amount: 0, unit: 'day', when: 'after' } }),
    ).toHaveLength(1);
    expect(
      issues({ ...base, ...scan, offset: { amount: 2, unit: 'hour', when: 'after' } }),
    ).toHaveLength(1);
  });
  it('bounds offset, zone, message and templates', () => {
    expect(issues({ ...base, offset: { amount: 367, unit: 'day', when: 'before' } })).toHaveLength(
      1,
    );
    expect(issues({ ...base, timeZone: 'Mars/Base' })).toHaveLength(1);
    expect(issues({ ...base, message: '  ' })).toHaveLength(1);
    expect(issues({ ...base, templateIds: [] })).toHaveLength(1);
  });
});

describe('input match', () => {
  it('takes values, number and date clauses, 1 to 3', () => {
    const ok = [
      { input: 'sailing', values: ['FL1430'] },
      { input: 'age', min: 18 },
      { input: 'birthday', to: '2026-02-28', timeZone: 'Asia/Kolkata' },
    ];
    expect(InputMatchSchema.safeParse(ok).success).toBe(true);
    expect(InputMatchSchema.safeParse([]).success).toBe(false);
    expect(InputMatchSchema.safeParse([...ok, ok[0]]).success).toBe(false);
  });
  it('refuses empty and inverted ranges and bad dates', () => {
    const bad = (c: object) => InputMatchSchema.safeParse([c]).success;
    expect(bad({ input: 'a' })).toBe(false);
    expect(bad({ input: 'a', min: 5, max: 1 })).toBe(false);
    expect(bad({ input: 'a', min: 1, max: 1 })).toBe(true);
    expect(bad({ input: 'a', timeZone: 'UTC' })).toBe(false);
    expect(bad({ input: 'a', from: '2026-02-30', timeZone: 'UTC' })).toBe(false);
    expect(bad({ input: 'a', from: '2026-03-01', to: '2026-02-01', timeZone: 'UTC' })).toBe(false);
    expect(bad({ input: 'a', from: '0050-01-01', timeZone: 'UTC' })).toBe(false);
    expect(bad({ input: 'a', from: '3000-01-01', timeZone: 'UTC' })).toBe(false);
    expect(bad({ input: 'a', from: '1900-01-01', to: '2999-12-31', timeZone: 'UTC' })).toBe(true);
    expect(bad({ input: 'a', values: [] })).toBe(false);
    expect(bad({ input: 'a', values: new Array(21).fill('x') })).toBe(false);
    expect(bad({ input: 'a', values: ['x'.repeat(121)] })).toBe(false);
  });
});

describe('scan target', () => {
  it('parses stored 30 and 90 and any 1..730', () => {
    for (const n of [30, 90, 1, 21, 730])
      expect(ScanTargetSchema.safeParse({ noScanDays: n }).success).toBe(true);
    for (const n of [0, 731, 1.5])
      expect(ScanTargetSchema.safeParse({ noScanDays: n }).success).toBe(false);
  });
  it('strips unknown broadcast target keys', () => {
    const t = BroadcastTargetSchema.parse({
      templateIds: [ID],
      window: { a: 1 },
      sentBy: 'x',
      passIds: ['p'],
    });
    expect(Object.keys(t)).toEqual(['templateIds']);
  });
});

describe('rule summary', () => {
  it('reads as a sentence', () => {
    const o = { anchorLabel: 'Expiry', yearly: false, sendAt: '10:00' };
    expect(ruleSummary({ ...o, offset: { amount: 7, unit: 'day', when: 'before' } })).toBe(
      '7 days before Expiry at 10:00',
    );
    expect(
      ruleSummary({
        ...o,
        anchorLabel: 'Starts',
        offset: { amount: 1, unit: 'hour', when: 'before' },
      }),
    ).toBe('1 hour before Starts');
    expect(
      ruleSummary({
        ...o,
        yearly: true,
        anchorLabel: 'Birthday',
        offset: { amount: 0, unit: 'day', when: 'before' },
      }),
    ).toBe('Every year on Birthday at 10:00');
  });
});
