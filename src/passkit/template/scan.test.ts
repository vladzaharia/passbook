import { describe, expect, it } from 'vitest';
import type { PassJson, TemplateManifest } from '../types.ts';
import { nfcIssues, scanIssues } from './scan.ts';

const inputs = {
  type: 'object',
  properties: {
    name: { type: 'string' },
    memberId: { type: 'string' },
    cardNumber: { type: 'integer' },
    stamps: { type: 'integer', minimum: 0, maximum: 10, default: 0 },
    balance: { type: 'number', minimum: 0 },
    tier: { type: 'string', enum: ['basic', 'gold'] },
    startsAt: { type: 'string', format: 'date-time' },
    endsAt: { type: 'string', format: 'date-time' },
    lastVisit: { type: 'string', format: 'date-time' },
    visits: { type: 'number' },
    notes: { type: 'object' },
    status: { type: 'string' },
  },
} as const;

const CHECK_IN = { id: 'check_in', label: 'Check in', kind: 'check_in' };
const base = (scan?: unknown, extra: Record<string, unknown> = {}): TemplateManifest =>
  ({
    schema: 1,
    name: 'T',
    inputs,
    sample: {},
    bindings: [{ to: { barcode: 0, prop: 'message' }, value: '{{pass.scanCode}}' }],
    display: { title: '{{name}}' },
    ...(scan === undefined ? {} : { scan }),
    ...extra,
  }) as unknown as TemplateManifest;
const pass = (extra: Record<string, unknown> = {}) =>
  ({ storeCard: { primaryFields: [] }, ...extra }) as unknown as PassJson;

const codes = (m: TemplateManifest) => scanIssues(m).map((i) => `${i.severity}:${i.code}`);
const only = (scan: unknown, extra?: Record<string, unknown>) => codes(base(scan, extra));
const act = (patch: Record<string, unknown>) => ({ actions: [{ ...CHECK_IN, ...patch }] });

