import { describe, expect, it } from 'vitest';
import type { TemplateManifest } from '../../../passkit/types.ts';
import type { ResolvedScanAction } from '../../../shared/scan-defaults.ts';
import {
  appliedAmount,
  currencyField,
  ScanEffectStop,
  valueEffect,
  valueRequestIssue,
} from './effects-value.ts';
import { scanPolicy } from './rules.ts';

const manifest = (balance: Record<string, unknown> = {}, currency = 'USD'): TemplateManifest =>
  ({
    schema: 1,
    name: 'T',
    inputs: {
      type: 'object',
      properties: {
        balance: { type: 'number', minimum: 0, 'x-format': 'currency', ...balance },
        currency: { type: 'string', default: currency },
      },
    },
    bindings: [
      { to: { field: ['storeCard', 'primaryFields', 'balance'] }, value: '{{balance}}' },
      {
        to: { field: ['storeCard', 'primaryFields', 'balance'], prop: 'currencyCode' },
        value: '{{currency}}',
      },
    ],
  }) as unknown as TemplateManifest;
const act = (kind: 'add' | 'take', amount?: ResolvedScanAction['amount']) =>
  ({
    id: kind,
    label: kind,
    kind,
    input: 'balance',
    repeat: 'always',
    minRole: 'desk',
    confirm: false,
    allowAgain: false,
    notify: false,
    allowOnConnected: false,
    ...(amount === undefined ? {} : { amount }),
  }) as ResolvedScanAction;
const pass = (balance: number) => ({
  personalization: { balance },
  status: 'active' as const,
});

describe('money at the scanner', () => {
  it('takes 4.50 from 10.10 and leaves exactly 5.60', () => {
    const fx = valueEffect(act('take', { max: 50 }), manifest(), pass(10.1), { amount: 4.5 });
    expect(fx.after).toBe(5.6);
    expect(appliedAmount(fx)).toBe(4.5);
  });

  it('adds in minor units without drift', () => {
    let balance = 0;
    for (let i = 0; i < 10; i++)
      balance = valueEffect(act('add', { max: 5 }), manifest(), pass(balance), { amount: 0.1 })
        .after as number;
    expect(balance).toBe(1);
  });

  it('refuses a take beyond the balance, to the cent', () => {
    expect(() =>
      valueEffect(act('take', { max: 50 }), manifest(), pass(4.49), { amount: 4.5 }),
    ).toThrow(ScanEffectStop);
    expect(
      valueEffect(act('take', { max: 50 }), manifest(), pass(4.5), { amount: 4.5 }).after,
    ).toBe(0);
  });

  it('holds an add at the input maximum', () => {
    const fx = valueEffect(act('add', { max: 50 }), manifest({ maximum: 100 }), pass(99.9), {
      amount: 0.5,
    });
    expect(fx.after).toBe(100);
  });

  it('accepts two decimals and refuses three', () => {
    const issue = (amount: number) =>
      valueRequestIssue(act('take', { max: 50 }), manifest(), { amount }, { balance: 10 });
    expect(issue(4.5)).toBeNull();
    expect(issue(0.01)).toBeNull();
    expect(issue(4.505)).toEqual({
      code: 'SCAN_AMOUNT_INVALID',
      message: 'Use at most 2 decimals.',
    });
    expect(issue(0)?.code).toBe('SCAN_AMOUNT_INVALID');
    expect(issue(0.001)?.code).toBe('SCAN_AMOUNT_INVALID');
    expect(issue(5000)?.message).toBe('Enter an amount from 0.01 to 1000.');
  });

  it('refuses decimals in a zero-decimal currency', () => {
    const jpy = manifest({}, 'JPY');
    const issue = (amount: number) =>
      valueRequestIssue(act('take', { max: 5000 }), jpy, { amount }, { balance: 900 });
    expect(issue(500)).toBeNull();
    expect(issue(500.5)).toEqual({ code: 'SCAN_AMOUNT_INVALID', message: 'Use a whole amount.' });
  });

  it('keeps the whole-number rule for a plain count', () => {
    const plain = {
      schema: 1,
      name: 'T',
      inputs: { type: 'object', properties: { balance: { type: 'integer' } } },
      bindings: [],
    } as unknown as TemplateManifest;
    expect(valueRequestIssue(act('add', { max: 9 }), plain, { amount: 2.5 })?.code).toBe(
      'SCAN_AMOUNT_INVALID',
    );
    expect(valueRequestIssue(act('add', { max: 9 }), plain, { amount: 2 })).toBeNull();
    const fx = valueEffect(act('add', { max: 9 }), plain, pass(3), { amount: 2 });
    expect(fx.after).toBe(5);
  });

  it('names the currency of the field on the card line', () => {
    expect(currencyField(manifest(), 'balance', { balance: 1 })).toEqual({ currency: 'USD' });
    expect(currencyField(manifest(), 'balance', { balance: 1, currency: 'EUR' })).toEqual({
      currency: 'EUR',
    });
    expect(currencyField(manifest({ 'x-currency': 'GBP' }), 'balance', {})).toEqual({
      currency: 'GBP',
    });
    expect(currencyField(manifest(), 'currency', {})).toEqual({});
  });

  it('still asks a Manager above the maximum, with a decimal', () => {
    const desk = {
      principal: 'scanner',
      role: 'desk',
      terminal: false,
      actorKey: 'k',
      staffId: null,
    } as never;
    const request = (amount: number) =>
      scanPolicy(desk, { kind: 'act', minRole: 'desk', amount, max: 20 });
    expect(request(19.99)).toMatchObject({ allow: true });
    expect(request(20.01)).toMatchObject({ allow: false, why: 'needs_approval' });
  });
});