describe('scanIssues', () => {
  it('accepts no scan block and a plain check-in', () => {
    expect(only(undefined)).toEqual([]);
    expect(only({ actions: [CHECK_IN] })).toEqual([]);
  });

  it('accepts a full shape with an access block untouched', () => {
    const scan = {
      actions: [
        CHECK_IN,
        {
          id: 'add_stamp',
          label: 'Add stamp',
          kind: 'add',
          input: 'stamps',
          amount: { max: 5, default: 1, presets: [1, 2] },
        },
        {
          id: 'redeem',
          label: 'Redeem',
          kind: 'take',
          input: 'stamps',
          amount: 10,
          rewardLabel: 'Free item',
        },
        { id: 'set_tier', label: 'Set tier', kind: 'set', input: 'tier', value: 'gold' },
        { id: 'use', label: 'Use', kind: 'use_up' },
      ],
      lookup: { input: 'memberId' },
      window: { from: 'startsAt', until: 'endsAt', earlyMinutes: 180, lateMinutes: 60 },
      flags: [{ input: 'status', label: 'Banned', equals: ['banned'], stop: true }],
      access: { input: { plan: 'tier' }, plans: [] },
    };
    expect(only(scan)).toEqual([]);
  });

  it.each([
    ['scan is not an object', 'x'],
    ['an unknown key', { actions: [CHECK_IN], values: [] }],
    ['the removed identity key', { actions: [CHECK_IN], identity: {} }],
    ['actions is not an array', { actions: {} }],
    ['no actions', { actions: [] }],
    ['an action that is not an object', { actions: ['x'] }],
    ['an unknown kind', act({ kind: 'redeem' })],
    ['an unknown action key', act({ extra: 1 })],
    ['a bad repeat', act({ repeat: 'weekly' })],
    ['a bad minRole', act({ minRole: 'owner' })],
    ['a non-boolean confirm', act({ confirm: 'yes' })],
    ['amount on a check-in', act({ amount: 1 })],
    ['value on a check-in', act({ value: 1 })],
  ])('SCAN_SHAPE: %s', (_n, scan) => {
    expect(only(scan)).toContain('error:SCAN_SHAPE');
  });

  it('SCAN_TOO_MANY above 6 actions', () => {
    const actions = Array.from({ length: 7 }, (_, i) => ({
      id: `a${i}`,
      label: `Act ${i}`,
      kind: 'check_in',
    }));
    expect(only({ actions })).toContain('error:SCAN_TOO_MANY');
    expect(only({ actions: actions.slice(0, 6) })).toEqual([]);
  });

  it('SCAN_ID_INVALID and SCAN_ID_DUPLICATE', () => {
    for (const id of ['Check', '1a', 'a-b', '', 'a'.repeat(33)])
      expect(only(act({ id }))).toContain('error:SCAN_ID_INVALID');
    expect(only(act({ id: 'a'.repeat(32) }))).toEqual([]);
    const dup = { actions: [CHECK_IN, { ...CHECK_IN, label: 'Other' }] };
    expect(only(dup)).toContain('error:SCAN_ID_DUPLICATE');
  });

  it('SCAN_LABEL_INVALID and SCAN_LABEL_DUPLICATE', () => {
    for (const label of ['', '   ', 'x'.repeat(25), 5])
      expect(only(act({ label }))).toContain('error:SCAN_LABEL_INVALID');
    expect(only(act({ label: 'x'.repeat(24) }))).toEqual([]);
    const dup = { actions: [CHECK_IN, { id: 'b', label: 'check IN', kind: 'check_in' }] };
    expect(only(dup)).toContain('error:SCAN_LABEL_DUPLICATE');
    expect(
      only({
        actions: [
          { id: 'r', label: 'R', kind: 'take', input: 'stamps', rewardLabel: 'x'.repeat(25) },
        ],
      }),
    ).toContain('error:SCAN_LABEL_INVALID');
  });

  it('SCAN_INPUT_MISSING', () => {
    const add = (patch: Record<string, unknown>) => ({
      actions: [{ id: 'a', label: 'A', kind: 'add', ...patch }],
    });
    expect(only(add({}))).toContain('error:SCAN_INPUT_MISSING');
    expect(only(add({ input: 'nope' }))).toContain('error:SCAN_INPUT_MISSING');
    expect(only(act({ input: 'nope' }))).toContain('error:SCAN_INPUT_MISSING');
    expect(
      only({ actions: [{ id: 's', label: 'S', kind: 'set', input: 'nope', value: 1 }] }),
    ).toContain('error:SCAN_INPUT_MISSING');
    expect(only({ actions: [{ id: 's', label: 'S', kind: 'set' }] })).toContain(
      'error:SCAN_INPUT_MISSING',
    );
    expect(only({ actions: [{ id: 's', label: 'S', kind: 'set', input: 'notes' }] })).toContain(
      'error:SCAN_INPUT_MISSING',
    );
  });

  it('SCAN_INPUT_NOT_NUMBER', () => {
    const add = (input: string) => ({ actions: [{ id: 'a', label: 'A', kind: 'add', input }] });
    expect(only(add('name'))).toContain('error:SCAN_INPUT_NOT_NUMBER');
    expect(only(add('stamps'))).toEqual([]);
    expect(only(add('balance'))).toEqual([]);
    expect(only(act({ input: 'name' }))).toContain('error:SCAN_INPUT_NOT_NUMBER');
    // A check-in records a visit count or a time.
    expect(only(act({ input: 'visits' }))).toEqual([]);
    expect(only(act({ input: 'lastVisit' }))).toEqual([]);
  });

  it('SCAN_AMOUNT_RANGE', () => {
    const add = (amount: unknown, input = 'stamps') => ({
      actions: [{ id: 'a', label: 'A', kind: 'add', input, amount }],
    });
    for (const amount of [
      0,
      -1,
      11,
      1001,
      1.5,
      'x',
      { max: 0 },
      { max: 11 },
      { max: 5, presets: [6] },
      { max: 5, presets: [0] },
      { max: 5, default: 6 },
      { max: 5, default: 0 },
    ])
      expect(only(add(amount))).toContain('error:SCAN_AMOUNT_RANGE');
    for (const amount of [1, 10, { max: 5 }, { max: 5, presets: [1, 5], default: 2 }])
      expect(only(add(amount))).toEqual([]);
    // A number input takes decimals; the platform cap is 1000.
    expect(only(add(2.5, 'balance'))).toEqual([]);
    expect(only(add({ max: 1000 }, 'balance'))).toEqual([]);
    expect(only(add(1001, 'balance'))).toContain('error:SCAN_AMOUNT_RANGE');
    expect(
      only({
        actions: [{ id: 'a', label: 'A', kind: 'take', input: 'balance', confirmAbove: -1 }],
      }),
    ).toContain('error:SCAN_AMOUNT_RANGE');
  });

  it('SCAN_VALUE_INVALID when a set value fails the input schema', () => {
    const set = (value: unknown) => ({
      actions: [{ id: 's', label: 'S', kind: 'set', input: 'tier', value }],
    });
    expect(only(set('platinum'))).toContain('error:SCAN_VALUE_INVALID');
    expect(only(set(3))).toContain('error:SCAN_VALUE_INVALID');
    expect(only(set('gold'))).toEqual([]);
  });

  it('SCAN_WAIT_RANGE', () => {
    for (const cooldownMinutes of [0, 10081, 1.5, 'x'])
      expect(only(act({ repeat: 'cooldown', cooldownMinutes }))).toContain('error:SCAN_WAIT_RANGE');
    expect(only(act({ repeat: 'cooldown', cooldownMinutes: 10080 }))).toEqual([]);
    expect(only({ actions: [CHECK_IN], window: { earlyMinutes: 1441 } })).toContain(
      'error:SCAN_WAIT_RANGE',
    );
    expect(only({ actions: [CHECK_IN], window: { lateMinutes: -1 } })).toContain(
      'error:SCAN_WAIT_RANGE',
    );
  });

  it('SCAN_WINDOW_INPUT', () => {
    for (const w of [{ from: 'name' }, { until: 'nope' }, { from: 5 }])
      expect(only({ actions: [CHECK_IN], window: w })).toContain('error:SCAN_WINDOW_INPUT');
    expect(only({ actions: [CHECK_IN], window: { from: 'startsAt' } })).toEqual([]);
  });

  it('SCAN_LOOKUP_INPUT', () => {
    for (const lookup of [{ input: 'balance' }, { input: 'nope' }, { input: 3 }, 'x'])
      expect(only({ actions: [CHECK_IN], lookup })).toContain('error:SCAN_LOOKUP_INPUT');
    for (const input of ['memberId', 'cardNumber'])
      expect(only({ actions: [CHECK_IN], lookup: { input } })).toEqual([]);
  });

  it('SCAN_FLAGS', () => {
    const flag = { input: 'status', label: 'Banned' };
    const bad = [
      'x',
      [flag, flag, flag, flag, flag],
      [{ ...flag, input: 'nope' }],
      [{ ...flag, label: '' }],
      [{ ...flag, label: 'x'.repeat(25) }],
      [{ ...flag, equals: 'banned' }],
      [{ ...flag, equals: [1] }],
      [{ ...flag, stop: 'yes' }],
      ['x'],
    ];
    for (const flags of bad)
      expect(only({ actions: [CHECK_IN], flags })).toContain('error:SCAN_FLAGS');
  });

  it('SCAN_DISPLAY_TOO_BIG over 16 KB of display', () => {
    const big = { v: 1, header: { title: 'x'.repeat(17 * 1024) } };
    expect(only({ actions: [CHECK_IN], display: big })).toContain('error:SCAN_DISPLAY_TOO_BIG');
    expect(only({ actions: [CHECK_IN], display: { v: 1, header: {} } })).toEqual([]);
  });

  it('SCAN_CODE_NOT_IN_BARCODE for a use_up without {{pass.scanCode}} in the barcode', () => {
    const use = { actions: [{ id: 'use', label: 'Use', kind: 'use_up' }] };
    expect(only(use)).toEqual([]);
    expect(only(use, { bindings: [] })).toContain('warning:SCAN_CODE_NOT_IN_BARCODE');
    expect(
      only(use, { bindings: [{ to: { barcode: 0, prop: 'message' }, value: '{{memberId}}' }] }),
    ).toContain('warning:SCAN_CODE_NOT_IN_BARCODE');
    expect(
      only(use, {
        bindings: [{ to: { barcode: '*', prop: 'message' }, value: '{{pass.scanCode}}' }],
      }),
    ).toEqual([]);
    // A check-in alone never warns.
    expect(only({ actions: [CHECK_IN] }, { bindings: [] })).toEqual([]);
  });

  it('SCAN_NOTIFY_BUDGET for notify on add', () => {
    const add = (notify: boolean) => ({
      actions: [{ id: 'a', label: 'A', kind: 'add', input: 'stamps', notify }],
    });
    expect(only(add(true))).toContain('warning:SCAN_NOTIFY_BUDGET');
    expect(only(add(false))).toEqual([]);
    expect(
      only({ actions: [{ id: 't', label: 'T', kind: 'take', input: 'stamps', notify: true }] }),
    ).toEqual([]);
  });

  it('puts a JSON path on every issue', () => {
    const issues = scanIssues(base({ actions: [CHECK_IN, { ...CHECK_IN }] }));
    expect(issues.find((i) => i.code === 'SCAN_ID_DUPLICATE')?.path).toBe('scan.actions.1.id');
  });
});

describe('nfcIssues', () => {
  const nfc = (value: unknown, p?: PassJson) =>
    nfcIssues({ ...base(), nfc: value } as unknown as TemplateManifest, p).map(
      (i) => `${i.severity}:${i.code}`,
    );

  it('accepts no nfc and a valid block', () => {
    expect(nfcIssues(base(), pass())).toEqual([]);
    expect(nfc({ enabled: true }, pass())).toEqual([]);
    expect(nfc({ enabled: false, requiresAuthentication: true }, pass())).toEqual([]);
  });

  it.each([
    ['not an object', 'x'],
    ['no enabled', {}],
    ['enabled not boolean', { enabled: 'yes' }],
    ['requiresAuthentication not boolean', { enabled: true, requiresAuthentication: 1 }],
    ['an unknown key', { enabled: true, key: 'k' }],
  ])('NFC_SHAPE: %s', (_n, value) => {
    expect(nfc(value, pass())).toContain('error:NFC_SHAPE');
  });

  it('NFC_IN_PASS_JSON when the template pass.json has nfc', () => {
    const withNfc = pass({ nfc: { message: 'x', encryptionPublicKey: 'k' } });
    expect(nfcIssues(base(), withNfc).map((i) => i.code)).toEqual(['NFC_IN_PASS_JSON']);
    expect(nfc({ enabled: true }, withNfc)).toContain('error:NFC_IN_PASS_JSON');
  });

  it('NFC_STYLE unless the style is storeCard or eventTicket', () => {
    expect(nfc({ enabled: true }, pass({ storeCard: {} }))).toEqual([]);
    expect(nfc({ enabled: true }, { eventTicket: {} } as unknown as PassJson)).toEqual([]);
    expect(nfc({ enabled: true }, { coupon: {} } as unknown as PassJson)).toContain(
      'warning:NFC_STYLE',
    );
    expect(nfc({ enabled: false }, { coupon: {} } as unknown as PassJson)).toEqual([]);
  });

  it('NFC_IDENTITY info when the signing identity has no NFC', () => {
    const m = { ...base(), nfc: { enabled: true } } as unknown as TemplateManifest;
    const issue = nfcIssues(m, pass(), { identity: { name: 'Platform', nfc: false } });
    expect(issue.map((i) => `${i.severity}:${i.code}`)).toEqual(['info:NFC_IDENTITY']);
    expect(nfcIssues(m, pass(), { identity: { name: 'Platform', nfc: true } })).toEqual([]);
  });
});
